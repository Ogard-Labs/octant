import { CANVAS_DESIGN_PAGE_PATH } from "@octant/contracts/canvas";
import {
  CHAT_ATTACHMENT_MEDIA_TYPES,
  CODE_ATTACHMENT_MEDIA_TYPES,
  HUB_WAKE_MAX_SPOKES,
  HUB_WAKE_MAX_TIMES_PER_SPOKE,
  MAX_CODE_ATTACHMENT_BYTES,
  MAX_WORK_ATTACHMENT_BYTES,
  OWNER_IDENTITY_KEY_HEADER,
  OWNER_SESSION_HEADER,
  OWNER_UNLOCK_HEADER,
  REMOTE_SERVER_PROXY_RELAYED,
  REMOTE_SERVER_PROXY_RELAYED_HEADER,
  WORK_ATTACHMENT_MEDIA_TYPES,
} from "@octant/contracts";
import { CANVAS_DESIGN_PAGE_POLICY } from "./canvas/canvasDesignPage";
import { HUB_LINK_HEADER, HUB_PEER_KEY_HEADER } from "./hub/hubLink";
import { withAdmissionRelease } from "./remote/remoteAdmissionPolicy";

const DEFAULT_BODY_BYTES = 1_048_576;
const DEFAULT_RESPONSE_BYTES = 8 * 1_024 * 1_024;
const DEFAULT_CONCURRENT_REQUESTS = 32;
/**
 * The proxy surface's own concurrency, counted apart from every other surface,
 * so a dev page's requests cannot take the slots the Octant interface needs,
 * nor the reverse.
 */
const DEFAULT_CONCURRENT_SERVER_PROXY_REQUESTS = 64;
const SERVER_PROXY_PREFIX = "/api/server-proxy/";
/**
 * A request a paired device relays to its dev server may carry an upload this
 * large. The forwarder hashes the body for the request's proof before sending
 * it, so it is bounded rather than streamed.
 */
export const REMOTE_SERVER_PROXY_RELAY_MAX_BODY_BYTES = 8 * 1_024 * 1_024;
/**
 * A proxy request whose cookie names no live proxy session can only be
 * refused, so the listener reads no more of its body than the grants route
 * takes, and holds only a few such requests from one source at once. Without
 * this, unauthenticated uploads could hold the proxy surface's every slot with
 * 8 MiB each before any proof was checked.
 */
const UNAUTHENTICATED_SERVER_PROXY_BODY_BYTES = 4_096;
/**
 * The largest attachment a paired device uploads, in every mode: the Work and
 * Code bound, below Chat's local one. The listener holds the whole body to
 * check its proof before forwarding it, so the bound is the one a phone photo
 * needs rather than the largest file a person at the host may attach.
 */
export const REMOTE_ATTACHMENT_UPLOAD_MAX_BODY_BYTES = Math.min(
  MAX_WORK_ATTACHMENT_BYTES,
  MAX_CODE_ATTACHMENT_BYTES,
);
const UNAUTHENTICATED_SERVER_PROXY_PER_SOURCE = 4;

const REMOTE_REQUEST_HEADERS = [
  "accept",
  "content-type",
  "x-octant-command-id",
  "x-octant-csrf",
  "x-octant-device-proof",
] as const;

const REMOTE_CONTENT_TYPES = [
  "application/json",
  "application/x-ndjson",
  "application/octet-stream",
] as const;

const LOCAL_ONLY_PREFIXES = [
  "/api/desktop",
  "/api/shell",
  "/api/folders",
  "/api/extensions/lifecycle",
  "/api/extensions/skills",
  "/api/extensions/tool-grants",
  "/api/providers/discovery",
  "/api/host-control",
  "/api/replica-store",
  "/api/replica-membership",
  // Reviewing what a thread read and clearing its outside-content mark is a
  // person's act at this machine.
  "/api/thread-external-content",
] as const;

/**
 * A running Canvas design's page. A frame loads it by address, so it can send
 * neither the session proof nor any header of ours; the single-use ticket in
 * its query is the whole authority, issued by the authenticated Canvas route.
 * Its responses keep the page's own sandbox policy in place of the remote
 * default, which would refuse the frame and admit no script.
 */
export const REMOTE_CANVAS_DESIGN_PAGE_ROUTE_ID = "canvas-design-page";

export const REMOTE_PROTOCOL_ROUTE_IDS = {
  hello: "remote-protocol-hello",
  pairing: "remote-protocol-pairing",
  pairingStatus: "remote-protocol-pairing-status",
  negotiate: "remote-protocol-negotiate",
} as const;

/**
 * The most a wake copy carries, from the schema's bounds: every spoke at the
 * per-spoke maximum of times. One encoded time is 117 bytes (a 64-character id and
 * a timestamp) and one spoke's own fields come to about 130; the budget rounds both
 * up. Four full spokes already overran the 64 KiB these routes started with, and the
 * gateway answered 413 to a body the hub could not shrink.
 */
export const HUB_WAKE_COPY_MAX_BODY_BYTES =
  HUB_WAKE_MAX_SPOKES * (HUB_WAKE_MAX_TIMES_PER_SPOKE * 128 + 256) + 4_096;
/** A hand-back adds up to 64 members the standby made (a few KiB each) and the ids it removed. */
export const HUB_HANDBACK_MAX_BODY_BYTES = HUB_WAKE_COPY_MAX_BODY_BYTES + 1_048_576;

export const REMOTE_HUB_LINK_ROUTE_IDS = {
  join: "hub-link-join",
  leave: "hub-link-leave",
  roster: "hub-link-roster",
  status: "hub-link-status",
  guestRoster: "hub-link-guest-roster",
  guest: "hub-link-guest",
  standby: "hub-link-standby",
  heartbeat: "hub-link-heartbeat",
  handback: "hub-link-handback",
  wakeTimes: "hub-link-wake-times",
  wakeNudge: "hub-link-wake-nudge",
  wakeCopy: "hub-link-wake-copy",
  push: "hub-link-push",
  pushGrant: "hub-link-push-grant",
  pushCopy: "hub-link-push-copy",
  provisionOffer: "hub-link-provision-offer",
  provisionMirror: "hub-link-provision-mirror",
  signInRequest: "hub-link-sign-in-request",
  signInOutcome: "hub-link-sign-in-outcome",
  owner: "hub-link-owner",
  delegate: "hub-link-delegate",
  delegationStatus: "hub-link-delegation-status",
  delegationCancel: "hub-link-delegation-cancel",
  credentialTransfer: "hub-link-credential-transfer",
} as const;

