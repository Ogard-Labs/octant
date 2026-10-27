/**
 * The Cua Spaces desktop provider: a disposable desktop in a Cua Space, a
 * QEMU VM the person's own `cua daemon` runs on this machine.
 *
 * It is a plugin-shaped driver. It imports only `@octant/contracts` and the
 * desktop-provider seam and reaches Cua only through the
 * {@link DesktopDaemonPort} the host gives it, which connects to nothing but
 * the daemon's Unix socket under the home of the user Octant runs as and
 * sends only the methods declared in {@link CUA_DESKTOP_DAEMON}. Octant holds
 * no Cua credential: the daemon keeps the person's sign-in, and the Space's
 * own token stays in the daemon, which attaches it to calls through its env
 * passthrough. The passthrough key `ConnectSpace` returns stays in this
 * driver's memory and is never journaled.
 *
 * Every Space is created with the lease id as its `create_id` and in its
 * labels with the host's tag, with a daemon lifetime past the lease expiry,
 * so a restarted host finds what it left by listing those labels, and a host
 * that never comes back has its Space reaped when the daemon next runs.
 *
 * The rules are in docs/design/disposable-desktops.md ("Cua Spaces through
 * the local daemon").
 */
import type { ComputerControlResult } from "@octant/contracts/computer-use-plugin";
import {
  decodeDesktopLeaseId,
  decodeDesktopPlacementId,
  decodeDesktopProviderId,
  decodeUtcTimestamp,
  type DesktopHostTag,
  type DesktopInputEvent,
  type DesktopLeaseId,
  type DesktopRecipe,
  type UtcTimestamp,
} from "@octant/contracts";
import {
  maxDesktopFrameBytes,
  pngDimensions,
  ScreenshotDesktopControl,
  x11Keysym,
  type DesktopDaemonDeclaration,
  type DesktopDaemonPort,
  type DesktopDaemonResult,
  type DesktopFrameResult,
  type DesktopHandle,
  type DesktopInputResult,
  type DesktopOwnedResource,
  type DesktopPlacement,
  type DesktopProvider,
} from "@octant/plugin-api/desktop-provider";
import {
  CUA_KEY_F1,
  CUA_NAMED_KEYS,
  cuaBeginUploadRequest,
  cuaCancelCreateRequest,
  cuaCommitUploadRequest,
  cuaCreateSpaceRequest,
  cuaGetCapabilitiesRequest,
  cuaGetInfoRequest,
  cuaKeyRequest,
  cuaListSpacesRequest,
  cuaMoveRequest,
  cuaPointerRequest,
  cuaScreenshotRequest,
  cuaSetLifetimeRequest,
  cuaSpaceRequest,
  cuaStartProcessRequest,
  cuaTypeRequest,
  cuaUploadChunkRequest,
  readCuaBeginUpload,
  readCuaCommitUpload,
  readCuaConnect,
  readCuaCreateSpace,
  readCuaGetInfo,
  readCuaLifetime,
  readCuaListSpaces,
  readCuaProcessRun,
  readCuaProtocolVersion,
  readCuaResolve,
  readCuaScreenshot,
  readCuaUploadChunk,
  type CuaKey,
  type CuaPointer,
  type CuaSpace,
} from "./cuaProtocol";

export const CUA_DESKTOP_PROVIDER_ID = decodeDesktopProviderId("cua");
/** The one placement offered now: a Space on this machine (decisions C5 and C7). */
export const CUA_THIS_MACHINE_PLACEMENT = decodeDesktopPlacementId("this-machine");
export const CUA_DESKTOP_PLACEMENTS: ReadonlyArray<DesktopPlacement> = [
  {
    id: CUA_THIS_MACHINE_PLACEMENT,
    displayName: "This machine",
    locality: "host-local",
    billed: false,
  },
];

