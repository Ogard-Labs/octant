/**
 * The E2B desktop provider: a disposable desktop in an E2B sandbox, a
 * Firecracker microVM on the person's own E2B account.
 *
 * It is a plugin-shaped driver. It imports only `@octant/contracts` and the
 * desktop-provider seam and reaches E2B only through the {@link DesktopHttpsPort}
 * the host gives it, which sends nothing outside {@link E2B_DESKTOP_HOSTS} and
 * attaches the person's API key itself. The control plane is E2B's published
 * REST API (`api.e2b.app`); the screen, input, and files go through the
 * sandbox's own daemon with the sandbox's own token, which this driver keeps
 * in memory and never hands to the host.
 *
 * Every sandbox is created with the lease id and the host's tag in its
 * metadata and with E2B's own timeout set past the lease expiry, so a host
 * that never comes back still stops paying, and a host that does finds what it
 * left by listing that metadata.
 */
import type { ComputerControlResult } from "@octant/contracts/computer-use-plugin";
import {
  decodeDesktopLeaseId,
  decodeDesktopProviderId,
  decodeUtcTimestamp,
  type DesktopCredentialRef,
  type DesktopHostTag,
  type DesktopInputEvent,
  type DesktopRecipe,
  type UtcTimestamp,
} from "@octant/contracts";
import {
  DESKTOP_CREDENTIAL_REJECTED,
  maxDesktopFrameBytes,
  pngDimensions,
  ScreenshotDesktopControl,
  x11Keysym,
  type DesktopFrameResult,
  type DesktopHandle,
  type DesktopHttpsPort,
  type DesktopHttpsResult,
  type DesktopInputResult,
  type DesktopOwnedResource,
  type DesktopProvider,
} from "@octant/plugin-api/desktop-provider";
import {
  readSandboxFile,
  runInSandbox,
  writeSandboxFile,
  type E2bSandboxSession,
} from "./e2bSandboxProcess";

export const E2B_DESKTOP_PROVIDER_ID = decodeDesktopProviderId("e2b");
/** The control plane, and the shared host for in-sandbox traffic. Nothing else is reached. */
export const E2B_DESKTOP_HOSTS: ReadonlyArray<string> = ["api.e2b.app", "sandbox.e2b.app"];
const E2B_API_ORIGIN = "https://api.e2b.app";
/** E2B's public desktop template, used when a recipe names none. */
export const E2B_DEFAULT_DESKTOP_TEMPLATE = "desktop";
/** The metadata keys a sandbox is tagged with. */
export const E2B_LEASE_METADATA_KEY = "octantLease";
export const E2B_HOST_METADATA_KEY = "octantHost";
/**
 * E2B's own timeout runs this long past the lease expiry, so the host's own
 * clock ends a lease first and E2B's ends a desktop the host never returned to.
 */
const PROVIDER_EXPIRY_MARGIN_SECONDS = 120;
/** Pages of 100 one listing reads; a longer listing cannot confirm absence. */
const MAX_LISTING_PAGES = 20;
const MAX_JSON_RESPONSE_BYTES = 1_048_576;
const FRAME_PATH = "/tmp/octant-frame.png";
const INBOX = "/home/user/inbox";
const INCOMING = "/home/user/.octant-incoming";
const SANDBOX_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
const BUTTONS = { left: "1", middle: "2", right: "3" } as const;
const SCROLL_PIXELS_PER_CLICK = 100;
const MAX_SCROLL_CLICKS = 10;

/**
 * Starts the display the recipe asks for, as E2B's desktop SDK does, and
 * waits for it to answer. `setsid -f` keeps the server running once the
 * command that started it has exited.
 */
const START_DISPLAY = `set -u
setsid -f Xvfb :0 -ac -screen 0 "$1x$2x24" -retro -dpi 96 -nolisten tcp -nolisten unix </dev/null >/dev/null 2>&1
tries=0
until xdpyinfo -display :0 >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -gt 200 ]; then exit 1; fi
  sleep 0.1
done`;

/** Takes one screenshot of the whole display into the frame file. */
const TAKE_FRAME = `rm -f "$1" && scrot "$1"`;

/**
 * Moves a sent file whole into the inbox, read-only, so a desktop never sees
 * a partial file and a later send under the same name replaces it.
 */
const PLACE_IN_INBOX = `set -eu
chmod 0444 -- "$1"
mkdir -p -- "$2"
mv -f -- "$1" "$2/$3"`;