const DEFAULT_PRE_AUTH_ROUTES: readonly RemoteRouteDefinition[] = [
  {
    id: REMOTE_CANVAS_DESIGN_PAGE_ROUTE_ID,
    match: { kind: "exact", path: CANVAS_DESIGN_PAGE_PATH },
    surface: "pre-auth",
    methods: ["GET"],
    allowQuery: true,
    allowedRequestHeaders: [],
    responsePolicy: CANVAS_DESIGN_PAGE_POLICY,
  },
  {
    id: "health",
    match: { kind: "exact", path: "/health" },
    surface: "pre-auth",
    methods: ["GET", "HEAD"],
    allowQuery: false,
    allowedRequestHeaders: [],
  },
  {
    id: "hosts",
    match: { kind: "exact", path: "/api/hosts" },
    surface: "pre-auth",
    methods: ["GET", "HEAD"],
    allowQuery: false,
    allowedRequestHeaders: [],
  },
  {
    id: REMOTE_PROTOCOL_ROUTE_IDS.hello,
    match: { kind: "exact", path: "/api/remote/hello" },
    surface: "pre-auth",
    methods: ["GET", "HEAD"],
    // Only the client's hello nonce; the gateway refuses any other query.
    allowQuery: true,
    allowedRequestHeaders: [],
    maxResponseBytes: 4_096,
  },
  {
    id: REMOTE_PROTOCOL_ROUTE_IDS.pairing,
    match: { kind: "exact", path: "/api/remote/pairing" },
    surface: "pre-auth",
    methods: ["POST"],
    allowQuery: false,
    allowedRequestHeaders: ["content-type"],
    allowedContentTypes: ["application/json"],
    maxBodyBytes: 8_192,
    maxResponseBytes: 4_096,
  },
  {
    id: REMOTE_PROTOCOL_ROUTE_IDS.pairingStatus,
    match: { kind: "exact", path: "/api/remote/pairing/status" },
    surface: "pre-auth",
    methods: ["POST"],
    allowQuery: false,
    allowedRequestHeaders: ["content-type"],
    allowedContentTypes: ["application/json"],
    maxBodyBytes: 4_096,
    maxResponseBytes: 4_096,
  },
  {
    id: REMOTE_PROTOCOL_ROUTE_IDS.negotiate,
    match: { kind: "exact", path: "/api/remote/negotiate" },
    surface: "pre-auth",
    methods: ["POST"],
    allowQuery: false,
    allowedRequestHeaders: ["content-type"],
    allowedContentTypes: ["application/json"],
    maxBodyBytes: 8_192,
    maxResponseBytes: 8_192,
  },
  {
    id: "remote-auth-challenge",
    match: { kind: "exact", path: "/api/remote/auth/challenge" },
    surface: "pre-auth",
    methods: ["POST"],
    allowQuery: false,
    allowedRequestHeaders: ["content-type"],
    allowedContentTypes: ["application/json"],
    maxBodyBytes: 4_096,
    maxResponseBytes: 4_096,
  },
  {
    id: "remote-auth-session",
    match: { kind: "exact", path: "/api/remote/auth/session" },
    surface: "pre-auth",
    methods: ["POST"],
    allowQuery: false,
    allowedRequestHeaders: ["content-type"],
    allowedContentTypes: ["application/json"],
    maxBodyBytes: 8_192,
    maxResponseBytes: 8_192,
  },
  {
    id: "remote-auth-server-proxy-session",
    match: { kind: "exact", path: "/api/remote/auth/server-proxy-session" },
    surface: "pre-auth",
    methods: ["POST"],
    allowQuery: false,
    allowedRequestHeaders: ["content-type"],
    allowedContentTypes: ["application/json"],
    maxBodyBytes: 8_192,
    maxResponseBytes: 8_192,
  },
  // Member-to-member requests of a hub and its spokes. They carry no paired
  // device's session: each is signed with the sender's identity key, and the
  // handler answers only a sender it already trusts, within what the receiving
  // host's hub role or hub grant allows.
  {
    id: REMOTE_HUB_LINK_ROUTE_IDS.join,
    match: { kind: "exact", path: "/api/hub/join" },
    surface: "pre-auth",
    methods: ["POST"],
    allowQuery: false,
    allowedRequestHeaders: ["content-type", HUB_LINK_HEADER],
    allowedContentTypes: ["application/json"],
    maxBodyBytes: 16_384,
    // A join a standing-in standby answers carries two signed rosters.
    maxResponseBytes: 131_072,
  },
  {
    id: REMOTE_HUB_LINK_ROUTE_IDS.leave,
    match: { kind: "exact", path: "/api/hub/leave" },
    surface: "pre-auth",
    methods: ["POST"],
    allowQuery: false,
    allowedRequestHeaders: ["content-type", HUB_LINK_HEADER, HUB_PEER_KEY_HEADER],
    allowedContentTypes: ["application/json"],
    maxBodyBytes: 4_096,
    maxResponseBytes: 4_096,
  },
  {
    id: REMOTE_HUB_LINK_ROUTE_IDS.roster,
    match: { kind: "exact", path: "/api/hub/roster" },
    surface: "pre-auth",
    methods: ["PUT"],
    allowQuery: false,
    // A standby that is standing in presents its identity key beside its signature.
    allowedRequestHeaders: ["content-type", HUB_LINK_HEADER, HUB_PEER_KEY_HEADER],
    allowedContentTypes: ["application/json"],
    maxBodyBytes: 65_536,
    maxResponseBytes: 4_096,
  },
  {
    id: REMOTE_HUB_LINK_ROUTE_IDS.standby,
    match: { kind: "exact", path: "/api/hub/standby" },
    surface: "pre-auth",
    methods: ["PUT"],
    allowQuery: false,
    allowedRequestHeaders: ["content-type", HUB_LINK_HEADER],
    allowedContentTypes: ["application/json"],
    maxBodyBytes: 4_096,
    maxResponseBytes: 4_096,
  },
  {
    id: REMOTE_HUB_LINK_ROUTE_IDS.heartbeat,
    match: { kind: "exact", path: "/api/hub/heartbeat" },
    surface: "pre-auth",
    methods: ["GET"],
    allowQuery: false,
    allowedRequestHeaders: [HUB_LINK_HEADER, HUB_PEER_KEY_HEADER],
    maxResponseBytes: 131_072,
  },
  {
    id: REMOTE_HUB_LINK_ROUTE_IDS.handback,
    match: { kind: "exact", path: "/api/hub/handback" },
    surface: "pre-auth",
    methods: ["POST"],
    allowQuery: false,
    allowedRequestHeaders: ["content-type", HUB_LINK_HEADER, HUB_PEER_KEY_HEADER],
    allowedContentTypes: ["application/json"],
    maxBodyBytes: HUB_HANDBACK_MAX_BODY_BYTES,
    maxResponseBytes: 65_536,
  },
  // The wake service: a spoke's routine times (opaque ids and times only), the
  // hub's nudge before one is due, and the copy a standby holds.
  {
    id: REMOTE_HUB_LINK_ROUTE_IDS.wakeTimes,
    match: { kind: "exact", path: "/api/hub/wake-times" },
    surface: "pre-auth",
    methods: ["POST"],
    allowQuery: false,
    allowedRequestHeaders: ["content-type", HUB_LINK_HEADER, HUB_PEER_KEY_HEADER],
    allowedContentTypes: ["application/json"],
    maxBodyBytes: 32_768,
    maxResponseBytes: 4_096,
  },
  {
    id: REMOTE_HUB_LINK_ROUTE_IDS.wakeNudge,
    match: { kind: "exact", path: "/api/hub/wake-nudge" },
    surface: "pre-auth",
    methods: ["POST"],
    allowQuery: false,
    allowedRequestHeaders: ["content-type", HUB_LINK_HEADER, HUB_PEER_KEY_HEADER],
    allowedContentTypes: ["application/json"],
    maxBodyBytes: 4_096,
    maxResponseBytes: 4_096,
  },
  {
    id: REMOTE_HUB_LINK_ROUTE_IDS.wakeCopy,
    match: { kind: "exact", path: "/api/hub/wake-copy" },
    surface: "pre-auth",
    methods: ["PUT"],
    allowQuery: false,
    allowedRequestHeaders: ["content-type", HUB_LINK_HEADER],
    allowedContentTypes: ["application/json"],
    maxBodyBytes: HUB_WAKE_COPY_MAX_BODY_BYTES,
    maxResponseBytes: 4_096,
  },
  // Push through the hub: a spoke's sealed delivery request for the hub to forward
  // (a capability and one sealed envelope, never readable here), the hub's question
  // whether the spoke's grant ticks Push, and the switch a standby holds.
  {
    id: REMOTE_HUB_LINK_ROUTE_IDS.push,
    match: { kind: "exact", path: "/api/hub/push" },
    surface: "pre-auth",
    methods: ["POST"],
    allowQuery: false,
    allowedRequestHeaders: ["content-type", HUB_LINK_HEADER, HUB_PEER_KEY_HEADER],
    allowedContentTypes: ["application/json"],
    maxBodyBytes: 32_768,
    maxResponseBytes: 4_096,
  },
  {
    id: REMOTE_HUB_LINK_ROUTE_IDS.pushGrant,
    match: { kind: "exact", path: "/api/hub/push-grant" },
    surface: "pre-auth",
    methods: ["POST"],
    allowQuery: false,
    allowedRequestHeaders: ["content-type", HUB_LINK_HEADER, HUB_PEER_KEY_HEADER],
    allowedContentTypes: ["application/json"],
    maxBodyBytes: 1_024,
    maxResponseBytes: 4_096,
  },
  {
    id: REMOTE_HUB_LINK_ROUTE_IDS.pushCopy,
    match: { kind: "exact", path: "/api/hub/push-copy" },
    surface: "pre-auth",
    methods: ["PUT"],
    allowQuery: false,
    allowedRequestHeaders: ["content-type", HUB_LINK_HEADER],
    allowedContentTypes: ["application/json"],
    maxBodyBytes: 1_024,
    maxResponseBytes: 4_096,
  },
  // Provisioning: the hub's offer to a spoke (configuration, never a secret) and a
  // spoke's request for the signed update feed document an offer mirrors.
  {
    id: REMOTE_HUB_LINK_ROUTE_IDS.provisionOffer,
    match: { kind: "exact", path: "/api/hub/provision-offer" },
    surface: "pre-auth",
    methods: ["POST"],
    allowQuery: false,
    allowedRequestHeaders: ["content-type", HUB_LINK_HEADER],
    allowedContentTypes: ["application/json"],
    maxBodyBytes: 65_536,
    maxResponseBytes: 4_096,
  },
  // Hub-started sign-in: the hub's question to a spoke (a kind and a request id, never a
  // credential) and a spoke's one-word answer about how it ended.
  {
    id: REMOTE_HUB_LINK_ROUTE_IDS.signInRequest,
    match: { kind: "exact", path: "/api/hub/sign-in-request" },
    surface: "pre-auth",
    methods: ["POST"],
    allowQuery: false,
    allowedRequestHeaders: ["content-type", HUB_LINK_HEADER],
    allowedContentTypes: ["application/json"],
    maxBodyBytes: 1_024,
    maxResponseBytes: 1_024,
  },
  {
    id: REMOTE_HUB_LINK_ROUTE_IDS.signInOutcome,
    match: { kind: "exact", path: "/api/hub/sign-in-outcome" },
    surface: "pre-auth",
    methods: ["POST"],
    allowQuery: false,
    allowedRequestHeaders: ["content-type", HUB_LINK_HEADER, HUB_PEER_KEY_HEADER],
    allowedContentTypes: ["application/json"],
    maxBodyBytes: 1_024,
    maxResponseBytes: 1_024,
  },
  {
    id: REMOTE_HUB_LINK_ROUTE_IDS.provisionMirror,
    match: { kind: "exact", path: "/api/hub/provision-mirror" },
    surface: "pre-auth",
    methods: ["POST"],
    allowQuery: false,
    allowedRequestHeaders: ["content-type", HUB_LINK_HEADER, HUB_PEER_KEY_HEADER],
    allowedContentTypes: ["application/json"],
    maxBodyBytes: 1_024,
    maxResponseBytes: 16_384,
  },
  {
    id: REMOTE_HUB_LINK_ROUTE_IDS.status,
    match: { kind: "exact", path: "/api/hub/status" },
    surface: "pre-auth",
    methods: ["GET"],
    allowQuery: false,
    allowedRequestHeaders: [HUB_LINK_HEADER],
    maxResponseBytes: 4_096,
  },
  {
    id: REMOTE_HUB_LINK_ROUTE_IDS.guestRoster,
    match: { kind: "exact", path: "/api/hub/guest-roster" },
    surface: "pre-auth",
    methods: ["GET"],
    allowQuery: false,
    allowedRequestHeaders: [HUB_LINK_HEADER],
    maxResponseBytes: 65_536,
  },
  {
    id: REMOTE_HUB_LINK_ROUTE_IDS.guest,
    match: { kind: "exact", path: "/api/hub/guest" },
    surface: "pre-auth",
    methods: ["POST"],
    allowQuery: false,
    allowedRequestHeaders: ["content-type", HUB_LINK_HEADER],
    allowedContentTypes: ["application/json"],
    maxBodyBytes: 4_096,
    maxResponseBytes: 4_096,
  },
  // A member's delegation of work to this spoke: start a remote child run,
  // read its state, cancel it. Signed like the routes above, with the sender's
  // public key beside the signature, and held to the peer grant this spoke gave
  // that member.
  {
    id: REMOTE_HUB_LINK_ROUTE_IDS.delegate,
    match: { kind: "exact", path: "/api/hub/peer/delegations" },
    surface: "pre-auth",
    methods: ["POST"],
    allowQuery: false,
    allowedRequestHeaders: ["content-type", HUB_LINK_HEADER, HUB_PEER_KEY_HEADER],
    allowedContentTypes: ["application/json"],
    maxBodyBytes: 65_536,
    maxResponseBytes: 4_096,
  },
  {
    id: REMOTE_HUB_LINK_ROUTE_IDS.delegationStatus,
    match: { kind: "exact", path: "/api/hub/peer/delegations/status" },
    surface: "pre-auth",
    methods: ["POST"],
    allowQuery: false,
    allowedRequestHeaders: ["content-type", HUB_LINK_HEADER, HUB_PEER_KEY_HEADER],
    allowedContentTypes: ["application/json"],
    maxBodyBytes: 4_096,
    maxResponseBytes: 131_072,
  },
  {
    id: REMOTE_HUB_LINK_ROUTE_IDS.delegationCancel,
    match: { kind: "exact", path: "/api/hub/peer/delegations/cancel" },
    surface: "pre-auth",
    methods: ["POST"],
    allowQuery: false,
    allowedRequestHeaders: ["content-type", HUB_LINK_HEADER, HUB_PEER_KEY_HEADER],
    allowedContentTypes: ["application/json"],
    maxBodyBytes: 4_096,
    maxResponseBytes: 4_096,
  },
  // The sending host's half of a sign-in copy an owner device started: the key
  // arrives only against a one-time ticket the owner made on this host.
  {
    id: REMOTE_HUB_LINK_ROUTE_IDS.credentialTransfer,
    match: { kind: "exact", path: "/api/hub/peer/credentials" },
    surface: "pre-auth",
    methods: ["POST"],
    allowQuery: false,
    allowedRequestHeaders: ["content-type", HUB_LINK_HEADER, HUB_PEER_KEY_HEADER],
    allowedContentTypes: ["application/json"],
    maxBodyBytes: 16_384,
    maxResponseBytes: 4_096,
  },
  // An owner device's administration of a host, signed like the routes above
  // and checked against the host's own owner list and a fresh unlock.
  {
    id: REMOTE_HUB_LINK_ROUTE_IDS.owner,
    match: { kind: "prefix", path: "/api/hub/owner" },
    surface: "pre-auth",
    methods: ["GET", "POST"],
    allowQuery: false,
    allowedRequestHeaders: [
      "content-type",
      HUB_LINK_HEADER,
      OWNER_UNLOCK_HEADER,
      OWNER_SESSION_HEADER,
      OWNER_IDENTITY_KEY_HEADER,
    ],
    allowedContentTypes: ["application/json"],
    maxBodyBytes: 16_384,
    maxResponseBytes: 32_768,
  },
];