const SPACE = "/cua.daemon.v1.SpaceService";
const ENV = "/v1/spaces/*/env/cua.env.v1";
/**
 * Everything this driver may ask Cua's daemon. No sharing, cloud-linking,
 * budget, batch, MCP, tool-call, or shutdown method is here, so the host's
 * port refuses them whatever the driver sends.
 */
export const CUA_DESKTOP_DAEMON: DesktopDaemonDeclaration = {
  socketPath: ".cua/cua.sock",
  methods: [
    "/cua.daemon.v1.DaemonService/GetInfo",
    `${SPACE}/CreateSpace`,
    `${SPACE}/CancelCreateSpace`,
    `${SPACE}/SetSpaceLifetime`,
    `${SPACE}/DeleteSpace`,
    `${SPACE}/ListSpaces`,
    `${SPACE}/ResolveSpace`,
    `${SPACE}/ConnectSpace`,
    `${ENV}.SystemService/GetCapabilities`,
    `${ENV}.ComputerService/Screenshot`,
    `${ENV}.ComputerService/Pointer`,
    `${ENV}.ComputerService/Keyboard`,
    `${ENV}.FilesystemService/BeginUpload`,
    `${ENV}.FilesystemService/UploadChunk`,
    `${ENV}.FilesystemService/CommitUpload`,
    `${ENV}.FilesystemService/Move`,
    `${ENV}.ProcessService/StartProcess`,
  ],
};

/** The labels a Space is tagged with. */
export const CUA_LEASE_LABEL = "octant-lease";
export const CUA_HOST_LABEL = "octant-host";
/** The daemon release this driver was written against (Cua's workspace version at 8fbdf83). */
export const CUA_MINIMUM_DAEMON_VERSION = "0.9.0";
/** The `cua.env.v1` major version this driver speaks. */
const CUA_ENV_PROTOCOL_VERSION = 1;
/** Cua's canonical Linux image, whose VM variant `kind` `vm` selects. */
export const CUA_DEFAULT_IMAGE = "ghcr.io/trycua/linux:24.04";
/**
 * The daemon's lifetime runs this long past the lease expiry, so the host's
 * own clock ends a lease first and the daemon ends a Space the host never
 * returned to.
 */
const LIFETIME_MARGIN_MS = 120_000;
const MAX_CONTROL_RESPONSE_BYTES = 1_048_576;
/** The largest upload chunk sent, under the host port's 4 MiB request bound. */
const MAX_UPLOAD_CHUNK_BYTES = 1_048_576;
const SPACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ENV_KEY = /^[A-Za-z0-9._~-]{1,256}$/;
const ENV_URL = /^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/v1\/spaces\/([^/]+)\/env\/?$/;
const INBOX = "/home/user/inbox";
const INCOMING = "/home/user/.octant-incoming";
/** gRPC's status for a Space the daemon does not know. */
const GRPC_NOT_FOUND = 5;

/**
 * Copies a sent file out of the inbox, makes the copy executable by the
 * desktop's user only, and starts it in its own session, so nothing in the
 * inbox ever runs and the app outlives the process that started it.
 */
const LAUNCH_APP = `set -eu
apps="$HOME/.octant-apps"
mkdir -p -- "$apps"
rm -f -- "$apps/$2"
cp -- "$1/$2" "$apps/$2"
chmod 0500 -- "$apps/$2"
cd "$HOME"
setsid "$apps/$2" </dev/null >/dev/null 2>&1 &
echo "$!"`;

export interface CuaDesktopProviderOptions {
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** How often a new Space is asked whether it runs with its in-guest agent. */
  readonly readyPollMs?: number;
  /** How long a new Space may take to boot before the acquire fails. */
  readonly readyWithinMs?: number;
}

interface Session {
  readonly spaceId: string;
  /** The env passthrough key `ConnectSpace` minted; never journaled. */
  readonly envKey: string;
  readonly screen: DesktopRecipe["screen"];
  readonly control: ScreenshotDesktopControl;
  /** The latest frame, whose pixels a person's or agent's input points at. */
  lastFrame?: { readonly screenshotId: string; readonly width: number; readonly height: number };
}