/**
 * Copies a sent file out of the inbox, makes the copy executable by the
 * desktop's user only, and starts it in its own session, so nothing in the
 * inbox ever runs and the app outlives the command that started it.
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

interface Session extends E2bSandboxSession {
  readonly screen: DesktopRecipe["screen"];
  readonly control: ScreenshotDesktopControl;
}

const failed = (reason: string) => ({ status: "failed" as const, reason });
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function json(result: DesktopHttpsResult): unknown {
  if (result.status !== "answered") return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(result.body));
  } catch {
    return undefined;
  }
}

/** Seconds from now until `at`, plus the margin, never below one. */
function timeoutSeconds(at: UtcTimestamp, now: number): number {
  return Math.max(1, Math.ceil((Date.parse(at) - now) / 1_000) + PROVIDER_EXPIRY_MARGIN_SECONDS);
}

function readTimestamp(value: unknown): UtcTimestamp | undefined {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return undefined;
  try {
    return decodeUtcTimestamp(new Date(Date.parse(value)).toISOString());
  } catch {
    return undefined;
  }
}

/** The screen input as one `xdotool` argument list, or a refusal. */
function xdotoolArgs(
  event: DesktopInputEvent,
  screen: DesktopRecipe["screen"],
): ReadonlyArray<string> | { readonly refused: string } {
  const point = (x: number, y: number): ReadonlyArray<string> | undefined => {
    const column = Math.floor(x);
    const row = Math.floor(y);
    if (!Number.isSafeInteger(column) || !Number.isSafeInteger(row)) return undefined;
    if (column < 0 || row < 0 || column >= screen.width || row >= screen.height) return undefined;
    return [String(column), String(row)];
  };
  switch (event.kind) {
    case "pointer": {
      const at = point(event.x, event.y);
      if (at === undefined) return { refused: "outside-screen" };
      if (event.action === "move") return ["mousemove", ...at];
      return [
        "mousemove",
        ...at,
        event.action === "down" ? "mousedown" : "mouseup",
        BUTTONS[event.button ?? "left"],
      ];
    }
    case "key": {
      const keysym = x11Keysym(event.key);
      if (keysym === undefined) return { refused: "unsupported-key" };
      return [event.action === "down" ? "keydown" : "keyup", keysym];
    }
    case "text":
      return ["type", "--", event.text];
    case "scroll": {
      const at = point(event.x, event.y);
      if (at === undefined) return { refused: "outside-screen" };
      const vertical = event.deltaY !== 0;
      const delta = vertical ? event.deltaY : event.deltaX;
      if (delta === 0) return { refused: "invalid-scroll" };
      const button = vertical ? (delta > 0 ? "5" : "4") : delta > 0 ? "7" : "6";
      const clicks = Math.min(
        MAX_SCROLL_CLICKS,
        Math.max(1, Math.round(Math.abs(delta) / SCROLL_PIXELS_PER_CLICK)),
      );
      return ["mousemove", ...at, "click", "--repeat", String(clicks), button];
    }
  }
}