/**
 * Routes only a proxy session reaches. They are their own surface, never
 * product routes: the product forward list, the product action classifier, and
 * product dispatch never see them, and a product session cannot authenticate
 * here.
 */
const DEFAULT_SERVER_PROXY_ROUTES: readonly RemoteRouteDefinition[] = [
  {
    id: "server-proxy-grants",
    match: { kind: "exact", path: "/api/server-proxy/grants" },
    surface: "server-proxy",
    methods: ["POST"],
    allowQuery: false,
    allowedRequestHeaders: REMOTE_REQUEST_HEADERS,
    allowedContentTypes: ["application/json"],
    maxBodyBytes: 4_096,
    maxResponseBytes: 4_096,
  },
  {
    // `/api/server-proxy/<grant id>/<the dev server's path>`. Matched after the
    // grants route, so that exact path never reaches a dev server.
    id: "server-proxy-relay",
    match: { kind: "prefix", path: SERVER_PROXY_PREFIX },
    surface: "server-proxy",
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    allowQuery: true,
    allowedRequestHeaders: REMOTE_REQUEST_HEADERS,
    maxBodyBytes: REMOTE_SERVER_PROXY_RELAY_MAX_BODY_BYTES,
    relaysDevServer: true,
  },
];

const DEFAULT_AUTHENTICATED_SERVICE_ROUTES: readonly RemoteRouteDefinition[] = [
  {
    id: "remote-auth-device",
    match: { kind: "exact", path: "/api/remote/auth/device" },
    surface: "authenticated-product",
    methods: ["GET", "HEAD"],
    allowQuery: false,
    allowedRequestHeaders: REMOTE_REQUEST_HEADERS,
    maxResponseBytes: 4_096,
  },
  {
    id: "remote-auth-sign-out",
    match: { kind: "exact", path: "/api/remote/auth/sign-out" },
    surface: "authenticated-product",
    methods: ["POST"],
    allowQuery: false,
    allowedRequestHeaders: REMOTE_REQUEST_HEADERS,
    allowedContentTypes: ["application/json"],
    maxBodyBytes: 4_096,
    maxResponseBytes: 4_096,
  },
  {
    id: "remote-auth-rotate-key",
    match: { kind: "exact", path: "/api/remote/auth/rotate-key" },
    surface: "authenticated-product",
    methods: ["POST"],
    allowQuery: false,
    allowedRequestHeaders: REMOTE_REQUEST_HEADERS,
    allowedContentTypes: ["application/json"],
    maxBodyBytes: 8_192,
    maxResponseBytes: 4_096,
  },
  {
    id: "remote-auth-revoke-self",
    match: { kind: "exact", path: "/api/remote/auth/revoke-self" },
    surface: "authenticated-product",
    methods: ["POST"],
    allowQuery: false,
    allowedRequestHeaders: REMOTE_REQUEST_HEADERS,
    allowedContentTypes: ["application/json"],
    maxBodyBytes: 4_096,
    maxResponseBytes: 4_096,
  },
  {
    id: "remote-auth-push-token",
    match: { kind: "exact", path: "/api/remote/auth/push-token" },
    surface: "authenticated-product",
    methods: ["PUT", "DELETE"],
    allowQuery: false,
    allowedRequestHeaders: REMOTE_REQUEST_HEADERS,
    allowedContentTypes: ["application/json"],
    maxBodyBytes: 8_192,
    maxResponseBytes: 4_096,
  },
  // Dictation from a paired device: its voice status and its clip, as the same
  // multipart upload the desktop sends. Read-aloud (`/api/speech/synthesis`)
  // is not listed, so the listener never forwards it.
  {
    id: "speech-status",
    match: { kind: "exact", path: "/api/speech/status" },
    surface: "authenticated-product",
    methods: ["GET"],
    allowQuery: false,
    allowedRequestHeaders: REMOTE_REQUEST_HEADERS,
    maxResponseBytes: 4_096,
  },
  {
    id: "speech-transcriptions",
    match: { kind: "exact", path: "/api/speech/transcriptions" },
    surface: "authenticated-product",
    methods: ["POST"],
    allowQuery: false,
    allowedRequestHeaders: REMOTE_REQUEST_HEADERS,
    allowedContentTypes: ["multipart/form-data"],
    maxBodyBytes: DEFAULT_BODY_BYTES,
  },
];

