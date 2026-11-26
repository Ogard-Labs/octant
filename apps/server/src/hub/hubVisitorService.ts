// Visitor links on the acting hub (decisions H31, H32 and H35). The hub holds
// only the grants spokes signed: a grant whose signer is not the key the roster
// lists for its spoke is dropped. Every visitor request carries a proof from a
// key the browser made, and the hub asks the spoke on every one, so the spoke
// decides revocation, expiry, the thread's state, and which browser the link
// is bound to. The hub carries the redacted projection the spoke built and
// nothing else of the thread. Off until a window turns it on.

import {
  HubMemberId,
  PUBLIC_ENTRANCE_MAX_VISITOR_STREAMS,
  VISITOR_KEY_HEADER,
  VISITOR_LINK_COMMENTS_PER_MINUTE,
  VISITOR_LINK_REQUESTS_PER_MINUTE,
  VISITOR_PROOF_HEADER,
  VISITOR_PROOF_SKEW_MS,
  type AuditActingPrincipal,
  type HubMembershipChangedPayload,
  type HubVisitorGrantsUpdate,
  type SignedVisitorLinkGrant,
  type VisitorFetchAnswer,
  type VisitorFetchRequest,
} from "@octant/contracts";
import { visitorProofPayload } from "@octant/domain";
import { Schema } from "effect";
import type { HubStatePort, HubVisitorHubState } from "./hubStateStore";
import { publicKeyFingerprint, verifySignature } from "./hubCrypto";
import type { PublicAnswer, PublicEntranceHandlers, PublicRequest } from "./publicEntrance";
import { checkVisitorLinkGrant } from "./publicEntranceCrypto";

const decodeMemberId = Schema.decodeUnknownSync(HubMemberId);
const MINUTE_MS = 60_000;
const DEFAULT_POLL_MS = 2_000;
// A comment is up to 4,000 characters, which as UTF-8 inside JSON may take
// four bytes each and six for an escaped control character.
const BODY_MAX_BYTES = 32 * 1024;
const NONCES_MAX = 4_096;
const STREAMS_PER_BROWSER = 4;
// Windows are keyed per browser key, which anyone can mint, so idle ones go.
const WINDOWS_MAX = 4_096;

export interface HubVisitorViewer {
  /** The viewer page, the same for every link: it holds no content. */
  readonly page: string;
  /** The viewer's own script and style, by the hashed name the page asks for. */
  readonly assets: ReadonlyMap<string, { readonly type: string; readonly body: string }>;
}

export interface HubVisitorServiceOptions {
  readonly state: HubStatePort;
  /** Whether this host serves the entrance now: it is the acting hub. */
  readonly serving: () => boolean;
  readonly hubMemberId: () => string;
  /** The identity-key fingerprint the signed roster lists for a member. */
  readonly rosterFingerprintFor: (memberId: string) => string | undefined;
  /** Asks the spoke over the pinned private transport; undefined when it cannot be reached. */
  readonly ask: (
    spokeMemberId: string,
    request: VisitorFetchRequest,
  ) => Promise<VisitorFetchAnswer | undefined>;
  readonly viewer?: HubVisitorViewer;
  readonly record: (change: HubMembershipChangedPayload) => void;
  readonly now: () => number;
  /** How often an open stream asks the spoke again. */
  readonly pollMs?: number;
}

export interface HubVisitorStatus {
  readonly enabled: boolean;
  readonly grants: number;
  readonly streams: number;
}

const json = (status: number, value: unknown): PublicAnswer => ({
  status,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value),
});
/** Unknown, disabled, wrongly signed, and opened with a wrong secret all look the same. */
const NOT_FOUND = json(404, { error: "not-found" });
const GONE = json(410, { error: "link-unavailable" });

type Admission =
  | {
      readonly status: "admitted";
      readonly signed: SignedVisitorLinkGrant;
      readonly binding: string;
    }
  | { readonly status: "refused"; readonly answer: PublicAnswer };

function refusalAnswer(answer: Extract<VisitorFetchAnswer, { status: "refused" }>): PublicAnswer {
  switch (answer.kind) {
    case "public-not-granted":
    case "unknown-link":
    case "paused":
      return NOT_FOUND;
    case "revoked":
    case "expired":
    case "ended":
      return GONE;
    case "comments-full":
      return json(429, { error: answer.kind });
    case "not-bound":
    case "bound-elsewhere":
    case "comment-not-allowed":
      return json(403, { error: answer.kind });
  }
}