/** One daemon call, as the driver acts on it. */
type Called =
  | {
      readonly kind: "ok";
      readonly message: Uint8Array;
      readonly messages: ReadonlyArray<Uint8Array>;
    }
  | { readonly kind: "grpc-error"; readonly code: number }
  | { readonly kind: "unreachable" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "failed"; readonly reason: string };

const failed = (reason: string) => ({ status: "failed" as const, reason });

function called(result: DesktopDaemonResult): Called {
  switch (result.status) {
    case "answered":
      return result.grpcStatus === 0
        ? { kind: "ok", message: result.message, messages: result.messages }
        : { kind: "grpc-error", code: result.grpcStatus };
    case "cancelled":
      return { kind: "cancelled" };
    case "refused":
      return result.reason === "socket-unsafe"
        ? { kind: "unreachable" }
        : { kind: "failed", reason: result.reason };
    case "failed":
      return result.reason === "daemon-unreachable"
        ? { kind: "unreachable" }
        : { kind: "failed", reason: result.reason };
  }
}

/** A Space's name, so a Space still being created, which has no labels yet, is recognized. */
const spaceName = (leaseId: DesktopLeaseId): string => `octant-${String(leaseId).toLowerCase()}`;

function iso(milliseconds: number): UtcTimestamp | undefined {
  try {
    return decodeUtcTimestamp(new Date(milliseconds).toISOString());
  } catch {
    return undefined;
  }
}

