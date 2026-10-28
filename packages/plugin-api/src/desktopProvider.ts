/**
 * The desktop-provider contribution.
 *
 * A desktop provider creates, drives, and destroys throwaway desktops a thread
 * leases. The host owns leases, journaling, authority, approvals, teardown,
 * restart reconciliation, the screen stream, and evidence; a driver owns only
 * the translation to its provider. A driver imports only `@octant/contracts`
 * and this seam. Every operation answers with a discriminated result and
 * never throws for an expected outcome.
 */
import type {
  ComputerControlCommand,
  ComputerControlResult,
} from "@octant/contracts/computer-use-plugin";
import type {
  DesktopCredentialRef,
  DesktopHostTag,
  DesktopInputEvent,
  DesktopLeaseId,
  DesktopPlacementId,
  DesktopProviderId,
  DesktopProviderLocality,
  DesktopRecipe,
  UtcTimestamp,
} from "@octant/contracts";

export const DESKTOP_PROVIDER_CONTRIBUTION_KIND = "desktop-provider" as const;
export type DesktopProviderContributionKind = typeof DESKTOP_PROVIDER_CONTRIBUTION_KIND;

/**
 * The driver's reference to one desktop. `resource` is the provider's own id;
 * it never carries a stream URL or token, which stay inside the driver.
 * `credentialRef` names the account a cloud desktop lives in: the driver copies
 * it from the recipe it created the desktop for, and from the listing it found
 * the desktop in, so teardown after a restart reaches the right account.
 */
export interface DesktopHandle {
  readonly leaseId: DesktopLeaseId;
  readonly resource: string;
  readonly credentialRef?: DesktopCredentialRef;
}

/** `refused` is authority or configuration; `not-connected` is reach. */
type Unavailable =
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "not-connected" };

export type DesktopProviderStatusResult =
  | { readonly status: "ready" }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "not-connected" };

export interface DesktopAcquireRequest {
  readonly leaseId: DesktopLeaseId;
  readonly hostTag: DesktopHostTag;
  readonly recipe: DesktopRecipe;
  readonly expiresAt: UtcTimestamp;
  readonly signal: AbortSignal;
}

/**
 * `providerExpiresAt` is when the provider's own clock destroys the desktop.
 * A billed driver must set it to the lease expiry or later; the host refuses
 * to keep a billed desktop without it.
 */
export type DesktopAcquireResult =
  | {
      readonly status: "acquired";
      readonly handle: DesktopHandle;
      readonly providerExpiresAt?: UtcTimestamp;
    }
  | { readonly status: "cancelled" }
  | Unavailable;

/** `expiresAt` is the expiry the provider reports now, not the one requested. */
export type DesktopExtendResult =
  | { readonly status: "extended"; readonly expiresAt: UtcTimestamp }
  | Unavailable;

export interface DesktopFrame {
  readonly mediaType: "image/png" | "image/jpeg";
  readonly width: number;
  readonly height: number;
  readonly bytes: Uint8Array;
}

export type DesktopFrameResult =
  | { readonly status: "frame"; readonly frame: DesktopFrame }
  | Unavailable;

/**
 * The one refusal reason the host passes to a person: a screen, frame, or
 * input refused with it because the provider's route to the desktop right now
 * would let a third party read the session in transit, such as a relay that
 * can read what it carries. The Desktop tab says so and offers to try again.
 * Every other reason a driver gives stays with the host.
 */
export const DESKTOP_SESSION_READABLE = "session-readable" as const;

/**
 * The refusal reason a cloud driver gives when its provider answers that the
 * key the host attached is not accepted. The host records it on the lease, so
 * the recipe editor can tell the person the key was refused; the key itself
 * never reaches the driver.
 */
export const DESKTOP_CREDENTIAL_REJECTED = "credential-rejected" as const;

export type DesktopInputResult = { readonly status: "delivered" } | Unavailable;

/** A bounded frame source and an input sink the host streams on its own channel. */
export interface DesktopScreen {
  readonly frame: (signal?: AbortSignal) => Promise<DesktopFrameResult>;
  readonly input: (event: DesktopInputEvent) => Promise<DesktopInputResult>;
  readonly close: () => Promise<void>;
}