const DEFAULT_AUTHENTICATED_ROUTE_MATCHES = [
  {
    kind: "exact" as const,
    path: "/api/github/authentication",
    methods: ["GET", "HEAD"] as const,
    allowedRequestHeaders: REMOTE_REQUEST_HEADERS,
    maxResponseBytes: 4_096,
  },
  {
    kind: "exact" as const,
    path: "/api/github/authentication/commands",
    methods: ["POST"] as const,
    allowedRequestHeaders: REMOTE_REQUEST_HEADERS,
    allowedContentTypes: ["application/json"] as const,
    maxBodyBytes: 16 * 1_024,
    maxResponseBytes: 4_096,
  },
  {
    kind: "exact" as const,
    path: "/api/integrations/linear/authentication",
    methods: ["GET", "HEAD"] as const,
    allowedRequestHeaders: REMOTE_REQUEST_HEADERS,
    maxResponseBytes: 4_096,
  },
  {
    kind: "exact" as const,
    path: "/api/integrations/linear/authentication/commands",
    methods: ["POST"] as const,
    allowedRequestHeaders: REMOTE_REQUEST_HEADERS,
    allowedContentTypes: ["application/json"] as const,
    maxBodyBytes: 16 * 1_024,
    maxResponseBytes: 4_096,
  },
  {
    kind: "exact" as const,
    path: "/api/integrations/linear/operations",
    methods: ["POST"] as const,
    allowedRequestHeaders: REMOTE_REQUEST_HEADERS,
    allowedContentTypes: ["application/json"] as const,
    maxBodyBytes: 16 * 1_024,
    maxResponseBytes: 96 * 1_024,
  },
  {
    // A paired device lists and answers the MCP tool prompts its own turns
    // raised, approve once or deny. Remembered approvals stay on the
    // local-only tool-grants route, and the approval service refuses a paired
    // device's answer that asks to be remembered.
    kind: "exact" as const,
    path: "/api/extensions/tool-approvals",
    methods: ["POST"] as const,
    allowedRequestHeaders: REMOTE_REQUEST_HEADERS,
    allowedContentTypes: ["application/json"] as const,
    maxBodyBytes: 4_096,
  },
  // Each mode's own attachment route, under that thread's authority, for the
  // media types that mode takes. Matched before the mode's prefix, which keeps
  // JSON bodies within the listener's default budget.
  ...(
    [
      ["/api/chat/attachments", "POST", "chat", CHAT_ATTACHMENT_MEDIA_TYPES],
      ["/api/work/attachments", "PUT", "work", WORK_ATTACHMENT_MEDIA_TYPES],
      ["/api/code/attachments", "PUT", "code", CODE_ATTACHMENT_MEDIA_TYPES],
    ] as const
  ).map(([path, method, mode, mediaTypes]) => ({
    kind: "exact" as const,
    path,
    methods: [method],
    allowedRequestHeaders: [
      ...REMOTE_REQUEST_HEADERS,
      `x-octant-${mode}-thread-id`,
      `x-octant-${mode}-attachment-id`,
      `x-octant-${mode}-display-name`,
    ],
    allowedContentTypes: mediaTypes,
    maxBodyBytes: REMOTE_ATTACHMENT_UPLOAD_MAX_BODY_BYTES,
    uploadsAttachment: true as const,
  })),
  {
    kind: "exact" as const,
    path: "/api/providers/bootstrap",
    methods: ["GET", "HEAD"] as const,
  },
  {
    kind: "exact" as const,
    path: "/api/code/evidence",
    methods: ["PUT"] as const,
    allowedRequestHeaders: [...REMOTE_REQUEST_HEADERS, "x-octant-code-thread-id"] as const,
    allowedContentTypes: ["text/plain"] as const,
    maxBodyBytes: 64 * 1_024,
  },
  {
    kind: "exact" as const,
    path: "/api/usage/dashboard",
    methods: ["POST"] as const,
  },
  {
    kind: "exact" as const,
    path: "/api/usage/query",
    methods: ["POST"] as const,
  },
  {
    kind: "exact" as const,
    path: "/api/usage/export",
    methods: ["POST"] as const,
  },
  {
    kind: "exact" as const,
    path: "/api/host/resources",
    methods: ["GET"] as const,
    allowedRequestHeaders: REMOTE_REQUEST_HEADERS,
    maxResponseBytes: 4_096,
  },
  {
    kind: "exact" as const,
    path: "/api/replica-sync/status",
    methods: ["GET"] as const,
    allowedRequestHeaders: REMOTE_REQUEST_HEADERS,
  },
  ...[
    "/api/agent-profiles",
    "/api/apple/",
    "/api/automations/",
    "/api/browser/",
    "/api/chat/",
    "/api/code/",
    "/api/computer-use/",
    "/api/context/",
    "/api/machine/",
    "/api/work/",
    "/api/extensions/catalog",
    "/api/extensions/inspect",
    "/api/extensions/preview",
    "/api/extensions/snapshot",
    "/api/extensions/state",
    "/api/preview/",
    "/api/canvas/",
    "/api/projects/",
    "/api/spend-ceilings",
    "/api/theme/",
    "/api/validation/",
    "/api/zen",
  ].map((path) => ({
    kind: "prefix" as const,
    path,
    methods: ["GET", "HEAD", "POST"] as const,
  })),
].map((match) => {
  return {
    id: `product-${match.path.slice(5).replaceAll("/", "-") || "root"}`,
    match: { kind: match.kind, path: match.path },
    surface: "authenticated-product" as const,
    methods: match.methods,
    allowedRequestHeaders:
      "allowedRequestHeaders" in match ? match.allowedRequestHeaders : REMOTE_REQUEST_HEADERS,
    allowedContentTypes:
      "allowedContentTypes" in match ? match.allowedContentTypes : REMOTE_CONTENT_TYPES,
    ...("maxBodyBytes" in match ? { maxBodyBytes: match.maxBodyBytes } : {}),
    ...("uploadsAttachment" in match ? { uploadsAttachment: match.uploadsAttachment } : {}),
    allowQuery: match.kind === "prefix",
  };
});