export class HubVisitorService {
  readonly #options: HubVisitorServiceOptions;
  readonly #rate = new Map<string, number[]>();
  readonly #commentRate = new Map<string, number[]>();
  readonly #nonces = new Map<string, number>();
  #streams = 0;
  readonly #streamsByBinding = new Map<string, number>();

  constructor(options: HubVisitorServiceOptions) {
    this.#options = options;
  }

  status(): HubVisitorStatus {
    const held = this.#load();
    return { enabled: held.enabled, grants: held.grants.length, streams: this.#streams };
  }

  /** The grants this hub holds now; failover copies them to a standby. */
  heldGrants(): ReadonlyArray<SignedVisitorLinkGrant> {
    return this.#load().grants;
  }

  async setEnabled(
    enabled: boolean,
    principal: AuditActingPrincipal,
  ): Promise<{ readonly status: "changed"; readonly enabled: boolean }> {
    this.#save({ ...this.#load(), enabled });
    this.#options.record({ change: "visitor-switch-changed", actingPrincipal: principal });
    return { status: "changed", enabled };
  }

  /**
   * Replaces what this hub holds for one spoke. A grant for another spoke, or
   * one signed by a key the roster does not list for this spoke, is dropped.
   */
  receiveGrants(
    spokeMemberId: string,
    update: HubVisitorGrantsUpdate,
  ): { readonly status: "recorded"; readonly count: number } {
    const listed = this.#options.rosterFingerprintFor(spokeMemberId);
    const own = update.grants.filter(
      (signed) =>
        String(signed.grant.spokeMemberId) === spokeMemberId &&
        listed !== undefined &&
        publicKeyFingerprint(signed.signerPublicKey) === listed,
    );
    const held = this.#load();
    this.#save({
      ...held,
      grants: [
        ...held.grants.filter((signed) => String(signed.grant.spokeMemberId) !== spokeMemberId),
        ...own,
      ],
    });
    this.#options.record({
      change: "visitor-grants-received",
      actingPrincipal: { kind: "peer", memberId: decodeMemberId(spokeMemberId) },
      memberId: decodeMemberId(spokeMemberId),
    });
    return { status: "recorded", count: own.length };
  }

  /** The entrance's visitor routes; none while the switch is off. */
  handlers(): PublicEntranceHandlers {
    if (!this.#load().enabled) return {};
    const viewer = this.#options.viewer;
    return {
      ...(viewer === undefined
        ? {}
        : {
            visitorPage: async () => ({
              status: 200,
              headers: { "content-type": "text/html; charset=utf-8" },
              body: viewer.page,
            }),
            visitorAsset: async (request) => {
              const asset = viewer.assets.get(request.params.asset ?? "");
              return asset === undefined
                ? NOT_FOUND
                : { status: 200, headers: { "content-type": asset.type }, body: asset.body };
            },
          }),
      visitorOpen: (request) => this.#open(request),
      visitorStream: (request) => this.#stream(request),
      visitorComments: (request) => this.#comment(request),
    };
  }

  async #open(request: PublicRequest): Promise<PublicAnswer> {
    const admitted = this.#admit(request);
    if (admitted.status === "refused") return admitted.answer;
    const body = await this.#readJson(request);
    const secret = typeof body?.["secret"] === "string" ? body["secret"] : undefined;
    if (secret === undefined) return json(400, { error: "invalid" });
    const decision = checkVisitorLinkGrant({
      signed: admitted.signed,
      secret,
      nowMs: this.#options.now(),
      rosterFingerprintFor: (memberId) => this.#options.rosterFingerprintFor(String(memberId)),
    });
    if (decision.status === "refused") {
      return decision.kind === "expired" || decision.kind === "lifetime-too-long"
        ? GONE
        : NOT_FOUND;
    }
    const answer = await this.#ask(admitted.signed, admitted.binding, "open", undefined, secret);
    if (answer === undefined) return json(503, { error: "unavailable" });
    if (answer.status === "refused") return refusalAnswer(answer);
    return json(200, { scope: answer.scope, expiresAt: answer.expiresAt });
  }

  async #stream(request: PublicRequest): Promise<PublicAnswer> {
    const admitted = this.#admitSigned(request);
    if (admitted.status === "refused") return admitted.answer;
    const binding = admitted.binding;
    // The slot is taken before the first await, so concurrent opens cannot
    // all pass the cap while the first ask is pending; one browser may hold
    // only a few of them.
    if (
      this.#streams >= PUBLIC_ENTRANCE_MAX_VISITOR_STREAMS ||
      (this.#streamsByBinding.get(binding) ?? 0) >= STREAMS_PER_BROWSER
    ) {
      return json(503, { error: "busy" });
    }
    let open = true;
    this.#streams += 1;
    this.#streamsByBinding.set(binding, (this.#streamsByBinding.get(binding) ?? 0) + 1);
    const finish = () => {
      if (!open) return;
      open = false;
      this.#streams -= 1;
      const held = (this.#streamsByBinding.get(binding) ?? 1) - 1;
      if (held <= 0) this.#streamsByBinding.delete(binding);
      else this.#streamsByBinding.set(binding, held);
    };
    const first = await this.#ask(admitted.signed, binding, "read");
    if (first === undefined || first.status === "refused") {
      finish();
      return first === undefined ? json(503, { error: "unavailable" }) : refusalAnswer(first);
    }
    const pollMs = this.#options.pollMs ?? DEFAULT_POLL_MS;
    const encoder = new TextEncoder();
    let last = "";
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const emit = (answer: VisitorFetchAnswer) => {
          if (answer.status === "refused") {
            controller.enqueue(
              encoder.encode(`event: end\ndata: ${JSON.stringify({ reason: answer.kind })}\n\n`),
            );
            return false;
          }
          const text = JSON.stringify(answer.projection ?? null);
          if (text !== last) {
            last = text;
            controller.enqueue(encoder.encode(`data: ${text}\n\n`));
          }
          return true;
        };
        const loop = async () => {
          let going = emit(first);
          while (going && open && !request.signal.aborted) {
            await new Promise((resolve) => setTimeout(resolve, pollMs));
            if (!open || request.signal.aborted) break;
            // The switch going off, or this host no longer acting as hub, ends
            // a stream already open, not only the next one.
            if (!this.#options.serving() || !this.#load().enabled) {
              controller.enqueue(
                encoder.encode(`event: end\ndata: ${JSON.stringify({ reason: "closed" })}\n\n`),
              );
              break;
            }
            // Every look asks the spoke again: a stopped or expired link ends here.
            const next = await this.#ask(admitted.signed, admitted.binding, "read");
            going = next !== undefined && emit(next);
          }
          finish();
          try {
            controller.close();
          } catch {
            // The reader already went away.
          }
        };
        void loop();
      },
      cancel: () => finish(),
    });
    request.signal.addEventListener("abort", finish, { once: true });
    return {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
      body,
    };
  }

  async #comment(request: PublicRequest): Promise<PublicAnswer> {
    const admitted = this.#admitSigned(request);
    if (admitted.status === "refused") return admitted.answer;
    const window = `${String(admitted.signed.grant.linkId)}|${admitted.binding}`;
    if (!take(this.#commentRate, window, VISITOR_LINK_COMMENTS_PER_MINUTE, this.#options.now())) {
      return json(429, { error: "rate-limited" });
    }
    const body = await this.#readJson(request);
    const text = typeof body?.["text"] === "string" ? body["text"].trim() : "";
    if (text === "" || text.length > 4_000) return json(400, { error: "invalid" });
    const answer = await this.#ask(admitted.signed, admitted.binding, "read", text);
    if (answer === undefined) return json(503, { error: "unavailable" });
    if (answer.status === "refused") return refusalAnswer(answer);
    return json(202, { waiting: true });
  }

  /** The switch, the route's own grant, the per-link cap, and the browser's proof. */
  #admit(request: PublicRequest): Admission {
    if (!this.#options.serving() || !this.#load().enabled) {
      return { status: "refused", answer: NOT_FOUND };
    }
    const linkId = request.params.id ?? "";
    const signed = this.#load().grants.find((entry) => String(entry.grant.linkId) === linkId);
    if (signed === undefined) return { status: "refused", answer: NOT_FOUND };
    const binding = this.#checkProof(request);
    if (binding === undefined) return { status: "refused", answer: json(401, { error: "proof" }) };
    // Windows are per link and browser key, so someone who saw only the link
    // id cannot spend the real visitor's allowance with keys of their own.
    const window = `${linkId}|${binding}`;
    if (!take(this.#rate, window, VISITOR_LINK_REQUESTS_PER_MINUTE, this.#options.now())) {
      return { status: "refused", answer: json(429, { error: "rate-limited" }) };
    }
    return { status: "admitted", signed, binding };
  }

  /** As `#admit`, and the grant itself still checks out without its secret. */
  #admitSigned(request: PublicRequest): Admission {
    const admitted = this.#admit(request);
    if (admitted.status === "refused") return admitted;
    const decision = checkVisitorLinkGrant({
      signed: admitted.signed,
      nowMs: this.#options.now(),
      rosterFingerprintFor: (memberId) => this.#options.rosterFingerprintFor(String(memberId)),
    });
    if (decision.status === "refused") {
      return {
        status: "refused",
        answer: decision.kind === "expired" ? GONE : NOT_FOUND,
      };
    }
    return admitted;
  }

  /**
   * The browser signs `method|path|time|nonce` with the key it names. The
   * binding the spoke holds the link to is that key's fingerprint.
   */
  #checkProof(request: PublicRequest): string | undefined {
    const key = request.headers.get(VISITOR_KEY_HEADER);
    const proof = request.headers.get(VISITOR_PROOF_HEADER)?.split(".");
    if (key === undefined || proof?.length !== 3 || key.length > 512) return undefined;
    const [timestamp = "", nonce = "", signature = ""] = proof;
    const now = this.#options.now();
    const at = Number(timestamp);
    if (!/^\d{1,16}$/.test(timestamp) || Math.abs(now - at) > VISITOR_PROOF_SKEW_MS) {
      return undefined;
    }
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return undefined;
    for (const [seen, until] of this.#nonces) if (until < now) this.#nonces.delete(seen);
    if (this.#nonces.has(nonce) || this.#nonces.size >= NONCES_MAX) return undefined;
    const valid = verifySignature({
      payload: visitorProofPayload({
        method: request.method,
        path: request.path,
        timestamp,
        nonce,
      }),
      signature,
      publicKey: key,
    });
    if (!valid) return undefined;
    this.#nonces.set(nonce, now + 2 * VISITOR_PROOF_SKEW_MS);
    return publicKeyFingerprint(key);
  }

  #ask(
    signed: SignedVisitorLinkGrant,
    binding: string,
    kind: "open" | "read",
    comment?: string,
    secret?: string,
  ): Promise<VisitorFetchAnswer | undefined> {
    return this.#options
      .ask(String(signed.grant.spokeMemberId), {
        linkId: signed.grant.linkId,
        revision: signed.grant.revision,
        binding,
        kind: comment === undefined ? kind : "comment",
        ...(comment === undefined ? {} : { comment }),
        ...(secret === undefined ? {} : { secret }),
      })
      .catch(() => undefined);
  }

  async #readJson(request: PublicRequest): Promise<Record<string, unknown> | undefined> {
    const body = await request.readBody(BODY_MAX_BYTES);
    if (body.status !== "read") return undefined;
    try {
      const value: unknown = JSON.parse(body.bytes.toString("utf8"));
      return typeof value === "object" && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : undefined;
    } catch {
      return undefined;
    }
  }

  #load(): HubVisitorHubState {
    return this.#options.state.load().visitorHub ?? { enabled: false, grants: [] };
  }

  #save(visitorHub: HubVisitorHubState): void {
    this.#options.state.save({ ...this.#options.state.load(), visitorHub });
  }
}

function take(windows: Map<string, number[]>, key: string, limit: number, now: number): boolean {
  if (windows.size >= WINDOWS_MAX) {
    for (const [held, times] of windows) {
      if (times.every((at) => now - at >= MINUTE_MS)) windows.delete(held);
    }
  }
  const recent = (windows.get(key) ?? []).filter((at) => now - at < MINUTE_MS);
  const allowed = recent.length < limit;
  if (allowed) recent.push(now);
  windows.set(key, recent);
  return allowed;
}