export type DesktopScreenResult =
  | { readonly status: "ready"; readonly screen: DesktopScreen }
  | Unavailable;

export type DesktopDeliverResult = { readonly status: "delivered" } | Unavailable;

/** Destroy was asked for. It is not proof; only `verifyGone` is. */
export type DesktopReleaseResult =
  | { readonly status: "released" }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "not-connected" };

export type DesktopVerifyGoneResult =
  | { readonly status: "gone" }
  | { readonly status: "present" }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "not-connected" };

export interface DesktopOwnedResource {
  readonly hostTag: DesktopHostTag;
  readonly handle: DesktopHandle;
}

export type DesktopListOwnedResult =
  | { readonly status: "listed"; readonly resources: ReadonlyArray<DesktopOwnedResource> }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "not-connected" };

/**
 * One place a provider runs a desktop, with its own consequences: a desktop on
 * this machine leaves nothing off it, one on another machine leaves through
 * the provider's relay, and one in the person's cloud bills. A recipe names
 * one, and the host takes the lease's locality and billing from it.
 * `choosesMachine` marks a placement that runs on one of the person's own
 * machines: its provider lists them through `listMachines`, and a recipe
 * names the one it runs on, which the driver receives as `recipe.machine`.
 */
export interface DesktopPlacement {
  readonly id: DesktopPlacementId;
  readonly displayName: string;
  readonly locality: DesktopProviderLocality;
  readonly billed: boolean;
  readonly choosesMachine?: boolean;
}

/** One of the person's machines a placement can run a desktop on, as the provider reports it. */
export interface DesktopMachineEntry {
  readonly id: string;
  readonly name: string;
  readonly online: boolean;
}

export type DesktopListMachinesResult =
  | { readonly status: "listed"; readonly machines: ReadonlyArray<DesktopMachineEntry> }
  | Unavailable;

export interface DesktopProvider {
  readonly kind: DesktopProviderContributionKind;
  readonly id: DesktopProviderId;
  readonly displayName: string;
  readonly locality: DesktopProviderLocality;
  /** Whether a lease spends the person's money. A person confirms every billed lease. */
  readonly billed: boolean;
  /**
   * The closed list of placements the provider offers, fixed in the driver's
   * code. A provider that declares any is leased only through a recipe that
   * names one of them; one that declares none is leased with its own
   * `locality` and `billed`.
   */
  readonly placements?: ReadonlyArray<DesktopPlacement>;
  /**
   * The HTTPS hosts a cloud provider's API answers on, fixed in the driver's
   * code. The host's {@link DesktopHttpsPort} sends nothing anywhere else. A
   * host-local provider declares none.
   */
  readonly hosts?: ReadonlyArray<string>;
  /**
   * The provider's local control daemon, fixed in the driver's code. The
   * host's {@link DesktopDaemonPort} connects to nothing else and sends no
   * other method.
   */
  readonly daemon?: DesktopDaemonDeclaration;
  /**
   * The person's machines a placement that `choosesMachine` can run a
   * desktop on, for a person choosing one in a recipe. It reads and creates
   * nothing.
   */
  readonly listMachines?: (
    placementId: DesktopPlacementId,
    signal: AbortSignal,
  ) => Promise<DesktopListMachinesResult>;
  /** Whether the provider can be used on this host now. Performs no work. */
  readonly status: () => Promise<DesktopProviderStatusResult>;
  /** Creates one desktop tagged with the lease id and host tag. */
  readonly acquire: (request: DesktopAcquireRequest) => Promise<DesktopAcquireResult>;
  readonly extend: (handle: DesktopHandle, expiresAt: UtcTimestamp) => Promise<DesktopExtendResult>;
  readonly screen: (handle: DesktopHandle) => Promise<DesktopScreenResult>;
  /** The `octant_computer` commands it supports; any other refuses `unsupported`. */
  readonly control: (
    handle: DesktopHandle,
    command: ComputerControlCommand,
  ) => Promise<ComputerControlResult>;
  /**
   * Writes one read-only file into the desktop's inbox under `name`, replacing
   * a file an earlier transfer left there. `name` is one file name the host
   * already checked; the bytes are exactly the ones the host hashed and
   * journaled.
   */
  readonly deliver: (
    handle: DesktopHandle,
    name: string,
    bytes: Uint8Array,
  ) => Promise<DesktopDeliverResult>;
  readonly release: (handle: DesktopHandle) => Promise<DesktopReleaseResult>;
  readonly verifyGone: (handle: DesktopHandle) => Promise<DesktopVerifyGoneResult>;
  /**
   * Every tagged desktop the provider holds for `hostTag`, for restart
   * reconciliation. A provider that needs a credential lists the account
   * `credentialRef` names, and with none answers `failed`: an answer of
   * `listed` is the provider confirming every other desktop is absent.
   */
  readonly listOwned: (
    hostTag: DesktopHostTag,
    credentialRef?: DesktopCredentialRef,
  ) => Promise<DesktopListOwnedResult>;
}