const DEFAULT_AUTHENTICATED_ROUTES: readonly RemoteRouteDefinition[] = [
  ...DEFAULT_AUTHENTICATED_SERVICE_ROUTES,
  ...DEFAULT_AUTHENTICATED_ROUTE_MATCHES,
];

/** The product and remote-auth routes the private listener forwards by default. */
export function listDefaultRemoteAuthenticatedRoutes(): readonly RemoteRouteDefinition[] {
  return DEFAULT_AUTHENTICATED_ROUTES;
}

type RemoteHttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
type RemoteRouteSurface = "pre-auth" | "authenticated-product" | "server-proxy";
type RemoteRouteMatch =
  | { readonly kind: "exact"; readonly path: string }
  | { readonly kind: "prefix"; readonly path: string };

export interface RemoteRouteDefinition {
  readonly id: string;
  readonly match: RemoteRouteMatch;
  readonly surface: RemoteRouteSurface;
  readonly methods: readonly RemoteHttpMethod[];
  readonly allowedRequestHeaders?: readonly string[];
  readonly allowedContentTypes?: readonly string[];
  readonly allowQuery?: boolean;
  readonly maxBodyBytes?: number;
  readonly maxResponseBytes?: number;
  /** The Content-Security-Policy this route's responses carry instead of the default. */
  readonly responsePolicy?: string;
  /**
   * Set only on the proxy route that relays a paired device's request to its
   * dev server. The route's body budget is its own, above the listener's
   * default; any media type passes, since the dev server decides what it
   * accepts; and a response the relay marks as the dev server's own passes
   * with its headers unchanged and no size cap (the relay bounds it by idle
   * time). The host's own answers on the route keep the listener's headers
   * and budget.
   */
  readonly relaysDevServer?: true;
  /**
   * Set only on a mode's attachment upload route. Its body budget is its own,
   * above the listener's default, so a phone photo fits; its media types are
   * still the route's own.
   */
  readonly uploadsAttachment?: true;
}

export type RemoteRouteResponse = Response | undefined;

export interface RedactedRemoteRequestFacts {
  readonly method: string;
  readonly surface: "web-assets" | RemoteRouteSurface | "local-only" | "unknown";
  readonly authority: "matched" | "mismatched";
  readonly origin: "absent" | "matched" | "mismatched";
  readonly forwardedHeaders: boolean;
}

export type RemoteRouteDecision =
  | {
      readonly kind: "allow";
      readonly surface: "web-assets" | RemoteRouteSurface;
      readonly route?: RemoteRouteDefinition;
      readonly headers: Headers;
      readonly maxBodyBytes: number;
      readonly maxResponseBytes: number;
      readonly facts: RedactedRemoteRequestFacts;
    }
  | {
      readonly kind: "preflight";
      readonly headers: Headers;
      readonly facts: RedactedRemoteRequestFacts;
    }
  | {
      readonly kind: "reject";
      readonly response: Response;
      readonly facts: RedactedRemoteRequestFacts;
    };