/** Whether `version` is a release at or after `minimum`, reading only its leading numbers. */
function atLeast(version: string, minimum: string): boolean {
  const parts = (value: string) =>
    /^v?([0-9]+)\.([0-9]+)\.([0-9]+)/.exec(value)?.slice(1, 4).map(Number);
  const have = parts(version);
  const need = parts(minimum);
  if (have === undefined || need === undefined) return false;
  for (let index = 0; index < 3; index += 1) {
    const left = have[index] ?? 0;
    const right = need[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

/** The key a Desktop tab names, as Cua's `KeyInput`, from the same closed set an X desktop maps. */
function cuaKey(key: string): CuaKey | undefined {
  if (x11Keysym(key) === undefined) return undefined;
  if (Object.hasOwn(CUA_NAMED_KEYS, key)) {
    const named = CUA_NAMED_KEYS[key];
    return named === undefined ? undefined : { named };
  }
  const functionKey = /^F([1-9]|1[0-2])$/.exec(key);
  if (functionKey !== null) return { named: CUA_KEY_F1 + Number(functionKey[1]) - 1 };
  return key.length === 1 ? { character: key } : undefined;
}

/** Whether a listed Space is the one this host made for `leaseId`. */
function spaceOfLease(space: CuaSpace, leaseId: DesktopLeaseId): boolean {
  return space.labels.get(CUA_LEASE_LABEL) === String(leaseId);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", copy));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createCuaDesktopProvider(
  daemon: DesktopDaemonPort,
  options: CuaDesktopProviderOptions = {},
): DesktopProvider {
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const readyPollMs = options.readyPollMs ?? 2_000;
  const readyWithinMs = options.readyWithinMs ?? 300_000;
  const sessions = new Map<string, Session>();

  const call = async (
    method: string,
    message: Uint8Array,
    extra: {
      readonly maxResponseBytes?: number;
      readonly stream?: boolean;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<Called> =>
    called(
      await daemon.call({
        method,
        message,
        maxResponseBytes: extra.maxResponseBytes ?? MAX_CONTROL_RESPONSE_BYTES,
        ...(extra.stream === true ? { stream: true } : {}),
        ...(extra.signal === undefined ? {} : { signal: extra.signal }),
      }),
    );

  const env = (session: Pick<Session, "envKey">, service: string) =>
    `/v1/spaces/${session.envKey}/env/cua.env.v1.${service}`;

  /** Asks the daemon to stop a create still running for `leaseId` and to delete what it made. */
  async function discard(leaseId: DesktopLeaseId, spaceId: string | undefined): Promise<void> {
    await call(`${SPACE}/CancelCreateSpace`, cuaCancelCreateRequest(String(leaseId)));
    if (spaceId !== undefined) await call(`${SPACE}/DeleteSpace`, cuaSpaceRequest(spaceId));
  }

  /**
   * Every Space the daemon reports for the person's account, only when the
   * daemon could read all of it: without `known_now` it waits for every
   * machine and fails rather than answer partly.
   */
  async function completeListing(): Promise<
    | {
        readonly status: "listed";
        readonly spaces: ReadonlyArray<CuaSpace>;
        readonly creating: ReadonlyArray<string>;
      }
    | { readonly status: "failed"; readonly reason: string }
    | { readonly status: "not-connected" }
  > {
    const listed = await call(`${SPACE}/ListSpaces`, cuaListSpacesRequest());
    if (listed.kind === "unreachable") return { status: "not-connected" };
    if (listed.kind !== "ok") return failed("list-failed");
    const read = readCuaListSpaces(listed.message);
    if (read === undefined) return failed("list-unreadable");
    if (!read.complete) return failed("list-partial");
    return { status: "listed", spaces: read.spaces, creating: read.creating };
  }

  /** The daemon's lifetime for a Space, set to end `at` plus the margin. */
  async function setLifetime(
    spaceId: string,
    at: UtcTimestamp,
  ): Promise<number | "unreachable" | undefined> {
    const lifetime = await call(
      `${SPACE}/SetSpaceLifetime`,
      cuaSetLifetimeRequest(spaceId, Date.parse(at) + LIFETIME_MARGIN_MS - now()),
    );
    if (lifetime.kind === "unreachable") return "unreachable";
    return lifetime.kind === "ok" ? readCuaLifetime(lifetime.message) : undefined;
  }

  /** Waits until a new Space runs with its in-guest agent and carries what was asked. */
  async function untilReady(
    spaceId: string,
    request: { readonly leaseId: DesktopLeaseId; readonly hostTag: DesktopHostTag },
    signal: AbortSignal,
  ): Promise<"ready" | "cancelled" | "mismatched" | "not-ready"> {
    const deadline = now() + readyWithinMs;
    for (;;) {
      if (signal.aborted) return "cancelled";
      const resolved = await call(`${SPACE}/ResolveSpace`, cuaSpaceRequest(spaceId), { signal });
      if (resolved.kind === "cancelled") return "cancelled";
      if (resolved.kind === "ok") {
        const current = readCuaResolve(resolved.message);
        if (current === undefined) return "not-ready";
        // A Space the daemon placed or tagged otherwise than asked is out of
        // what this placement promised the person.
        if (
          current.id !== spaceId ||
          current.labels.get(CUA_LEASE_LABEL) !== String(request.leaseId) ||
          current.labels.get(CUA_HOST_LABEL) !== String(request.hostTag) ||
          current.cloud !== "" ||
          (current.kind !== "" && current.kind !== "vm")
        ) {
          return "mismatched";
        }
        if (current.powerState === "running" && current.spacesdVersion !== "") return "ready";
      } else if (resolved.kind !== "grpc-error") {
        return "not-ready";
      }
      if (now() >= deadline) return "not-ready";
      await sleep(readyPollMs);
    }
  }

  /** Runs one program in the Space to its end, as an argument list with no shell of Octant's. */
  async function run(
    session: Session,
    command: string,
    args: ReadonlyArray<string>,
  ): Promise<{ readonly exitCode: number; readonly stdout: string } | "unreachable" | undefined> {
    const ran = await call(
      env(session, "ProcessService/StartProcess"),
      cuaStartProcessRequest(command, args),
      { stream: true },
    );
    if (ran.kind === "unreachable") return "unreachable";
    return ran.kind === "ok" ? readCuaProcessRun(ran.messages) : undefined;
  }

  async function frameOf(session: Session, signal?: AbortSignal): Promise<DesktopFrameResult> {
    if (signal?.aborted === true) return failed("cancelled");
    const taken = await call(
      env(session, "ComputerService/Screenshot"),
      cuaScreenshotRequest(Math.max(session.screen.width, session.screen.height)),
      {
        maxResponseBytes: maxDesktopFrameBytes(session.screen) + 4_096,
        ...(signal === undefined ? {} : { signal }),
      },
    );
    if (taken.kind === "unreachable") return { status: "not-connected" };
    if (taken.kind !== "ok") return failed("frame-unavailable");
    const shot = readCuaScreenshot(taken.message);
    // PNG is ImageFormat 1; unspecified (0) is PNG as well.
    if (shot === undefined || (shot.format !== 0 && shot.format !== 1)) {
      return failed("frame-unavailable");
    }
    const size = pngDimensions(shot.image);
    if (
      size === undefined ||
      size.width < 1 ||
      size.height < 1 ||
      size.width > session.screen.width ||
      size.height > session.screen.height ||
      !ENV_KEY.test(shot.screenshotId)
    ) {
      return failed("frame-out-of-bounds");
    }
    session.lastFrame = { screenshotId: shot.screenshotId, width: size.width, height: size.height };
    return {
      status: "frame",
      frame: { mediaType: "image/png", width: size.width, height: size.height, bytes: shot.image },
    };
  }

  async function inputTo(session: Session, event: DesktopInputEvent): Promise<DesktopInputResult> {
    const frame = session.lastFrame;
    const inside = (x: number, y: number) =>
      frame !== undefined && x >= 0 && y >= 0 && x < frame.width && y < frame.height;
    let sent: Called;
    switch (event.kind) {
      case "pointer":
      case "scroll": {
        // A point names a pixel of the frame the person or agent saw.
        if (frame === undefined) return { status: "refused", reason: "no-frame" };
        if (!inside(event.x, event.y)) return { status: "refused", reason: "outside-screen" };
        const pointer: CuaPointer =
          event.kind === "scroll"
            ? {
                action: "scroll",
                x: event.x,
                y: event.y,
                deltaX: event.deltaX,
                deltaY: event.deltaY,
              }
            : event.action === "move"
              ? { action: "move", x: event.x, y: event.y }
              : { action: event.action, x: event.x, y: event.y, button: event.button ?? "left" };
        sent = await call(
          env(session, "ComputerService/Pointer"),
          cuaPointerRequest(frame.screenshotId, pointer),
        );
        break;
      }
      case "key": {
        const key = cuaKey(event.key);
        if (key === undefined) return { status: "refused", reason: "unsupported-key" };
        sent = await call(
          env(session, "ComputerService/Keyboard"),
          cuaKeyRequest(event.action, key),
        );
        break;
      }
      case "text":
        sent = await call(env(session, "ComputerService/Keyboard"), cuaTypeRequest(event.text));
        break;
    }
    if (sent.kind === "unreachable") return { status: "not-connected" };
    return sent.kind === "ok" ? { status: "delivered" } : failed("input-failed");
  }

  /** Uploads `bytes` to `path` in chunks, read-only, and checks what the Space committed. */
  async function upload(
    session: Session,
    path: string,
    bytes: Uint8Array,
  ): Promise<"written" | "unreachable" | "failed"> {
    const sha256 = await sha256Hex(bytes);
    const begun = await call(
      env(session, "FilesystemService/BeginUpload"),
      cuaBeginUploadRequest({
        path,
        permissions: 0o444,
        size: bytes.byteLength,
        sha256,
        uploadId: globalThis.crypto.randomUUID(),
      }),
    );
    if (begun.kind === "unreachable") return "unreachable";
    const started = begun.kind === "ok" ? readCuaBeginUpload(begun.message) : undefined;
    if (started === undefined || !ENV_KEY.test(started.uploadId) || started.receivedBytes !== 0) {
      return "failed";
    }
    const chunk = Math.min(
      MAX_UPLOAD_CHUNK_BYTES,
      started.maxChunkBytes > 0 ? started.maxChunkBytes : MAX_UPLOAD_CHUNK_BYTES,
    );
    for (let offset = 0; offset < bytes.byteLength; offset += chunk) {
      const piece = bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunk));
      const sent = await call(
        env(session, "FilesystemService/UploadChunk"),
        cuaUploadChunkRequest(started.uploadId, offset, piece),
      );
      if (sent.kind === "unreachable") return "unreachable";
      if (sent.kind !== "ok" || readCuaUploadChunk(sent.message) !== offset + piece.byteLength) {
        return "failed";
      }
    }
    const committed = await call(
      env(session, "FilesystemService/CommitUpload"),
      cuaCommitUploadRequest(started.uploadId, sha256),
    );
    if (committed.kind === "unreachable") return "unreachable";
    return committed.kind === "ok" && readCuaCommitUpload(committed.message) === sha256
      ? "written"
      : "failed";
  }

  function sessionOf(handle: DesktopHandle): Session | undefined {
    return sessions.get(handle.resource);
  }

  const provider: DesktopProvider = {
    kind: "desktop-provider",
    id: CUA_DESKTOP_PROVIDER_ID,
    displayName: "Cua Spaces",
    locality: "host-local",
    billed: false,
    placements: CUA_DESKTOP_PLACEMENTS,
    daemon: CUA_DESKTOP_DAEMON,
    // The daemon is the person's to install, start, and sign in; Octant only
    // checks that it answers and is a release this driver was written for.
    status: async () => {
      const info = await call("/cua.daemon.v1.DaemonService/GetInfo", cuaGetInfoRequest());
      if (info.kind === "unreachable") return { status: "not-connected" };
      if (info.kind !== "ok") return { status: "refused", reason: "daemon-unreadable" };
      const read = readCuaGetInfo(info.message);
      if (read === undefined) return { status: "refused", reason: "daemon-unreadable" };
      if (!atLeast(read.version, CUA_MINIMUM_DAEMON_VERSION)) {
        return { status: "refused", reason: "daemon-too-old" };
      }
      return read.features.includes("spaces")
        ? { status: "ready" }
        : { status: "refused", reason: "spaces-unavailable" };
    },
    acquire: async (request) => {
      if (request.signal.aborted) return { status: "cancelled" };
      const { recipe, leaseId } = request;
      if (String(recipe.placementId ?? "") !== String(CUA_THIS_MACHINE_PLACEMENT)) {
        return { status: "refused", reason: "placement-not-offered" };
      }
      // A QEMU guest with user networking can reach the host's loopback, and
      // so the Octant server, until a live check shows otherwise (C7).
      if (recipe.network !== "none") return { status: "refused", reason: "network-not-offered" };
      if (recipe.credentialRef !== undefined) {
        return { status: "refused", reason: "credential-not-used" };
      }
      const created = await call(
        `${SPACE}/CreateSpace`,
        cuaCreateSpaceRequest({
          image: recipe.image ?? CUA_DEFAULT_IMAGE,
          name: spaceName(leaseId),
          createId: String(leaseId),
          labels: { [CUA_LEASE_LABEL]: String(leaseId), [CUA_HOST_LABEL]: String(request.hostTag) },
        }),
        { signal: request.signal },
      );
      if (created.kind === "cancelled") {
        // The create may still be running in the daemon; this stops it and
        // removes what it made, even after a daemon restart cut it off.
        await discard(leaseId, undefined);
        return { status: "cancelled" };
      }
      if (created.kind === "unreachable") return { status: "not-connected" };
      if (created.kind !== "ok") {
        await discard(leaseId, undefined);
        return failed(
          created.kind === "grpc-error" ? `create-answered-${created.code}` : created.reason,
        );
      }
      const answer = readCuaCreateSpace(created.message);
      const spaceId = answer?.space.id;
      if (answer === undefined || spaceId === undefined || !SPACE_ID.test(spaceId)) {
        await discard(leaseId, undefined);
        return failed("create-unreadable");
      }
      // Network `none` is a QEMU VM's only. A Space that reports any other
      // network is destroyed rather than handed to the host.
      if (answer.network !== "none") {
        await discard(leaseId, spaceId);
        return failed("network-not-none");
      }
      if (request.signal.aborted) {
        await discard(leaseId, spaceId);
        return { status: "cancelled" };
      }
      const lifetime = await setLifetime(spaceId, request.expiresAt);
      if (
        lifetime === "unreachable" ||
        lifetime === undefined ||
        lifetime < Date.parse(request.expiresAt)
      ) {
        await discard(leaseId, spaceId);
        return failed("lifetime-not-set");
      }
      const ready = await untilReady(spaceId, request, request.signal);
      if (ready !== "ready") {
        await discard(leaseId, spaceId);
        return ready === "cancelled" ? { status: "cancelled" } : failed(`space-${ready}`);
      }
      const connected = await call(`${SPACE}/ConnectSpace`, cuaSpaceRequest(spaceId), {
        signal: request.signal,
      });
      const envUrl = connected.kind === "ok" ? readCuaConnect(connected.message) : undefined;
      const envKey = envUrl === undefined ? undefined : ENV_URL.exec(envUrl)?.[1];
      if (envKey === undefined || !ENV_KEY.test(envKey) || envKey === "." || envKey === "..") {
        await discard(leaseId, spaceId);
        return request.signal.aborted ? { status: "cancelled" } : failed("env-unreachable");
      }
      const capabilities = await call(
        `/v1/spaces/${envKey}/env/cua.env.v1.SystemService/GetCapabilities`,
        cuaGetCapabilitiesRequest(),
        { signal: request.signal },
      );
      const protocol =
        capabilities.kind === "ok" ? readCuaProtocolVersion(capabilities.message) : undefined;
      if (protocol !== CUA_ENV_PROTOCOL_VERSION) {
        await discard(leaseId, spaceId);
        if (request.signal.aborted) return { status: "cancelled" };
        return protocol === undefined
          ? failed("env-unreachable")
          : { status: "refused", reason: "env-protocol-unsupported" };
      }
      const providerExpiresAt = iso(lifetime);
      const { screen } = recipe;
      const session: Session = {
        spaceId,
        envKey,
        screen,
        control: new ScreenshotDesktopControl({
          screen,
          launch: async (appId) => {
            const ran = await run(session, "sh", ["-c", LAUNCH_APP, "octant-launch", INBOX, appId]);
            if (ran === "unreachable") return { status: "unreachable" };
            const pid = ran?.exitCode === 0 ? ran.stdout.trim() : "";
            return /^[1-9][0-9]{0,8}$/.test(pid)
              ? { status: "launched", pid: Number(pid) }
              : { status: "failed" };
          },
          alive: async (pid) => {
            const ran = await run(session, "kill", ["-0", String(pid)]);
            if (ran === "unreachable") return "unreachable";
            return ran?.exitCode === 0 ? "running" : "gone";
          },
          frame: () => frameOf(session),
          input: (event) => inputTo(session, event),
        }),
      };
      sessions.set(spaceId, session);
      return {
        status: "acquired",
        handle: { leaseId, resource: spaceId },
        ...(providerExpiresAt === undefined ? {} : { providerExpiresAt }),
      };
    },
    // The daemon measures a lifetime from the moment it is set, and only the
    // expiry it reports back counts.
    extend: async (handle, expiresAt) => {
      const lifetime = await setLifetime(handle.resource, expiresAt);
      if (lifetime === "unreachable") return { status: "not-connected" };
      if (lifetime === undefined) return failed("lifetime-not-set");
      if (lifetime < Date.parse(expiresAt)) return failed("lifetime-short");
      const reported = iso(lifetime);
      return reported === undefined
        ? failed("lifetime-not-set")
        : { status: "extended", expiresAt: reported };
    },
    screen: async (handle) => {
      const session = sessionOf(handle);
      if (session === undefined) return failed("not-running");
      return {
        status: "ready",
        screen: {
          frame: (signal) => frameOf(session, signal),
          input: (event) => inputTo(session, event),
          // Closing a view leaves the Space running; only release ends it.
          close: async () => undefined,
        },
      };
    },
    control: async (handle, command): Promise<ComputerControlResult> => {
      const session = sessionOf(handle);
      return session === undefined
        ? { kind: "failed", reason: "not-running", message: "The desktop is not running." }
        : session.control.control(command);
    },
    // The file lands whole and read-only under a staging name, then moves
    // into the inbox, so a desktop never sees a partial file.
    deliver: async (handle, name, bytes) => {
      const session = sessionOf(handle);
      if (session === undefined) return failed("not-running");
      const staged = `${INCOMING}/${name}`;
      const written = await upload(session, staged, bytes);
      if (written === "unreachable") return { status: "not-connected" };
      if (written !== "written") return failed("upload-failed");
      const moved = await call(
        env(session, "FilesystemService/Move"),
        cuaMoveRequest(staged, `${INBOX}/${name}`),
      );
      if (moved.kind === "unreachable") return { status: "not-connected" };
      if (moved.kind !== "ok") return failed("place-failed");
      session.control.sent(name);
      return { status: "delivered" };
    },
    // Asking the daemon to delete is not proof; only `verifyGone` is. A create
    // the daemon may still be running for this lease is cancelled first.
    release: async (handle) => {
      sessions.delete(handle.resource);
      const cancelled = await call(
        `${SPACE}/CancelCreateSpace`,
        cuaCancelCreateRequest(String(handle.leaseId)),
      );
      if (cancelled.kind === "unreachable") return { status: "not-connected" };
      const deleted = await call(`${SPACE}/DeleteSpace`, cuaSpaceRequest(handle.resource));
      if (deleted.kind === "unreachable") return { status: "not-connected" };
      if (deleted.kind === "ok") return { status: "released" };
      if (deleted.kind === "grpc-error" && deleted.code === GRPC_NOT_FOUND) {
        return { status: "released" };
      }
      return failed(
        deleted.kind === "grpc-error" ? `delete-answered-${deleted.code}` : "delete-failed",
      );
    },
    // Absence is confirmed only by a complete listing that shows neither the
    // Space nor a create still running under the lease's name.
    verifyGone: async (handle) => {
      const listed = await completeListing();
      if (listed.status !== "listed") return listed;
      const present =
        listed.spaces.some(
          (space) => space.id === handle.resource || spaceOfLease(space, handle.leaseId),
        ) || listed.creating.includes(spaceName(handle.leaseId));
      return { status: present ? "present" : "gone" };
    },
    listOwned: async (hostTag, credentialRef) => {
      // The daemon holds the person's sign-in; no recorded key names an account here.
      if (credentialRef !== undefined) return failed("credential-not-used");
      const listed = await completeListing();
      if (listed.status !== "listed") return listed;
      // A Space still being created carries no labels yet, so a listing with
      // one of Octant's cannot yet say which host it belongs to.
      if (listed.creating.some((name) => name.startsWith("octant-"))) {
        return failed("space-still-creating");
      }
      const resources: Array<DesktopOwnedResource> = [];
      for (const space of listed.spaces) {
        if (space.labels.get(CUA_HOST_LABEL) !== String(hostTag) || !SPACE_ID.test(space.id)) {
          continue;
        }
        try {
          const leaseId = decodeDesktopLeaseId(space.labels.get(CUA_LEASE_LABEL));
          resources.push({ hostTag, handle: { leaseId, resource: space.id } });
        } catch {
          // A Space tagged with this host but no lease id was not made by it.
        }
      }
      return { status: "listed", resources };
    },
  };
  return provider;
}