/**
 * One confined launch the host runs for a host-local desktop. The driver
 * names the program and its arguments; the host owns everything else: the
 * dedicated Bubblewrap capsule, its environment, its private home and inbox,
 * its network namespace, and the process-group receipt that lets a restarted
 * host reap it. The launch's standard streams are its only channel: `output`
 * receives what it writes to standard output, and `write` feeds its standard
 * input. Its standard error is discarded.
 */
export interface DesktopLaunchRequest {
  readonly leaseId: DesktopLeaseId;
  /** Recorded with the desktop so `listOwned` finds it under the tag it was made for. */
  readonly hostTag: DesktopHostTag;
  /** A program name the host resolves on the desktop's own search path, never a path. */
  readonly program: string;
  readonly args: ReadonlyArray<string>;
  readonly output: (chunk: Uint8Array) => void;
  readonly signal: AbortSignal;
}

export type DesktopLaunchWriteResult =
  | { readonly status: "written" }
  | { readonly status: "closed" };

export interface LaunchedDesktop {
  readonly write: (bytes: Uint8Array) => Promise<DesktopLaunchWriteResult>;
  /** Settles once the launch's process has exited, for any reason. */
  readonly exited: Promise<void>;
}

/**
 * `refused` covers a lease the host is not provisioning, a lease that already
 * has a desktop, and a program the host cannot find.
 */
export type DesktopLaunchResult =
  | { readonly status: "launched"; readonly desktop: LaunchedDesktop }
  | { readonly status: "cancelled" }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string };

export type DesktopLaunchListResult =
  | { readonly status: "listed"; readonly leaseIds: ReadonlyArray<DesktopLeaseId> }
  | { readonly status: "failed"; readonly reason: string };

/**
 * The capability-scoped port a host-local driver receives in place of process
 * or filesystem access. It launches only for a lease the host is provisioning,
 * at most one desktop per lease, and only as the host's dedicated desktop
 * capsule. `stop` destroys the launch and deletes its lease directory; `inspect`
 * reports `gone` only once no process of the desktop and none of its files
 * remain. `deliver` is the only way a file reaches the desktop's inbox.
 */
export interface DesktopLaunchPort {
  /** Whether this host can run a desktop that needs `programs`. Performs no work. */
  readonly readiness: (programs: ReadonlyArray<string>) => DesktopProviderStatusResult;
  readonly launch: (request: DesktopLaunchRequest) => Promise<DesktopLaunchResult>;
  readonly stop: (leaseId: DesktopLeaseId) => Promise<DesktopReleaseResult>;
  readonly inspect: (leaseId: DesktopLeaseId) => Promise<DesktopVerifyGoneResult>;
  /**
   * Writes one file, read-only, into a running desktop's inbox under `name`,
   * which must be one plain file name. It never writes anywhere else, and it
   * refuses a lease with no running desktop.
   */
  readonly deliver: (
    leaseId: DesktopLeaseId,
    name: string,
    bytes: Uint8Array,
  ) => Promise<DesktopDeliverResult>;
  /** Leases with a desktop, or what is left of one, made under `hostTag`. */
  readonly listOwned: (hostTag: DesktopHostTag) => Promise<DesktopLaunchListResult>;
}