export interface RemoteRoutePolicyOptions {
  readonly origin: string;
  readonly preAuthRoutes?: readonly RemoteRouteDefinition[];
  readonly authenticatedRoutes?: readonly RemoteRouteDefinition[];
  readonly serverProxyRoutes?: readonly RemoteRouteDefinition[];
  readonly maxBodyBytes?: number;
  readonly maxResponseBytes?: number;
  readonly maxConcurrentRequests?: number;
  readonly maxConcurrentServerProxyRequests?: number;
}

export interface RemoteRoutePolicy {
  readonly inspect: (request: Request) => RemoteRouteDecision;
  /** A concurrency slot on the proxy surface's budget, or on everything else's. */
  readonly acquire: (surface?: "web-assets" | RemoteRouteSurface) => (() => void) | undefined;
  readonly maxBodyBytes: number;
  readonly maxResponseBytes: number;
}

export interface RemoteRouteHandlerOptions {
  readonly policy: RemoteRoutePolicy;
  readonly webAssets: (request: Request) => RemoteRouteResponse | Promise<RemoteRouteResponse>;
  readonly preAuth: (
    request: Request,
    route: RemoteRouteDefinition,
    facts?: RemoteRouteFacts,
  ) => RemoteRouteResponse | Promise<RemoteRouteResponse>;
  readonly authenticatedProduct: (
    request: Request,
    route: RemoteRouteDefinition,
    facts?: RemoteRouteFacts,
  ) => RemoteRouteResponse | Promise<RemoteRouteResponse>;
  /** Absent, every proxy route answers not found. */
  readonly serverProxy?: (
    request: Request,
    route: RemoteRouteDefinition,
    facts?: RemoteRouteFacts,
  ) => RemoteRouteResponse | Promise<RemoteRouteResponse>;
  /**
   * Whether a proxy request's cookie names a live proxy session whose device
   * still stands, asked before its body is read. Absent, none does.
   */
  readonly hasServerProxySession?: (request: Request) => boolean;
}

/**
 * Transport facts passed through to route handlers by the facts-aware route
 * handler. The gateway derives these from the accepted socket so protocol and
 * authentication handlers receive the trusted source class without reading
 * headers.
 */
export interface RemoteRouteFacts {
  readonly sourceClass: "loopback" | "lan-private" | "tailscale" | "unknown";
  readonly sourceKey: string;
}

export const REMOTE_SECURITY_POLICY = {
  hsts: "max-age=31536000; includeSubDomains",
  csp: "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'",
  nosniff: "nosniff",
  referrer: "no-referrer",
} as const;

export function createRemoteRoutePolicy(options: RemoteRoutePolicyOptions): RemoteRoutePolicy {
  const parsedOrigin = parseRemoteOrigin(options.origin);
  const preAuthRoutes = validateRoutes(
    options.preAuthRoutes ?? DEFAULT_PRE_AUTH_ROUTES,
    "pre-auth",
  );
  const authenticatedRoutes = validateRoutes(
    options.authenticatedRoutes ?? DEFAULT_AUTHENTICATED_ROUTES,
    "authenticated-product",
  );
  const serverProxyRoutes = validateRoutes(
    options.serverProxyRoutes ?? DEFAULT_SERVER_PROXY_ROUTES,
    "server-proxy",
  );
  const routes = [...preAuthRoutes, ...authenticatedRoutes, ...serverProxyRoutes];
  const maxBodyBytes = boundedPositiveInteger(
    options.maxBodyBytes ?? DEFAULT_BODY_BYTES,
    "remote request body budget",
  );
  const maxResponseBytes = boundedPositiveInteger(
    options.maxResponseBytes ?? DEFAULT_RESPONSE_BYTES,
    "remote response stream budget",
  );
  const maxConcurrentRequests = boundedPositiveInteger(
    options.maxConcurrentRequests ?? DEFAULT_CONCURRENT_REQUESTS,
    "remote concurrency budget",
  );
  const maxConcurrentServerProxyRequests = boundedPositiveInteger(
    options.maxConcurrentServerProxyRequests ?? DEFAULT_CONCURRENT_SERVER_PROXY_REQUESTS,
    "remote proxy concurrency budget",
  );
  const active = { other: 0, "server-proxy": 0 };

  return {
    maxBodyBytes,
    maxResponseBytes,
    acquire: (surface) => {
      const budget = surface === "server-proxy" ? "server-proxy" : "other";
      const limit =
        budget === "server-proxy" ? maxConcurrentServerProxyRequests : maxConcurrentRequests;
      if (active[budget] >= limit) return undefined;
      active[budget] += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active[budget] -= 1;
      };
    },
    inspect: (request) =>
      inspectRequest(request, parsedOrigin, routes, maxBodyBytes, maxResponseBytes),
  };
}

export function createRemoteRouteHandler(
  options: RemoteRouteHandlerOptions,
): (request: Request, facts?: RemoteRouteFacts) => Promise<Response> {
  const unauthenticatedProxyBySource = new Map<string, number>();
  return async (request, facts) => {
    const decision = options.policy.inspect(request);
    if (decision.kind === "reject") return decision.response;
    if (decision.kind === "preflight")
      return new Response(null, { status: 204, headers: decision.headers });

    let maxBodyBytes = decision.maxBodyBytes;
    let releaseUnauthenticated: (() => void) | undefined;
    if (decision.surface === "server-proxy" && options.hasServerProxySession?.(request) !== true) {
      maxBodyBytes = Math.min(maxBodyBytes, UNAUTHENTICATED_SERVER_PROXY_BODY_BYTES);
      if (declaredBodyBytes(request) > maxBodyBytes) {
        await request.body?.cancel().catch(() => undefined);
        return rejectionResponse(413, decision.headers);
      }
      const source = facts?.sourceKey ?? "";
      const held = unauthenticatedProxyBySource.get(source) ?? 0;
      if (held >= UNAUTHENTICATED_SERVER_PROXY_PER_SOURCE) {
        await request.body?.cancel().catch(() => undefined);
        return rejectionResponse(429, decision.headers);
      }
      unauthenticatedProxyBySource.set(source, held + 1);
      let released = false;
      releaseUnauthenticated = () => {
        if (released) return;
        released = true;
        const next = (unauthenticatedProxyBySource.get(source) ?? 1) - 1;
        if (next <= 0) unauthenticatedProxyBySource.delete(source);
        else unauthenticatedProxyBySource.set(source, next);
      };
    }
    try {
      return await routeAdmitted(request, facts, decision, maxBodyBytes);
    } finally {
      // An unauthenticated request's answer is the host's own small refusal,
      // so its source slot ends with the handler rather than a body stream.
      releaseUnauthenticated?.();
    }
  };

  async function routeAdmitted(
    request: Request,
    facts: RemoteRouteFacts | undefined,
    decision: Extract<RemoteRouteDecision, { readonly kind: "allow" }>,
    maxBodyBytes: number,
  ): Promise<Response> {
    const release = options.policy.acquire(decision.surface);
    if (release === undefined) {
      return rejectionResponse(429, decision.headers);
    }
    let prepared: PreparedRequestResult;
    try {
      prepared = await prepareRequestBody(request, maxBodyBytes);
    } catch {
      release();
      return rejectionResponse(400, decision.headers);
    }
    if (prepared.kind !== "prepared") {
      release();
      return rejectionResponse(prepared.status, decision.headers);
    }
    let response: RemoteRouteResponse;
    try {
      if (decision.surface === "web-assets") {
        response = await options.webAssets(prepared.request);
      } else if (decision.surface === "pre-auth") {
        response = await options.preAuth(
          prepared.request,
          decision.route as RemoteRouteDefinition,
          facts,
        );
      } else if (decision.surface === "server-proxy") {
        response = await options.serverProxy?.(
          prepared.request,
          decision.route as RemoteRouteDefinition,
          facts,
        );
      } else {
        response = await options.authenticatedProduct(
          prepared.request,
          decision.route as RemoteRouteDefinition,
          facts,
        );
      }
    } catch {
      release();
      return rejectionResponse(503, decision.headers);
    }
    if (response === undefined) {
      release();
      return rejectionResponse(404, decision.headers);
    }
    if (
      decision.route?.relaysDevServer === true &&
      response.headers.get(REMOTE_SERVER_PROXY_RELAYED_HEADER) === REMOTE_SERVER_PROXY_RELAYED
    ) {
      // The dev server's own response: its headers stand and its body streams
      // uncapped, holding this request's slot until it ends.
      return withAdmissionRelease(response, release);
    }
    return limitResponse(response, decision.headers, decision.maxResponseBytes, release);
  }
}

