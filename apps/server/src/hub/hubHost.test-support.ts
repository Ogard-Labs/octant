// A whole Octant host for the hub tests: its journal, its real remote gateway
// behind a real TLS listener serving a certificate it made itself, and the hub
// role and spoke link wired as the server wires them. The network seams are
// the only difference from a real pair of hosts: each host's Tailscale address
// is dialled on loopback.

import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign as cryptoSign,
  type KeyObject,
} from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpsServer, type Server } from "node:https";
import { connect as connectTcp, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { decodeStableHostId } from "@octant/contracts/remote-access";
import type {
  AppReleaseRing,
  HubDelegationRecordedPayload,
  HubMembershipChangedPayload,
  HubSignInKind,
} from "@octant/contracts";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import type { RequestTransportFacts, Serve } from "../server";
import type { LocalDeviceAdministrationPort } from "../remote/localDeviceAdministrationRoutes";
import type { PrivateListenerHostStatus } from "../remote/privateListenerLifecycleController";
import {
  createRemoteGateway,
  type RemoteGateway,
  type RemoteProductDispatch,
} from "../remote/remoteGateway";
import { createSelfMadeListenerCertificateStore } from "../remote/selfMadeListenerCertificate";
import { DelegatingSpokeService, type DelegatingParentPort } from "./delegatingSpokeService";
import { createDelegationStateStore, type DelegationStatePort } from "./delegationStateStore";
import { FailoverService } from "./failoverService";
import { createHubLinkRouteHandler } from "./hubLinkRoutes";
import { createHubOwnerRouteHandler } from "./hubOwnerRoutes";
import { TestCredentialBroker, TestPostureHost } from "./hubOwner.test-support";
import { OwnerCredentialCopyService } from "./ownerCredentialCopy";
import { createPeerCredentialRouteHandler } from "./peerCredentialRoutes";
import { OwnerUnlockService } from "./ownerUnlock";
import { createHubStateStore, type HubStatePort } from "./hubStateStore";
import { HubService, type HubHostIdentity, type HubPairingPort } from "./hubService";
import { createPeerDelegationRouteHandler } from "./peerDelegationRoutes";
import { PeerDelegationService, type PeerDelegationHost } from "./peerDelegationService";
import { createPinnedHubTransport, type HubNetwork, type HubTransport } from "./pinnedHubTransport";
import { createRosterSigningKeyStore } from "./rosterSigningKey";
import { deviceLifecycleAt, SpokeLinkService } from "./spokeLinkService";
import { REMOTE_PUSH_GATEWAY_DEFAULT_URL } from "@octant/contracts/remote-push-notifications";
import type { PushDeliveryTransport } from "../automation/pushDeliveryTransport";
import { createGatewayPushDeliveryTransport } from "../remote/gatewayPushDeliveryTransport";
import { createHubPushDeliveryTransport } from "./hubPushTransport";
import { ProvisionService } from "./provisionService";
import { PushService } from "./pushService";
import { SignInService } from "./signInService";
import { SpokeProvisionService, type ProvisionHostPorts } from "./spokeProvisionService";
import { SpokePushService } from "./spokePushService";
import { SpokeSignInService, type SignInAccountState } from "./spokeSignInService";
import { SpokeWakeService, type WakeRoutineView } from "./spokeWakeService";
import { WakeService } from "./wakeService";

/** What a test host's services did for applied offers. */
export interface ProvisionedByOffer {
  channel: AppReleaseRing | undefined;
  readonly plugins: Array<{ entryId: string; trusted: boolean; enabled: boolean }>;
  readonly profiles: Array<{ displayName: string }>;
  readonly endpoints: Array<{ displayName: string; enabled: boolean }>;
  readonly routines: Array<{ displayName: string; projectId: string; authoredBy: "local-window" }>;
  /** Makes every apply on this host fail, as a service that refused would. */
  fail: boolean;
}

function deviceIsActive(
  administration: Pick<LocalDeviceAdministrationPort, "listDevices">,
  deviceId: string,
): boolean {
  return administration
    .listDevices()
    .some((device) => device.deviceId === deviceId && device.state === "active");
}

const tailscaleFacts: RequestTransportFacts = {
  listenerTrust: "remote",
  sourceClass: "tailscale",
  sourceKey: "opaque-tailscale-source-key",
};

const NO_DELEGATION_HOST: PeerDelegationHost = {
  projectAuthority: () => undefined,
  startThread: async () => ({ status: "refused", kind: "project-unavailable" }),
  readThread: async () => undefined,
  interrupt: async () => "unavailable",
};

const NO_PARENT: DelegatingParentPort = {
  check: () => ({ status: "refused", kind: "parent-unavailable" }),
  ingest: () => "refused",
};

/** Maps each host's private address to the loopback port its listener really serves on. */
export class HubTestNetwork {
  readonly #ports = new Map<string, number>();
  readonly #stopped = new Set<string>();
  readonly dialled: string[] = [];

  register(address: string, port: number): void {
    this.#ports.set(address, port);
  }

  /** Makes a host unreachable to every other host, as a stopped machine is; its own state stays. */
  stop(address: string): void {
    this.#stopped.add(address);
  }

  start(address: string): void {
    this.#stopped.delete(address);
  }

  readonly network: HubNetwork = {
    resolve: async (hostname) => [hostname],
    dial: (address) =>
      new Promise<Socket>((resolve, reject) => {
        const port = this.#ports.get(address);
        if (port === undefined || this.#stopped.has(address)) {
          reject(new Error(`No test host at ${address}.`));
          return;
        }
        this.dialled.push(address);
        const socket = connectTcp({ host: "127.0.0.1", port });
        socket.once("error", reject);
        socket.once("connect", () => {
          Object.defineProperty(socket, "remoteAddress", { value: address });
          resolve(socket);
        });
      }),
  };
}

export interface HubTestHost {
  readonly hostId: string;
  readonly origin: string;
  readonly address: string;
  readonly name: string;
  readonly directory: string;
  readonly administration: LocalDeviceAdministrationPort;
  readonly gateway: RemoteGateway;
  readonly hub: HubService;
  readonly spoke: SpokeLinkService;
  readonly failover: FailoverService;
  /** The hub side of the wake service, and what a standing-in standby wakes with. */
  readonly wake: WakeService;
  /** This host's side of the wake service as a spoke. */
  readonly spokeWake: SpokeWakeService;
  /** The hub side of push through the hub, and what a standing-in standby forwards with. */
  readonly push: PushService;
  /** This host's side of push through the hub as a spoke. */
  readonly spokePush: SpokePushService;
  /** This host's own Notifications setting: a test turns it on and names a gateway. */
  readonly pushSetting: { enabled: boolean; gatewayUrl: string };
  /** The transport this host's notifications are sent through: the hub's way where the grant ticks Push, else its own. */
  readonly pushDelivery: PushDeliveryTransport;
  /** The hub side of provisioning: offers, delivery, and the mirror it serves. */
  readonly provision: ProvisionService;
  /** This host's side of provisioning as a spoke: proposals, apply, dismiss, auto-apply. */
  readonly spokeProvision: SpokeProvisionService;
  /** What this host's services did with applied offers, and a switch to make them fail. */
  readonly provisioned: ProvisionedByOffer;
  /** The hub side of hub-started sign-in: the question it relays and the outcome word it keeps. */
  readonly signIn: SignInService;
  /** This host's side of hub-started sign-in as a spoke. */
  readonly spokeSignIn: SpokeSignInService;
  /** Whether the provider's own app on this host holds each sign-in; a test changes it as the person would in a terminal. */
  readonly accounts: Record<HubSignInKind, SignInAccountState>;
  /** Starts a new wake service over the same state, as a restart of the server does; `spokeWake` is then the new one. */
  readonly restartSpokeWake: () => SpokeWakeService;
  /** The magic packets this host's wake service sent, as the fake socket saw them. */
  readonly magicPackets: Uint8Array[];
  /** This host's routines as the wake service may read them: a test edits it to schedule, disable, or remove one. */
  readonly routines: WakeRoutineView[];
  /** How many times a nudge woke this host's own scheduler. */
  readonly schedulerPokes: { count: number };
  readonly state: HubStatePort;
  readonly records: HubMembershipChangedPayload[];
  /** This host's delegations, sent and received, as the delegation routes keep them. */
  readonly delegationState: DelegationStatePort;
  readonly delegationRecords: HubDelegationRecordedPayload[];
  /** The delegating side of this host: what its agents' remote child runs go through. */
  readonly delegating: DelegatingSpokeService;
  /** This host's credential broker: the sign-ins it holds and the provider rows that take one. */
  readonly credentials: TestCredentialBroker;
  /** This host's Code postures, as the owner posture routes read and change them. */
  readonly postures: TestPostureHost;
  readonly listener: PrivateListenerHostStatus;
  /** Every request this host's listener answered, as `METHOD path`. */
  readonly requests: string[];
  /** The listener, called as a signed member would call it. */
  readonly hubLink: (request: Request) => Promise<Response | undefined>;
  readonly signHostPayload: (payload: string) => string;
  readonly hostPublicKey: string;
  readonly privateKey: KeyObject;
  /** Moves the clock the owner routes read; the rest of the host keeps real time. */
  readonly clock: { offset: number };
}

export async function startHubTestHost(input: {
  readonly name: string;
  readonly address: string;
  readonly network: HubTestNetwork;
  readonly cleanups: Array<() => Promise<void> | void>;
  readonly listenerStatus?: Partial<PrivateListenerHostStatus>;
  /** What a delegation to this host becomes; absent, this host has no Project open for delegated work. */
  readonly delegationHost?: PeerDelegationHost;
  /** This host's own rules for a parent thread; absent, it has no parent thread to delegate for. */
  readonly parent?: DelegatingParentPort;
  /** Wraps the transport this host's delegating side sends through, so a test can lose an answer. */
  readonly delegatingTransport?: (transport: HubTransport) => HubTransport;
  /** Wraps the transport this host's hub side sends through, so a test can hold a roster publication in flight. */
  readonly hubTransport?: (transport: HubTransport) => HubTransport;
  /** The authenticated product surface; the tests that prove a member reaches none of it pass a spy. */
  readonly productDispatch?: RemoteProductDispatch;
  /** The clock the spoke role reads, so a test can let a device's inactivity window pass. */
  readonly now?: () => number;
  /** Wraps the transport this host's failover side sends through, so a test can hold a hand-back in flight. */
  readonly failoverTransport?: (transport: HubTransport) => HubTransport;
  /** Wraps the transport this host's spoke side sends through, so a test can change state while an answer is awaited. */
  readonly spokeTransport?: (transport: HubTransport) => HubTransport;
  /** The failover time in milliseconds; absent, the roster's own. A test cannot wait five minutes. */
  readonly failoverAfterMs?: number;
  /**
   * The clock the wake service, the spoke's wake reports, and the member-link
   * checks read, so a test can move to just before a routine is due. Every
   * host in one test shares it.
   */
  readonly wakeClock?: () => number;
  /** How long before an occurrence the hub starts waking; absent, the service's own. */
  readonly wakeLeadMs?: number;
  /** Makes the fake socket report that it could not send. */
  readonly wakeSocketFails?: boolean;
  /** Wraps the transport this host's wake reports go through, so a test can read the bodies sent. */
  readonly wakeTransport?: (transport: HubTransport) => HubTransport;
  /** Wraps the transport this host hands sealed notifications to the hub through, so a test can read what is sent. */
  readonly pushHandoffTransport?: (transport: HubTransport) => HubTransport;
  /** How many forwards one spoke may ask of this host in a minute; absent, the service's own. */
  readonly pushMaxPerMinute?: number;
  /** The release keys this host trusts for a mirrored update feed; absent, it cannot check one. */
  readonly updateFeedVerifier?: ProvisionHostPorts["verifyUpdateSignature"];
  /** How long a proposal this host holds stays open; absent, the service's own. */
  readonly proposalLifetimeMs?: number;
  /** How many proposals this host holds; absent, the service's own. */
  readonly maxProposals?: number;
  /** How long one hub-link request waits before it counts as unreachable; absent, the service's own. A test cannot wait eight seconds. */
  readonly hubLinkTimeoutMs?: number;
}): Promise<HubTestHost> {
  const directory = mkdtempSync(join(tmpdir(), "octant-hub-"));
  input.cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const hostId = decodeStableHostId(randomUUID());
  const origin = `https://${input.address}:8443`;
  const connection = openSqlite(join(directory, "store.sqlite3"));
  const isoNow = () => new Date().toISOString();
  applyMigrations(connection, MIGRATIONS, isoNow);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: isoNow,
  });
  const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicDer = keys.publicKey.export({ format: "der", type: "spki" });
  const hostKeyFingerprint = createHash("sha256").update(publicDer).digest("hex");
  const signHostPayload = (payload: string) =>
    cryptoSign("sha256", Buffer.from(payload, "utf8"), {
      key: keys.privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");
  journal.append({
    aggregate: { aggregateType: "remote-host", aggregateId: hostId },
    expectedVersion: 0,
    events: [
      {
        eventId: randomUUID(),
        eventName: "remote.host-identity-initialized@1",
        eventVersion: 1,
        correlationId: randomUUID(),
        actor: { kind: "system", actorId: randomUUID() },
        occurredAt: isoNow(),
        payload: {
          hostId,
          displayName: input.name,
          hostKeyFingerprint,
          keyGeneration: 1,
          createdAt: isoNow(),
        },
      },
    ],
  });
  const certificate = createSelfMadeListenerCertificateStore({ dataDirectory: directory }).ensure(
    input.address,
  );
  if (certificate.status !== "ready") throw new Error(certificate.code);
  const identity: HubHostIdentity = {
    hostId,
    displayName: input.name,
    signing: {
      hostKeyFingerprint,
      hostPublicKey: publicDer.toString("base64url"),
      signHostPayload,
    },
  };
  const listener: PrivateListenerHostStatus = {
    enabled: true,
    state: "ready",
    hostname: input.address,
    port: 8443,
    origin,
    exposureClass: "tailscale",
    certificateFingerprint: hostKeyFingerprint,
    certificateReady: true,
    certificateSource: "self-made",
    tlsPin: certificate.tlsPin,
    ...input.listenerStatus,
  };

  const state = createHubStateStore(directory);
  const records: HubMembershipChangedPayload[] = [];
  const transport = createPinnedHubTransport(input.network.network);
  let gateway: RemoteGateway | undefined;
  const hubPairing = (): HubPairingPort | undefined => {
    const administration = gateway?.localDeviceAdministration();
    if (gateway === undefined || administration === undefined) return undefined;
    const current = gateway;
    return {
      createTicket: (sourceClass) => {
        const ticket = administration.createPairingTicket({ sourceClass });
        return {
          ticketId: String(ticket.ticketId),
          ticketProof: ticket.ticketProof,
          expiresAt: ticket.expiresAt,
        };
      },
      approvedDeviceFor: (ticket) => current.approvedPairingDevice(ticket),
      revokeDevice: (deviceId) => {
        administration.revokeDevice({ deviceId });
      },
      deviceKeyFingerprint: (deviceId) => current.pairedDeviceKeyFingerprint(deviceId),
      deviceActive: (deviceId) => deviceIsActive(administration, deviceId),
    };
  };
  const hub = new HubService({
    state,
    rosterKey: createRosterSigningKeyStore(directory),
    identity: () => identity,
    listener: () => listener,
    pairing: hubPairing,
    transport: input.hubTransport?.(transport) ?? transport,
    record: (change) => records.push(change),
    now: Date.now,
  });
  const spoke = new SpokeLinkService({
    state,
    identity: () => identity,
    listener: () => listener,
    transport: input.spokeTransport?.(transport) ?? transport,
    devices: () => {
      const administration = gateway?.localDeviceAdministration();
      if (gateway === undefined || administration === undefined) return undefined;
      const current = gateway;
      return {
        admitIntroducedDevice: (input) => current.admitIntroducedDevice(input),
        deviceLifecycle: (deviceId, now) =>
          deviceLifecycleAt(administration.listDevices(), deviceId, now),
        revokeDevice: (deviceId) => {
          administration.revokeDevice({ deviceId });
        },
        deviceActive: (deviceId) => deviceIsActive(administration, deviceId),
      };
    },
    record: (change) => records.push(change),
    serverBuildVersion: "0.1.0",
    now: input.now ?? input.wakeClock ?? Date.now,
  });
  // Moves this host's clock for the owner routes only, so a challenge can
  // outlive its minute without the test waiting for it.
  const clock = { offset: 0 };
  const ownerNow = () => Date.now() + clock.offset;
  const failover = new FailoverService({
    state,
    identity: () => identity,
    listener: () => listener,
    pairing: hubPairing,
    transport: input.failoverTransport?.(transport) ?? transport,
    spoke,
    record: (change) => records.push(change),
    now: Date.now,
    ...(input.hubLinkTimeoutMs === undefined ? {} : { linkTimeoutMs: input.hubLinkTimeoutMs }),
    noteHubWakeGeneration: (generation) => spokeWake.noteHubWakeGeneration(generation),
    ...(input.failoverAfterMs === undefined
      ? {}
      : { failoverAfterMs: () => input.failoverAfterMs }),
  });
  const wakeNow = input.wakeClock ?? Date.now;
  const magicPackets: Uint8Array[] = [];
  const wake = new WakeService({
    state,
    identity: () => identity,
    transport,
    wakeOnLan: {
      broadcast: async (packet) => {
        if (input.wakeSocketFails === true) return false;
        magicPackets.push(packet);
        return true;
      },
    },
    record: (change) => records.push(change),
    now: wakeNow,
    ...(input.wakeLeadMs === undefined ? {} : { leadMs: input.wakeLeadMs }),
  });
  const routines: WakeRoutineView[] = [];
  const schedulerPokes = { count: 0 };
  let routineSerial = 0;
  const makeSpokeWake = () =>
    new SpokeWakeService({
      state,
      identity: () => identity,
      transport: input.wakeTransport?.(transport) ?? transport,
      spoke,
      routines: () => routines,
      scheduler: {
        poke: () => {
          schedulerPokes.count += 1;
        },
      },
      hubUnreachable: () => failover.hubUnreachable(),
      record: (change) => records.push(change),
      now: wakeNow,
      // Distinct, well-formed ids so a test can tell routines apart without reading the map.
      newRoutineId: () => `routine${String((routineSerial += 1)).padStart(16, "0")}`,
    });
  let spokeWake = makeSpokeWake();
  // This host's own Notifications setting, which a test edits: off and the default gateway until it does.
  const pushSetting = { enabled: false, gatewayUrl: REMOTE_PUSH_GATEWAY_DEFAULT_URL };
  const push = new PushService({
    state,
    identity: () => identity,
    transport,
    gateway: () => pushSetting,
    record: (change) => records.push(change),
    now: wakeNow,
    ...(input.pushMaxPerMinute === undefined ? {} : { maxPerMinute: input.pushMaxPerMinute }),
    ...(input.hubLinkTimeoutMs === undefined ? {} : { linkTimeoutMs: input.hubLinkTimeoutMs }),
  });
  const spokePush = new SpokePushService({
    state,
    identity: () => identity,
    transport: input.pushHandoffTransport?.(transport) ?? transport,
    spoke,
    hubUnreachable: () => failover.hubUnreachable(),
    record: (change) => records.push(change),
    now: wakeNow,
    ...(input.hubLinkTimeoutMs === undefined ? {} : { linkTimeoutMs: input.hubLinkTimeoutMs }),
  });
  const pushDelivery = createHubPushDeliveryTransport({
    direct: createGatewayPushDeliveryTransport({
      settings: () => pushSetting,
      signing: () => identity.signing,
    }),
    settings: () => pushSetting,
    signing: () => identity.signing,
    handoff: () => ({
      granted: () => spokePush.granted(),
      hand: (delivery) => spokePush.hand(delivery),
    }),
  });
  // This host's own services for each kind of offer, as fakes a test reads: what the spoke
  // would install, add, or author is recorded here, and a test can make any of them fail.
  const provisioned: ProvisionedByOffer = {
    channel: undefined,
    plugins: [],
    profiles: [],
    endpoints: [],
    routines: [],
    fail: false,
  };
  const provision = new ProvisionService({
    state,
    identity: () => identity,
    transport,
    record: (change) => records.push(change),
    now: wakeNow,
  });
  const spokeProvision = new SpokeProvisionService({
    state,
    identity: () => identity,
    transport,
    spoke,
    ports: {
      updateChannel: {
        current: () => provisioned.channel,
        set: async (channel) => {
          if (provisioned.fail) return { status: "failed", kind: "apply-failed" };
          provisioned.channel = channel;
          return { status: "applied" };
        },
      },
      plugin: {
        install: async (offer) => {
          if (provisioned.fail) return { status: "failed", kind: "apply-failed" };
          // Installed only: untrusted and disabled, whatever the offer said.
          provisioned.plugins.push({
            entryId: String(offer.entryId),
            trusted: false,
            enabled: false,
          });
          return { status: "applied" };
        },
      },
      agentProfile: {
        add: async (offer) => {
          if (provisioned.fail) return { status: "failed", kind: "apply-failed" };
          provisioned.profiles.push({ displayName: offer.displayName });
          return { status: "applied" };
        },
      },
      modelEndpoint: {
        add: async (offer) => {
          if (provisioned.fail) return { status: "failed", kind: "apply-failed" };
          provisioned.endpoints.push({ displayName: offer.displayName, enabled: false });
          return { status: "applied" };
        },
      },
      routine: {
        author: async (offer, projectId) => {
          if (provisioned.fail) return { status: "failed", kind: "apply-failed" };
          provisioned.routines.push({
            displayName: offer.displayName,
            projectId,
            // The spoke's own window authors it, never the hub that offered it.
            authoredBy: "local-window",
          });
          return { status: "applied" };
        },
      },
      ...(input.updateFeedVerifier === undefined
        ? {}
        : { verifyUpdateSignature: input.updateFeedVerifier }),
    },
    record: (change) => records.push(change),
    now: wakeNow,
    ...(input.proposalLifetimeMs === undefined
      ? {}
      : { proposalLifetimeMs: input.proposalLifetimeMs }),
    ...(input.maxProposals === undefined ? {} : { maxProposals: input.maxProposals }),
  });
  const accounts: Record<HubSignInKind, SignInAccountState> = {
    "claude-subscription": "signed-out",
    "codex-subscription": "signed-out",
  };
  const signIn = new SignInService({
    state,
    identity: () => identity,
    transport,
    record: (change) => records.push(change),
    now: wakeNow,
  });
  const spokeSignIn = new SpokeSignInService({
    state,
    identity: () => identity,
    transport,
    spoke,
    ports: { accountState: async (kind) => accounts[kind] },
    record: (change) => records.push(change),
    now: wakeNow,
  });
  const hubLinkRoutes = createHubLinkRouteHandler({
    hub,
    spoke,
    failover,
    wake,
    spokeWake,
    push,
    spokePush,
    provision,
    spokeProvision,
    signIn,
    spokeSignIn,
    ...(input.wakeClock === undefined ? {} : { now: input.wakeClock }),
  });
  const credentials = new TestCredentialBroker();
  const postures = new TestPostureHost();
  const credentialCopy = new OwnerCredentialCopyService({
    broker: credentials,
    identity: () => identity,
    target: (memberId) => spoke.memberTarget(memberId),
    transport,
    authenticate: (request) => spoke.authenticatePeer(request),
    ownerIsCurrent: (ownerMemberId) => {
      const context = spoke.ownerContext();
      return (
        context !== undefined &&
        context.owners.some((owner) => String(owner.memberId) === ownerMemberId) &&
        !context.inactiveDeviceMemberIds.includes(ownerMemberId)
      );
    },
    record: (change) => records.push(change),
    now: Date.now,
  });
  const hubOwnerRoutes = createHubOwnerRouteHandler({
    hub,
    spoke,
    unlock: new OwnerUnlockService({ now: ownerNow, hostMemberId: () => hub.hubMemberId() }),
    postures,
    credentials: credentialCopy,
    provision: spokeProvision,
    signIn,
    spokeSignIn,
    record: (change) => records.push(change),
    now: ownerNow,
  });
  const peerCredentialRoutes = createPeerCredentialRouteHandler({ copy: credentialCopy });
  const delegationState = createDelegationStateStore(directory);
  const delegationRecords: HubDelegationRecordedPayload[] = [];
  const peerDelegationRoutes = createPeerDelegationRouteHandler({
    delegation: new PeerDelegationService({
      authenticate: (request) => spoke.authenticatePeer(request),
      currentPeer: (memberId) => spoke.currentPeer(memberId),
      host: input.delegationHost ?? NO_DELEGATION_HOST,
      state: delegationState,
      record: (change) => delegationRecords.push(change),
      now: Date.now,
    }),
  });
  const delegating = new DelegatingSpokeService({
    state: delegationState,
    identity: () => identity,
    target: (memberId) => spoke.memberTarget(memberId),
    transport: input.delegatingTransport?.(transport) ?? transport,
    parent: input.parent ?? NO_PARENT,
    record: (change) => delegationRecords.push(change),
    now: Date.now,
  });
  const hubLink = async (request: Request) =>
    (await hubLinkRoutes(request)) ??
    (await peerDelegationRoutes(request)) ??
    (await peerCredentialRoutes(request)) ??
    hubOwnerRoutes(request);

  let gatewayFetch:
    | ((request: Request, facts?: RequestTransportFacts) => Promise<Response>)
    | undefined;
  const serve: Serve = (serveOptions) => {
    gatewayFetch = serveOptions.fetch as typeof gatewayFetch;
    return { url: new URL(origin), stop: vi.fn(async () => {}) };
  };
  gateway = createRemoteGateway({
    connection,
    journal,
    hostId,
    displayName: input.name,
    serverBuildVersion: "0.1.0",
    signing: identity.signing,
    webAssets: () => Promise.resolve(new Response("web", { status: 200 })),
    hubLink,
    ...(input.productDispatch === undefined ? {} : { productDispatch: input.productDispatch }),
    serve,
    clock: isoNow,
    config: { listener: { hostname: input.address, port: 8443, origin, tls: certificate.tls } },
  });
  await gateway.start();
  input.cleanups.push(() => gateway?.stop());
  const administration = gateway.localDeviceAdministration();
  if (administration === undefined) throw new Error("No local administration.");

  const requests: string[] = [];
  const server: Server = createHttpsServer(certificate.tls, (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      requests.push(`${incoming.method} ${incoming.url?.split("?")[0]}`);
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (typeof value === "string") headers.set(name, value);
      }
      const body = chunks.length === 0 ? undefined : Buffer.concat(chunks);
      const request = new Request(`${origin}${incoming.url}`, {
        method: incoming.method ?? "GET",
        headers,
        ...(body === undefined ? {} : { body }),
      });
      void (async () => {
        if (gatewayFetch === undefined) throw new Error("The gateway is not serving.");
        const response = await gatewayFetch(request, tailscaleFacts);
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      })();
    });
  });
  server.on("tlsClientError", () => undefined);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No listener port.");
  input.network.register(input.address, address.port);
  input.cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );

  return {
    hostId: String(hostId),
    origin,
    address: input.address,
    name: input.name,
    directory,
    administration,
    gateway,
    hub,
    spoke,
    failover,
    wake,
    get spokeWake() {
      return spokeWake;
    },
    restartSpokeWake: () => {
      spokeWake = makeSpokeWake();
      return spokeWake;
    },
    push,
    spokePush,
    pushSetting,
    pushDelivery,
    provision,
    spokeProvision,
    provisioned,
    signIn,
    spokeSignIn,
    accounts,
    magicPackets,
    routines,
    schedulerPokes,
    state,
    records,
    delegationState,
    delegationRecords,
    delegating,
    credentials,
    postures,
    listener,
    requests,
    hubLink,
    signHostPayload,
    hostPublicKey: publicDer.toString("base64url"),
    privateKey: keys.privateKey,
    clock,
  };
}