/**
 * The only operations the host's teardown path holds. A driver kept loaded
 * after its recipe, credential, or plugin was revoked is held as this, so it
 * can destroy and verify but never acquire, extend, read the screen, or send
 * input.
 */
export type DesktopTeardownPort = Pick<
  DesktopProvider,
  "id" | "release" | "verifyGone" | "listOwned"
>;

/**
 * How the host attaches a cloud provider's API key to one call. The driver
 * names the recipe's credential reference and the header its provider reads;
 * the host reads the key from its credential store and sets it, so the driver
 * never holds the key.
 */
export interface DesktopHttpsCredential {
  readonly ref: DesktopCredentialRef;
  readonly header: string;
  readonly scheme?: "Bearer";
}

export interface DesktopHttpsRequest {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
  /** Absent sends no key: a call to a desktop's own endpoint carries the driver's token instead. */
  readonly credential?: DesktopHttpsCredential;
  /** The most response bytes this call needs. The host's own bound still applies. */
  readonly maxResponseBytes: number;
  readonly signal?: AbortSignal;
}

/**
 * `answered` is any HTTP status, error statuses included; the body is read
 * whole and bounded. `refused` is the host declining before anything left:
 * a host the driver did not declare, a credential no lease of this provider
 * recorded, a credential the store does not hold, a body over the bound, or
 * a header or method the host will not send.
 */
export type DesktopHttpsResult =
  | {
      readonly status: "answered";
      readonly httpStatus: number;
      /** Response headers, names lower-cased. */
      readonly headers: Readonly<Record<string, string>>;
      readonly body: Uint8Array;
    }
  | {
      readonly status: "refused";
      readonly reason:
        | "host-not-declared"
        | "credential-not-permitted"
        | "credential-missing"
        | "request-too-large"
        | "request-invalid";
    }
  | {
      readonly status: "failed";
      readonly reason: "unreachable" | "timed-out" | "redirected" | "response-too-large";
    }
  | { readonly status: "cancelled" };

/**
 * The capability-scoped port a cloud driver receives in place of network
 * access. It reaches only HTTPS on the default port of a host the driver
 * declares, never follows a redirect, bounds every call in time and bytes,
 * and attaches a credential only when one of this provider's leases recorded
 * that reference. A driver imports no network module of its own.
 */
export interface DesktopHttpsPort {
  readonly request: (request: DesktopHttpsRequest) => Promise<DesktopHttpsResult>;
}

/**
 * Whether a call may go to `url`: HTTPS, on the default port, with no
 * credentials in the URL, to one of `hosts`. `*.example.com` matches every
 * subdomain of `example.com`, never `example.com` itself.
 */
export function desktopProviderHostDeclared(url: string, hosts: ReadonlyArray<string>): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (target.protocol !== "https:" || target.port !== "") return false;
  if (target.username !== "" || target.password !== "") return false;
  const hostname = target.hostname.toLowerCase();
  return hosts.some((entry) => {
    const host = entry.toLowerCase();
    if (host.startsWith("*.")) {
      const domain = host.slice(2);
      return hostname.endsWith(`.${domain}`);
    }
    return hostname === host;
  });
}

/**
 * Where a provider's local control daemon listens and what a driver may ask
 * it. `socketPath` is relative to the home directory of the user Octant runs
 * as (`.cua/cua.sock`). Each method is a request path the daemon serves, such
 * as `/cua.daemon.v1.SpaceService/CreateSpace`; one segment may be `*` for a
 * value the daemon minted, such as a session key.
 */
export interface DesktopDaemonDeclaration {
  readonly socketPath: string;
  readonly methods: ReadonlyArray<string>;
}

/**
 * One gRPC-Web call with one request message. The host frames `message`,
 * writes every header itself, and takes none from the driver, so a driver
 * cannot send a credential or a header the daemon trusts as a caller's
 * identity.
 */