function inspectRequest(
  request: Request,
  origin: URL,
  routes: readonly RemoteRouteDefinition[],
  defaultMaxBodyBytes: number,
  defaultMaxResponseBytes: number,
): RemoteRouteDecision {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const headerOrigin = request.headers.get("origin");
  const authorityMatched = request.headers.get("host") === origin.host;
  const originMatched = headerOrigin === null || headerOrigin === origin.origin;
  const forwardedHeaders = hasForwardedIdentity(request.headers);
  const pathSurface = classifyPath(url.pathname, routes);
  const facts: RedactedRemoteRequestFacts = {
    method,
    surface: pathSurface,
    authority: authorityMatched ? "matched" : "mismatched",
    origin: headerOrigin === null ? "absent" : originMatched ? "matched" : "mismatched",
    forwardedHeaders,
  };

  if (url.protocol !== "https:" || url.origin !== origin.origin || !authorityMatched) {
    return reject(400, facts);
  }
  if (forwardedHeaders) return reject(400, facts);
  if (!originMatched || headerOrigin === "null") return reject(403, facts);

  const fetchSite = normalizedHeader(request.headers, "sec-fetch-site");
  if (fetchSite !== undefined && fetchSite !== "same-origin" && fetchSite !== "none") {
    return reject(403, facts);
  }

  if (method === "OPTIONS") {
    const route = routes.find((candidate) => matches(candidate.match, url.pathname));
    if (route === undefined || headerOrigin === null || !routeAllowsQuery(route, url)) {
      return reject(404, facts);
    }
    return inspectPreflight(request, route, facts, origin.origin);
  }

  if (pathSurface === "local-only" || pathSurface === "unknown") return reject(404, facts);
  if (pathSurface === "web-assets") {
    if (method !== "GET" && method !== "HEAD") return reject(405, facts);
    if (hasBody(request)) return reject(413, facts);
    const headers = remoteHeaders(headerOrigin === null ? undefined : headerOrigin, []);
    // The app frames one thing: a running design's page on this same origin.
    headers.set(
      "content-security-policy",
      `${REMOTE_SECURITY_POLICY.csp}; frame-src ${origin.origin}${CANVAS_DESIGN_PAGE_PATH}`,
    );
    return allow(
      "web-assets",
      undefined,
      facts,
      headers,
      defaultMaxBodyBytes,
      defaultMaxResponseBytes,
    );
  }

  const route = routes.find((candidate) => matches(candidate.match, url.pathname));
  if (route === undefined || !routeAllowsQuery(route, url)) return reject(404, facts);
  if (!route.methods.includes(method as RemoteHttpMethod)) return reject(405, facts);
  const bodyLimit =
    (route.relaysDevServer === true || route.uploadsAttachment === true) &&
    route.maxBodyBytes !== undefined
      ? route.maxBodyBytes
      : Math.min(route.maxBodyBytes ?? defaultMaxBodyBytes, defaultMaxBodyBytes);
  if (
    declaredBodyBytes(request) > bodyLimit ||
    (hasBody(request) && (method === "GET" || method === "HEAD"))
  ) {
    return reject(413, facts);
  }
  if (route.relaysDevServer !== true && hasBody(request) && !contentTypeAllowed(request, route)) {
    return reject(415, facts);
  }
  const headers = remoteHeaders(
    headerOrigin === null ? undefined : headerOrigin,
    route.allowedRequestHeaders ?? REMOTE_REQUEST_HEADERS,
  );
  if (route.responsePolicy !== undefined) {
    headers.set("content-security-policy", route.responsePolicy);
  }
  return allow(
    route.surface,
    route,
    facts,
    headers,
    bodyLimit,
    Math.min(route.maxResponseBytes ?? defaultMaxResponseBytes, defaultMaxResponseBytes),
  );
}

function inspectPreflight(
  request: Request,
  route: RemoteRouteDefinition,
  facts: RedactedRemoteRequestFacts,
  origin: string,
): RemoteRouteDecision {
  const requestedMethod = normalizedHeader(
    request.headers,
    "access-control-request-method",
  )?.toUpperCase();
  const requestedHeaders = parseHeaderList(request.headers.get("access-control-request-headers"));
  const allowedHeaders = new Set(
    (route.allowedRequestHeaders ?? REMOTE_REQUEST_HEADERS).map((header) => header.toLowerCase()),
  );
  if (
    requestedMethod === undefined ||
    !route.methods.includes(requestedMethod as RemoteHttpMethod) ||
    requestedHeaders.some((header) => !allowedHeaders.has(header))
  ) {
    return reject(403, facts);
  }
  return {
    kind: "preflight",
    headers: remoteHeaders(origin, [...allowedHeaders].sort(), route.methods),
    facts,
  };
}

function classifyPath(
  pathname: string,
  routes: readonly RemoteRouteDefinition[],
): RedactedRemoteRequestFacts["surface"] {
  if (LOCAL_ONLY_PREFIXES.some((prefix) => pathMatchesPrefix(pathname, prefix)))
    return "local-only";
  const route = routes.find((candidate) => matches(candidate.match, pathname));
  if (route !== undefined) return route.surface;
  if (pathname.startsWith("/api/")) return "unknown";
  return "web-assets";
}

function validateRoutes(
  routes: readonly RemoteRouteDefinition[],
  surface: RemoteRouteSurface,
): readonly RemoteRouteDefinition[] {
  const ids = new Set<string>();
  for (const route of routes) {
    if (
      !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(route.id) ||
      ids.has(route.id) ||
      route.surface !== surface ||
      !route.match.path.startsWith("/") ||
      route.match.path.includes("..") ||
      route.match.path.includes("?") ||
      route.match.path.includes("#") ||
      route.match.path === "/api/" ||
      route.methods.length === 0 ||
      !validRouteBudget(route.maxBodyBytes) ||
      !validRouteBudget(route.maxResponseBytes) ||
      (surface === "authenticated-product" && !route.match.path.startsWith("/api/")) ||
      (surface === "server-proxy") !== pathMatchesPrefix(route.match.path, SERVER_PROXY_PREFIX) ||
      (route.relaysDevServer === true &&
        (surface !== "server-proxy" || route.maxBodyBytes === undefined)) ||
      (route.uploadsAttachment === true &&
        (surface !== "authenticated-product" || route.maxBodyBytes === undefined)) ||
      isLocalOnlyMatch(route.match)
    ) {
      throw new Error("Remote route definition is invalid or local-only.");
    }
    ids.add(route.id);
  }
  return routes;
}