export function createE2bDesktopProvider(
  https: DesktopHttpsPort,
  options: { readonly now?: () => number } = {},
): DesktopProvider {
  const now = options.now ?? (() => Date.now());
  const sessions = new Map<string, Session>();

  const api = (
    method: "GET" | "POST" | "DELETE",
    path: string,
    credentialRef: DesktopCredentialRef,
    extra: {
      readonly body?: unknown;
      readonly headers?: Readonly<Record<string, string>>;
      readonly signal?: AbortSignal;
    } = {},
  ) =>
    https.request({
      method,
      url: `${E2B_API_ORIGIN}${path}`,
      credential: { ref: credentialRef, header: "X-API-Key" },
      headers: {
        ...extra.headers,
        ...(extra.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(extra.body === undefined ? {} : { body: JSON.stringify(extra.body) }),
      maxResponseBytes: MAX_JSON_RESPONSE_BYTES,
      ...(extra.signal === undefined ? {} : { signal: extra.signal }),
    });

  /** E2B's own expiry for a sandbox now, or why it is not known. */
  async function reportedExpiry(
    sandboxId: string,
    credentialRef: DesktopCredentialRef,
  ): Promise<UtcTimestamp | "gone" | "unknown"> {
    const answered = await api("GET", `/sandboxes/${sandboxId}`, credentialRef);
    if (answered.status === "answered" && answered.httpStatus === 404) return "gone";
    if (answered.status !== "answered" || answered.httpStatus !== 200) return "unknown";
    const detail = json(answered);
    return (isRecord(detail) ? readTimestamp(detail.endAt) : undefined) ?? "unknown";
  }

  function sessionOf(handle: DesktopHandle): Session | undefined {
    return sessions.get(handle.resource);
  }

  async function frameOf(session: Session, signal?: AbortSignal): Promise<DesktopFrameResult> {
    if (signal?.aborted === true) return failed("cancelled");
    const taken = await runInSandbox(https, session, {
      cmd: "sh",
      args: ["-c", TAKE_FRAME, "octant-frame", FRAME_PATH],
      ...(signal === undefined ? {} : { signal }),
    });
    if (taken.status === "unreachable") return { status: "not-connected" };
    if (taken.status !== "exited" || taken.exitCode !== 0) return failed("frame-unavailable");
    const read = await readSandboxFile(
      https,
      session,
      FRAME_PATH,
      maxDesktopFrameBytes(session.screen),
      signal,
    );
    if (read.status === "unreachable") return { status: "not-connected" };
    if (read.status !== "read") return failed("frame-unavailable");
    const size = pngDimensions(read.bytes);
    if (
      size === undefined ||
      size.width < 1 ||
      size.height < 1 ||
      size.width > session.screen.width ||
      size.height > session.screen.height
    ) {
      return failed("frame-out-of-bounds");
    }
    return {
      status: "frame",
      frame: { mediaType: "image/png", width: size.width, height: size.height, bytes: read.bytes },
    };
  }

  async function inputTo(session: Session, event: DesktopInputEvent): Promise<DesktopInputResult> {
    const args = xdotoolArgs(event, session.screen);
    if (!Array.isArray(args)) {
      return { status: "refused", reason: "refused" in args ? args.refused : "unsupported" };
    }
    const ran = await runInSandbox(https, session, { cmd: "xdotool", args });
    if (ran.status === "unreachable") return { status: "not-connected" };
    return ran.status === "exited" && ran.exitCode === 0
      ? { status: "delivered" }
      : failed("input-failed");
  }

  /** Destroys a sandbox the acquire created but will not hand to the host. */
  async function discard(sandboxId: string, credentialRef: DesktopCredentialRef): Promise<void> {
    await api("DELETE", `/sandboxes/${sandboxId}`, credentialRef);
  }

  const provider: DesktopProvider = {
    kind: "desktop-provider",
    id: E2B_DESKTOP_PROVIDER_ID,
    displayName: "E2B",
    locality: "cloud",
    billed: true,
    hosts: E2B_DESKTOP_HOSTS,
    // Whether the person's key works is learned by using it; nothing here
    // would be an honest readiness check without a billed call.
    status: async () => ({ status: "ready" }),
    acquire: async (request) => {
      if (request.signal.aborted) return { status: "cancelled" };
      const credentialRef = request.recipe.credentialRef;
      if (credentialRef === undefined) return { status: "refused", reason: "credential-required" };
      const created = await api("POST", "/v2/sandboxes", credentialRef, {
        // A retried create with the same lease id never makes a second sandbox.
        headers: { "Idempotency-Key": String(request.leaseId).toLowerCase() },
        body: {
          templateID: request.recipe.image ?? E2B_DEFAULT_DESKTOP_TEMPLATE,
          timeout: timeoutSeconds(request.expiresAt, now()),
          autoPause: false,
          allow_internet_access: request.recipe.network === "allow",
          // Nothing reaches the sandbox's ports without its own tokens.
          network: { allowPublicTraffic: false },
          metadata: {
            [E2B_LEASE_METADATA_KEY]: String(request.leaseId),
            [E2B_HOST_METADATA_KEY]: String(request.hostTag),
          },
          envVars: { DISPLAY: ":0" },
        },
        signal: request.signal,
      });
      if (created.status === "cancelled") return { status: "cancelled" };
      if (created.status === "refused") return { status: "refused", reason: created.reason };
      if (created.status === "failed") return { status: "not-connected" };
      if (created.httpStatus === 401 || created.httpStatus === 403) {
        return { status: "refused", reason: DESKTOP_CREDENTIAL_REJECTED };
      }
      if (created.httpStatus !== 201) return failed(`create-answered-${created.httpStatus}`);
      const sandbox = json(created);
      const sandboxId = isRecord(sandbox) ? sandbox.sandboxID : undefined;
      if (typeof sandboxId !== "string" || !SANDBOX_ID.test(sandboxId)) {
        return failed("create-unreadable");
      }
      const accessToken = isRecord(sandbox) ? sandbox.envdAccessToken : undefined;
      const domain = isRecord(sandbox) ? sandbox.domain : undefined;
      // A sandbox served anywhere but E2B's own domain is out of this
      // driver's declared reach. It exists, so the host's failed-acquire
      // path lists it by its tag and destroys it.
      if (
        typeof accessToken !== "string" ||
        accessToken.length === 0 ||
        (domain !== undefined && domain !== null && domain !== "e2b.app")
      ) {
        await discard(sandboxId, credentialRef);
        return failed("sandbox-unreachable");
      }
      if (request.signal.aborted) {
        await discard(sandboxId, credentialRef);
        return { status: "cancelled" };
      }
      const { screen } = request.recipe;
      const sandboxSession: E2bSandboxSession = { sandboxId, accessToken };
      const display = await runInSandbox(https, sandboxSession, {
        cmd: "sh",
        args: ["-c", START_DISPLAY, "octant-display", String(screen.width), String(screen.height)],
        signal: request.signal,
      });
      if (request.signal.aborted) {
        await discard(sandboxId, credentialRef);
        return { status: "cancelled" };
      }
      if (display.status !== "exited" || display.exitCode !== 0) {
        await discard(sandboxId, credentialRef);
        return failed("desktop-did-not-start");
      }
      const expiry = await reportedExpiry(sandboxId, credentialRef);
      if (expiry === "gone" || expiry === "unknown") {
        await discard(sandboxId, credentialRef);
        return failed("provider-expiry-unknown");
      }
      const session: Session = {
        ...sandboxSession,
        screen,
        control: new ScreenshotDesktopControl({
          screen,
          launch: async (appId) => {
            const ran = await runInSandbox(https, session, {
              cmd: "sh",
              args: ["-c", LAUNCH_APP, "octant-launch", INBOX, appId],
            });
            if (ran.status === "unreachable") return { status: "unreachable" };
            const pid = ran.status === "exited" && ran.exitCode === 0 ? ran.stdout.trim() : "";
            return /^[1-9][0-9]{0,8}$/.test(pid)
              ? { status: "launched", pid: Number(pid) }
              : { status: "failed" };
          },
          alive: async (pid) => {
            const ran = await runInSandbox(https, session, {
              cmd: "kill",
              args: ["-0", String(pid)],
            });
            if (ran.status === "unreachable") return "unreachable";
            return ran.status === "exited" && ran.exitCode === 0 ? "running" : "gone";
          },
          frame: () => frameOf(session),
          input: (event) => inputTo(session, event),
        }),
      };
      sessions.set(sandboxId, session);
      return {
        status: "acquired",
        handle: { leaseId: request.leaseId, resource: sandboxId, credentialRef },
        providerExpiresAt: expiry,
      };
    },
    // E2B measures a timeout from the moment it is set, and may hold it below
    // what was asked for (a plan's longest sandbox). Only the expiry E2B
    // reports afterwards counts.
    extend: async (handle, expiresAt) => {
      const credentialRef = handle.credentialRef;
      if (credentialRef === undefined) return { status: "refused", reason: "credential-required" };
      const moved = await api("POST", `/sandboxes/${handle.resource}/timeout`, credentialRef, {
        body: { timeout: timeoutSeconds(expiresAt, now()) },
      });
      if (moved.status !== "answered") return { status: "not-connected" };
      if (moved.httpStatus === 401 || moved.httpStatus === 403) {
        return { status: "refused", reason: DESKTOP_CREDENTIAL_REJECTED };
      }
      if (moved.httpStatus !== 204) return failed(`timeout-answered-${moved.httpStatus}`);
      const reported = await reportedExpiry(handle.resource, credentialRef);
      if (reported === "gone") return failed("not-found");
      if (reported === "unknown") return { status: "not-connected" };
      if (Date.parse(reported) < Date.parse(expiresAt)) return failed("provider-expiry-short");
      return { status: "extended", expiresAt: reported };
    },
    screen: async (handle) => {
      const session = sessionOf(handle);
      if (session === undefined) return failed("not-running");
      return {
        status: "ready",
        screen: {
          frame: (signal) => frameOf(session, signal),
          input: (event) => inputTo(session, event),
          // Closing a view leaves the desktop running; only release ends it.
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
    deliver: async (handle, name, bytes) => {
      const session = sessionOf(handle);
      if (session === undefined) return failed("not-running");
      const staged = `${INCOMING}/${name}`;
      const written = await writeSandboxFile(https, session, staged, bytes);
      if (written === "unreachable") return { status: "not-connected" };
      if (written !== "written") return failed("upload-failed");
      const placed = await runInSandbox(https, session, {
        cmd: "sh",
        args: ["-c", PLACE_IN_INBOX, "octant-deliver", staged, INBOX, name],
      });
      if (placed.status === "unreachable") return { status: "not-connected" };
      if (placed.status !== "exited" || placed.exitCode !== 0) return failed("place-failed");
      session.control.sent(name);
      return { status: "delivered" };
    },
    // Asking E2B to kill is not proof; only `verifyGone` is.
    release: async (handle) => {
      sessions.delete(handle.resource);
      const credentialRef = handle.credentialRef;
      if (credentialRef === undefined) return failed("credential-required");
      const killed = await api("DELETE", `/sandboxes/${handle.resource}`, credentialRef);
      if (killed.status === "refused") return failed(killed.reason);
      if (killed.status !== "answered") return { status: "not-connected" };
      return killed.httpStatus === 204 || killed.httpStatus === 404
        ? { status: "released" }
        : failed(`kill-answered-${killed.httpStatus}`);
    },
    // A paused sandbox is still present: it keeps its disk and can be resumed.
    verifyGone: async (handle) => {
      const credentialRef = handle.credentialRef;
      if (credentialRef === undefined) return failed("credential-required");
      const answered = await api("GET", `/sandboxes/${handle.resource}`, credentialRef);
      if (answered.status === "refused") return failed(answered.reason);
      if (answered.status !== "answered") return { status: "not-connected" };
      if (answered.httpStatus === 404) return { status: "gone" };
      if (answered.httpStatus === 200) return { status: "present" };
      return failed(`get-answered-${answered.httpStatus}`);
    },
    listOwned: async (hostTag, credentialRef) => {
      if (credentialRef === undefined) return failed("credential-required");
      const resources: Array<DesktopOwnedResource> = [];
      let nextToken: string | undefined;
      for (let page = 0; page < MAX_LISTING_PAGES; page += 1) {
        const query = [
          `metadata=${encodeURIComponent(`${E2B_HOST_METADATA_KEY}=${String(hostTag)}`)}`,
          "state=running,paused",
          "limit=100",
          ...(nextToken === undefined ? [] : [`nextToken=${encodeURIComponent(nextToken)}`]),
        ].join("&");
        const answered = await api("GET", `/v2/sandboxes?${query}`, credentialRef);
        if (answered.status === "refused") return failed(answered.reason);
        if (answered.status !== "answered") return { status: "not-connected" };
        if (answered.httpStatus !== 200) return failed(`list-answered-${answered.httpStatus}`);
        const listed = json(answered);
        if (!Array.isArray(listed)) return failed("list-unreadable");
        for (const sandbox of listed) {
          const owned = ownedResource(sandbox, hostTag, credentialRef);
          if (owned !== undefined) resources.push(owned);
        }
        const next = answered.headers["x-next-token"];
        if (next === undefined || next === "") return { status: "listed", resources };
        nextToken = next;
      }
      // A listing cut short cannot say the rest are absent.
      return failed("list-too-long");
    },
  };
  return provider;
}

/** A listed sandbox this host made for one of its leases, or undefined. */
function ownedResource(
  sandbox: unknown,
  hostTag: DesktopHostTag,
  credentialRef: DesktopCredentialRef,
): DesktopOwnedResource | undefined {
  if (!isRecord(sandbox) || !isRecord(sandbox.metadata)) return undefined;
  const sandboxId = sandbox.sandboxID;
  if (typeof sandboxId !== "string" || !SANDBOX_ID.test(sandboxId)) return undefined;
  if (sandbox.metadata[E2B_HOST_METADATA_KEY] !== String(hostTag)) return undefined;
  const lease = sandbox.metadata[E2B_LEASE_METADATA_KEY];
  try {
    const leaseId = decodeDesktopLeaseId(lease);
    return { hostTag, handle: { leaseId, resource: sandboxId, credentialRef } };
  } catch {
    return undefined;
  }
}