export interface DesktopDaemonRequest {
  readonly method: string;
  /** One serialized protobuf message, unframed. */
  readonly message: Uint8Array;
  /**
   * The largest response this call needs: the one message of a unary call,
   * or every message of a stream together. The host's own bound still applies.
   */
  readonly maxResponseBytes: number;
  /**
   * The method streams its answer (a server-streaming RPC). The host reads
   * the whole stream to its status, inside the same time and byte bounds, so
   * only a stream the daemon ends on its own is answered.
   */
  readonly stream?: boolean;
  readonly signal?: AbortSignal;
}

/**
 * `answered` is any gRPC status, errors included, with the response message
 * (empty when the daemon sent none), every message in order (at most one for
 * a unary call), and the status message as the daemon wrote it. `refused` is
 * the host declining before anything was sent: a method the driver did not
 * declare, a socket that fails the host's checks, a message over the bound,
 * or a request carrying anything but the fields above. `failed` is the
 * daemon not answering, too slowly, too much, or with something that is not
 * one gRPC-Web answer.
 */
export type DesktopDaemonResult =
  | {
      readonly status: "answered";
      readonly grpcStatus: number;
      readonly grpcMessage: string;
      readonly message: Uint8Array;
      readonly messages: ReadonlyArray<Uint8Array>;
    }
  | {
      readonly status: "refused";
      readonly reason:
        | "method-not-declared"
        | "socket-unsafe"
        | "request-too-large"
        | "request-invalid";
    }
  | {
      readonly status: "failed";
      readonly reason:
        | "daemon-unreachable"
        | "timed-out"
        | "response-too-large"
        | "response-invalid";
    }
  | { readonly status: "cancelled" };

/**
 * The capability-scoped port a driver receives in place of a socket. It
 * reaches only the Unix socket the driver declares, under the home of the
 * user Octant runs as, after checking who owns it and its directories; never
 * the daemon's loopback TCP listener or a token file. It sends only declared
 * methods, bounds every call in time and bytes, and answers as a value.
 */
export interface DesktopDaemonPort {
  readonly call: (request: DesktopDaemonRequest) => Promise<DesktopDaemonResult>;
}

const DAEMON_LITERAL_SEGMENT = /^[A-Za-z0-9._-]{1,256}$/;
const DAEMON_MINTED_SEGMENT = /^[A-Za-z0-9._~-]{1,256}$/;

/**
 * Whether `method` is one of `methods`: the same segments, where a declared
 * `*` stands for exactly one segment of letters, digits, `.`, `_`, `~`, or
 * `-` that is not `.` or `..`. A declaration with an empty segment or more
 * than one `*` declares nothing.
 */
export function desktopDaemonMethodDeclared(
  method: string,
  methods: ReadonlyArray<string>,
): boolean {
  if (!method.startsWith("/") || method.length > 1_024) return false;
  const called = method.slice(1).split("/");
  return methods.some((declared) => {
    if (!declared.startsWith("/")) return false;
    const segments = declared.slice(1).split("/");
    if (segments.filter((segment) => segment === "*").length > 1) return false;
    if (segments.length !== called.length) return false;
    return segments.every((segment, index) => {
      const value = called[index];
      if (value === undefined || value === "." || value === "..") return false;
      if (segment === "*") return DAEMON_MINTED_SEGMENT.test(value);
      return segment !== "." && segment !== ".." && DAEMON_LITERAL_SEGMENT.test(segment)
        ? value === segment
        : false;
    });
  });
}

export {
  ProtobufWriter,
  readProtobuf,
  type ProtobufField,
  type ProtobufReadResult,
} from "./protobufWire";

export {
  maxDesktopFrameBytes,
  pngDimensions,
  SCREENSHOT_DESKTOP_APP_ID,
  ScreenshotDesktopControl,
  x11Keysym,
  type ScreenshotDesktopLaunch,
  type ScreenshotDesktopSurface,
} from "./desktopScreenshotControl";