function validRouteBudget(value: number | undefined): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value > 0);
}

function isLocalOnlyMatch(match: RemoteRouteMatch): boolean {
  return LOCAL_ONLY_PREFIXES.some((prefix) => pathMatchesPrefix(match.path, prefix));
}

function parseRemoteOrigin(value: string): URL {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new Error("Remote origin is invalid.");
  }
  const effectivePort = origin.port === "" && origin.protocol === "https:" ? "443" : origin.port;
  if (
    origin.protocol !== "https:" ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== "" ||
    effectivePort === ""
  ) {
    throw new Error("Remote origin must be an explicit HTTPS origin.");
  }
  return origin;
}

function matches(match: RemoteRouteMatch, pathname: string): boolean {
  return match.kind === "exact" ? pathname === match.path : pathMatchesPrefix(pathname, match.path);
}

function pathMatchesPrefix(pathname: string, prefix: string): boolean {
  const boundary = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return pathname === boundary || pathname.startsWith(`${boundary}/`);
}

function routeAllowsQuery(route: RemoteRouteDefinition, url: URL): boolean {
  return route.allowQuery === true || url.search === "";
}

function contentTypeAllowed(request: Request, route: RemoteRouteDefinition): boolean {
  const contentType = request.headers.get("content-type");
  if (contentType === null) return false;
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return (route.allowedContentTypes ?? REMOTE_CONTENT_TYPES).includes(mediaType as never);
}

function declaredBodyBytes(request: Request): number {
  const value = request.headers.get("content-length");
  if (value === null) return 0;
  if (!/^\d+$/.test(value)) return Number.POSITIVE_INFINITY;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function hasBody(request: Request): boolean {
  return (
    request.body !== null ||
    declaredBodyBytes(request) > 0 ||
    request.headers.has("transfer-encoding")
  );
}

type PreparedRequestResult =
  | { readonly kind: "prepared"; readonly request: Request }
  | { readonly kind: "too-large"; readonly status: 413 }
  | { readonly kind: "aborted"; readonly status: 400 };

async function prepareRequestBody(
  request: Request,
  maxBodyBytes: number,
): Promise<PreparedRequestResult> {
  const declared = declaredBodyBytes(request);
  if (declared > maxBodyBytes) {
    await request.body?.cancel().catch(() => undefined);
    return { kind: "too-large", status: 413 };
  }
  if (request.body === null) return { kind: "prepared", request };
  if (request.bodyUsed) {
    await request.body.cancel().catch(() => undefined);
    return { kind: "aborted", status: 400 };
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = request.body.getReader();
  } catch {
    await request.body.cancel().catch(() => undefined);
    return { kind: "aborted", status: 400 };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done || next.value === undefined) break;
      if (total + next.value.byteLength > maxBodyBytes) {
        await reader.cancel();
        return { kind: "too-large", status: 413 };
      }
      chunks.push(next.value);
      total += next.value.byteLength;
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return { kind: "aborted", status: 400 };
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const headers = new Headers(request.headers);
    headers.delete("transfer-encoding");
    headers.set("content-length", String(total));
    const boundedInit: RequestInit = { body, headers };
    return { kind: "prepared", request: new Request(request, boundedInit) };
  } catch {
    return { kind: "aborted", status: 400 };
  }
}

function hasForwardedIdentity(headers: Headers): boolean {
  for (const [name] of headers) {
    const normalized = name.toLowerCase();
    if (
      normalized === "forwarded" ||
      normalized === "x-real-ip" ||
      normalized === "x-client-cert" ||
      normalized === "x-forwarded-client-cert" ||
      normalized === "ssl-client-cert" ||
      normalized.startsWith("x-forwarded-")
    ) {
      return true;
    }
  }
  return false;
}

function normalizedHeader(headers: Headers, name: string): string | undefined {
  const value = headers.get(name);
  return value === null ? undefined : value.trim().toLowerCase();
}

function parseHeaderList(value: string | null): string[] {
  if (value === null || value.trim() === "") return [];
  return value
    .split(",")
    .map((header) => header.trim().toLowerCase())
    .filter((header) => header.length > 0);
}

function boundedPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} is invalid.`);
  return value;
}

function allow(
  surface: "web-assets" | RemoteRouteSurface,
  route: RemoteRouteDefinition | undefined,
  facts: RedactedRemoteRequestFacts,
  headers: Headers,
  maxBodyBytes: number,
  maxResponseBytes: number,
): RemoteRouteDecision {
  return {
    kind: "allow",
    surface,
    ...(route === undefined ? {} : { route }),
    headers,
    maxBodyBytes,
    maxResponseBytes,
    facts,
  };
}

function reject(status: number, facts: RedactedRemoteRequestFacts): RemoteRouteDecision {
  return {
    kind: "reject",
    response: rejectionResponse(status, remoteHeaders(undefined, [])),
    facts,
  };
}

function rejectionResponse(status: number, headers: Headers): Response {
  return Response.json(
    {
      product: "Octant",
      status: "rejected",
      category: "invalid",
      message: "Remote request rejected.",
    },
    { status, headers },
  );
}

function remoteHeaders(
  origin: string | undefined,
  allowedHeaders: readonly string[],
  methods: readonly string[] = [],
): Headers {
  const headers = new Headers({
    "content-security-policy": REMOTE_SECURITY_POLICY.csp,
    "referrer-policy": REMOTE_SECURITY_POLICY.referrer,
    "strict-transport-security": REMOTE_SECURITY_POLICY.hsts,
    vary: "Origin",
    "x-content-type-options": REMOTE_SECURITY_POLICY.nosniff,
  });
  if (origin !== undefined) headers.set("access-control-allow-origin", origin);
  if (allowedHeaders.length > 0)
    headers.set("access-control-allow-headers", allowedHeaders.join(", "));
  if (methods.length > 0) headers.set("access-control-allow-methods", methods.join(", "));
  return headers;
}

function limitResponse(
  response: Response,
  securityHeaders: Headers,
  maxBytes: number,
  release: () => void,
): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of securityHeaders) headers.set(name, value);
  if (response.body === null) {
    release();
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  headers.delete("content-length");
  const reader = response.body.getReader();
  let total = 0;
  let released = false;
  const finish = () => {
    if (released) return;
    released = true;
    release();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done || next.value === undefined) {
          finish();
          controller.close();
          return;
        }
        const remaining = maxBytes - total;
        if (remaining <= 0) {
          await reader.cancel();
          finish();
          controller.close();
          return;
        }
        const chunk =
          next.value.byteLength > remaining ? next.value.slice(0, remaining) : next.value;
        total += chunk.byteLength;
        controller.enqueue(chunk);
        if (total >= maxBytes) {
          await reader.cancel();
          finish();
          controller.close();
        }
      } catch {
        finish();
        controller.error(new Error("Remote response stream exceeded its budget."));
      }
    },
    async cancel() {
      await reader.cancel().catch(() => undefined);
      finish();
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
