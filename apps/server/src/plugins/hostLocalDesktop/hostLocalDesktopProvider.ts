/**
 * The host-local desktop provider: a virtual X display in the host's
 * dedicated Bubblewrap desktop capsule.
 *
 * It is a plugin-shaped driver. It imports only `@octant/contracts` and the
 * desktop-provider seam, and reaches the host only through the
 * {@link DesktopLaunchPort} it is given, so it never touches a process, a
 * file, or the network itself. The host owns the capsule, the lease directory,
 * and the process-group receipt; this driver owns only what runs inside and
 * the line protocol on the launch's standard streams.
 */
import type { ComputerControlResult } from "@octant/contracts/computer-use-plugin";
import {
  decodeDesktopProviderId,
  type DesktopInputEvent,
  type DesktopLeaseId,
  type DesktopRecipe,
} from "@octant/contracts";
import type {
  DesktopFrameResult,
  DesktopInputResult,
  DesktopLaunchPort,
  DesktopProvider,
  DesktopScreen,
  LaunchedDesktop,
} from "@octant/plugin-api/desktop-provider";
import { DesktopStreamChannel, type DesktopReply } from "./hostLocalDesktopChannel";
import { HostLocalDesktopControl } from "./hostLocalDesktopControl";

export const HOST_LOCAL_DESKTOP_PROVIDER_ID = decodeDesktopProviderId("host-local");

/**
 * What the desktop runs inside the capsule: the shell that speaks the
 * protocol, the virtual X server, the input tool, the screen grabber, the
 * decoder for typed text, and what copies a sent app out of the read-only
 * inbox so it can run. Readiness requires every one.
 */
export const HOST_LOCAL_DESKTOP_PROGRAMS: ReadonlyArray<string> = [
  "sh",
  "Xvfb",
  "xdotool",
  "import",
  "base64",
  "mkdir",
  "rm",
  "cp",
  "chmod",
];

/** Xvfb can take a few seconds on a loaded host; past this the acquire fails. */
const READY_TIMEOUT_MS = 30_000;
/** One frame grab or input. A desktop that does not answer in time is broken. */
const REQUEST_TIMEOUT_MS = 10_000;
/** Scroll wheel clicks one scroll event may send, however large its delta. */
const MAX_SCROLL_CLICKS = 10;
const SCROLL_PIXELS_PER_CLICK = 100;
/** Output a desktop may write before its launch is recorded: room for its `ready` line. */
const MAX_EARLY_OUTPUT_BYTES = 4_096;

/**
 * Runs as `sh -c` in the capsule with the screen width and height as its
 * arguments. Every value it receives is validated by the driver first: only
 * integers, a closed set of key names, and base64 text reach it, each passed
 * to its tool as one quoted argument. Tools' own output and errors are
 * discarded so that standard output carries only replies.
 */
export const HOST_LOCAL_DESKTOP_SCRIPT = `set -u
width="$1"
height="$2"
export DISPLAY=:1
Xvfb :1 -screen 0 "\${width}x\${height}x24" -nolisten tcp -noreset >/dev/null 2>&1 </dev/null &
tries=0
until xdotool getdisplaygeometry >/dev/null 2>&1 </dev/null; do
  tries=$((tries + 1))
  if [ "$tries" -gt 250 ]; then echo "error display"; exit 1; fi
  sleep 0.1
done
echo "ready $width $height"
frame=/tmp/octant-frame.png
text=/tmp/octant-text
inbox="\${HOME%/*}/inbox"
apps="$HOME/.octant-apps"
answer() { if "$@" >/dev/null 2>&1 </dev/null; then echo ok; else echo "error input"; fi; }
while read -r verb a b c d; do
  case "$verb" in
    launch)
      if [ -f "$inbox/$a" ] && mkdir -p "$apps" && rm -f "$apps/$a" &&
        cp "$inbox/$a" "$apps/$a" && chmod 0500 "$apps/$a"; then
        pid=$(cd "$HOME" && { "$apps/$a" </dev/null >/dev/null 2>&1 & echo "$!"; })
        echo "launched $pid"
      else
        echo "error launch"
      fi ;;
    alive) if kill -0 "$a" 2>/dev/null; then echo ok; else echo "error gone"; fi ;;
    frame)
      if import -silent -window root "png:$frame" >/dev/null 2>&1 </dev/null; then
        printf 'frame %d\\n' "$(($(wc -c < "$frame")))"
        cat "$frame"
      else
        echo "error frame"
      fi ;;
    move) answer xdotool mousemove "$a" "$b" ;;
    down) answer xdotool mousemove "$a" "$b" mousedown "$c" ;;
    up) answer xdotool mousemove "$a" "$b" mouseup "$c" ;;
    keydown) answer xdotool keydown "$a" ;;
    keyup) answer xdotool keyup "$a" ;;
    text)
      if printf '%s' "$a" | base64 -d > "$text" 2>/dev/null; then
        answer xdotool type --file "$text"
      else
        echo "error input"
      fi ;;
    scroll) answer xdotool mousemove "$a" "$b" click --repeat "$d" "$c" ;;
    *) echo "error unknown" ;;
  esac
done
`;

/** DOM key names a Desktop tab sends, as the X keysyms `xdotool` takes. */
const NAMED_KEYS: Readonly<Record<string, string>> = {
  Enter: "Return",
  Backspace: "BackSpace",
  Tab: "Tab",
  Escape: "Escape",
  " ": "space",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "Prior",
  PageDown: "Next",
  Shift: "Shift_L",
  Control: "Control_L",
  Alt: "Alt_L",
  Meta: "Super_L",
  CapsLock: "Caps_Lock",
  "-": "minus",
  "=": "equal",
  "[": "bracketleft",
  "]": "bracketright",
  ";": "semicolon",
  "'": "apostrophe",
  ",": "comma",
  ".": "period",
  "/": "slash",
  "\\": "backslash",
  "`": "grave",
};

/** The keysym for a key name, or undefined for one this desktop does not map. */
export function hostLocalKeysym(key: string): string | undefined {
  // An own property only: `constructor` or `toString` would otherwise name
  // an inherited function, whose source text would reach the shell.
  if (Object.hasOwn(NAMED_KEYS, key)) return NAMED_KEYS[key];
  if (/^[A-Za-z0-9]$/.test(key)) return key;
  if (/^F([1-9]|1[0-2])$/.test(key)) return key;
  return undefined;
}

type Translated =
  | { readonly kind: "lines"; readonly lines: ReadonlyArray<string> }
  | { readonly kind: "refused"; readonly reason: string };

const BUTTONS = { left: 1, middle: 2, right: 3 } as const;

/**
 * Turns one screen input into protocol lines, refusing anything outside the
 * screen or any key this desktop does not map, so only integers, known
 * keysyms, and base64 ever reach the desktop's shell.
 */
export function translateHostLocalInput(
  event: DesktopInputEvent,
  screen: DesktopRecipe["screen"],
): Translated {
  const point = (x: number, y: number): string | undefined => {
    const column = Math.floor(x);
    const row = Math.floor(y);
    if (!Number.isSafeInteger(column) || !Number.isSafeInteger(row)) return undefined;
    if (column < 0 || row < 0 || column >= screen.width || row >= screen.height) return undefined;
    return `${column} ${row}`;
  };
  switch (event.kind) {
    case "pointer": {
      const at = point(event.x, event.y);
      if (at === undefined) return { kind: "refused", reason: "outside-screen" };
      if (event.action === "move") return { kind: "lines", lines: [`move ${at}`] };
      return {
        kind: "lines",
        lines: [`${event.action} ${at} ${BUTTONS[event.button ?? "left"]}`],
      };
    }
    case "key": {
      const keysym = hostLocalKeysym(event.key);
      if (keysym === undefined) return { kind: "refused", reason: "unsupported-key" };
      return { kind: "lines", lines: [`key${event.action} ${keysym}`] };
    }
    case "text":
      return { kind: "lines", lines: [`text ${base64(new TextEncoder().encode(event.text))}`] };
    case "scroll": {
      const at = point(event.x, event.y);
      if (at === undefined) return { kind: "refused", reason: "outside-screen" };
      if (!Number.isSafeInteger(event.deltaX) || !Number.isSafeInteger(event.deltaY))
        return { kind: "refused", reason: "invalid-scroll" };
      const clicks = (delta: number) =>
        Math.min(
          MAX_SCROLL_CLICKS,
          Math.max(1, Math.round(Math.abs(delta) / SCROLL_PIXELS_PER_CLICK)),
        );
      const lines: Array<string> = [];
      if (event.deltaY !== 0)
        lines.push(`scroll ${at} ${event.deltaY > 0 ? 5 : 4} ${clicks(event.deltaY)}`);
      if (event.deltaX !== 0)
        lines.push(`scroll ${at} ${event.deltaX > 0 ? 7 : 6} ${clicks(event.deltaX)}`);
      return { kind: "lines", lines };
    }
  }
}

/** Text crosses as base64, so newlines and shell characters arrive as data. */
function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/**
 * Reads a PNG's dimensions from its header without decoding it, so a frame
 * larger than the screen is refused before anything parses its pixels.
 */
export function pngDimensions(
  bytes: Uint8Array,
): { readonly width: number; readonly height: number } | undefined {
  if (bytes.length < 24) return undefined;
  if (!PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return undefined;
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * The most bytes one frame may carry: an uncompressed 32-bit image of the
 * whole screen with its row filter bytes, plus room for PNG's own framing.
 */
export function maxHostLocalFrameBytes(screen: DesktopRecipe["screen"]): number {
  return screen.width * screen.height * 4 + screen.height + 1_048_576;
}

interface Session {
  readonly screen: DesktopRecipe["screen"];
  readonly desktop: LaunchedDesktop;
  readonly channel: DesktopStreamChannel;
  readonly control: HostLocalDesktopControl;
  exited: boolean;
}

const unavailable = (reason: string) => ({ status: "failed" as const, reason });

export function createHostLocalDesktopProvider(launch: DesktopLaunchPort): DesktopProvider {
  const sessions = new Map<string, Session>();

  function running(leaseId: DesktopLeaseId): Session | undefined {
    const session = sessions.get(String(leaseId));
    return session === undefined || session.exited || session.channel.broken ? undefined : session;
  }

  async function frameOf(session: Session, signal?: AbortSignal): Promise<DesktopFrameResult> {
    if (signal?.aborted === true) return unavailable("cancelled");
    const reply: DesktopReply = await session.channel.request("frame", REQUEST_TIMEOUT_MS);
    if (reply.kind === "broken") return { status: "not-connected" };
    if (reply.kind === "line") return unavailable("frame-unavailable");
    const size = pngDimensions(reply.bytes);
    if (
      size === undefined ||
      size.width < 1 ||
      size.height < 1 ||
      size.width > session.screen.width ||
      size.height > session.screen.height
    ) {
      return unavailable("frame-out-of-bounds");
    }
    return {
      status: "frame",
      frame: { mediaType: "image/png", width: size.width, height: size.height, bytes: reply.bytes },
    };
  }

  async function inputTo(session: Session, event: DesktopInputEvent): Promise<DesktopInputResult> {
    const translated = translateHostLocalInput(event, session.screen);
    if (translated.kind === "refused") return { status: "refused", reason: translated.reason };
    for (const line of translated.lines) {
      const reply = await session.channel.request(line, REQUEST_TIMEOUT_MS);
      if (reply.kind === "broken") return { status: "not-connected" };
      if (reply.kind !== "line" || reply.words[0] !== "ok") return unavailable("input-failed");
    }
    return { status: "delivered" };
  }

  const provider: DesktopProvider = {
    kind: "desktop-provider",
    id: HOST_LOCAL_DESKTOP_PROVIDER_ID,
    displayName: "This host",
    locality: "host-local",
    billed: false,
    status: async () => launch.readiness(HOST_LOCAL_DESKTOP_PROGRAMS),
    acquire: async (request) => {
      if (request.signal.aborted) return { status: "cancelled" };
      // A shared network namespace would reach the host's loopback, and with
      // it the Octant server. Until a desktop gets egress that keeps its own
      // namespace, a recipe that allows the network is refused.
      if (request.recipe.network !== "none")
        return { status: "refused", reason: "network-allow-unsupported" };
      const { screen } = request.recipe;
      let channel: DesktopStreamChannel | undefined;
      // Output that arrives while the host is still recording the launch;
      // only the `ready` line is legitimate then, so anything more is dropped
      // and the desktop is never trusted.
      const early: Array<Uint8Array> = [];
      let earlyBytes = 0;
      const launched = await launch.launch({
        leaseId: request.leaseId,
        hostTag: request.hostTag,
        program: "sh",
        args: [
          "-c",
          HOST_LOCAL_DESKTOP_SCRIPT,
          "octant-desktop",
          String(screen.width),
          String(screen.height),
        ],
        output: (chunk) => {
          if (channel !== undefined) {
            channel.receive(chunk);
            return;
          }
          earlyBytes += chunk.length;
          if (earlyBytes <= MAX_EARLY_OUTPUT_BYTES) early.push(chunk);
        },
        signal: request.signal,
      });
      if (launched.status !== "launched") return launched;
      const { desktop } = launched;
      channel = new DesktopStreamChannel({
        write: (bytes) => desktop.write(bytes),
        maxFrameBytes: maxHostLocalFrameBytes(screen),
      });
      if (earlyBytes > MAX_EARLY_OUTPUT_BYTES) channel.close();
      for (const chunk of early.splice(0)) channel.receive(chunk);
      const opened = channel;
      const session: Session = {
        screen,
        desktop,
        channel: opened,
        control: new HostLocalDesktopControl({
          screen,
          request: (line) => opened.request(line, REQUEST_TIMEOUT_MS),
          frame: () => frameOf(session),
          input: (event) => inputTo(session, event),
        }),
        exited: false,
      };
      void desktop.exited.then(() => {
        session.exited = true;
        session.channel.close();
      });
      const aborted = new Promise<"cancelled">((resolve) => {
        if (request.signal.aborted) resolve("cancelled");
        request.signal.addEventListener("abort", () => resolve("cancelled"), { once: true });
      });
      const ready = await Promise.race([channel.next(READY_TIMEOUT_MS), aborted]);
      if (
        ready === "cancelled" ||
        ready.kind !== "line" ||
        ready.words.join(" ") !== `ready ${screen.width} ${screen.height}`
      ) {
        channel.close();
        await launch.stop(request.leaseId);
        return ready === "cancelled"
          ? { status: "cancelled" }
          : unavailable("desktop-did-not-start");
      }
      sessions.set(String(request.leaseId), session);
      return {
        status: "acquired",
        handle: { leaseId: request.leaseId, resource: String(request.leaseId) },
      };
    },
    // The desktop has no clock of its own: the host's lease clock and its
    // death with the host end it. A running desktop therefore keeps any
    // expiry the host asks for, and one that is not running keeps none.
    extend: async (handle, expiresAt) =>
      running(handle.leaseId) === undefined
        ? unavailable("not-running")
        : { status: "extended", expiresAt },
    screen: async (handle) => {
      const session = running(handle.leaseId);
      if (session === undefined) return unavailable("not-running");
      const screen: DesktopScreen = {
        frame: (signal) => frameOf(session, signal),
        input: (event) => inputTo(session, event),
        // Closing a view leaves the desktop running; only release ends it.
        close: async () => undefined,
      };
      return { status: "ready", screen };
    },
    control: async (handle, command): Promise<ComputerControlResult> => {
      const session = running(handle.leaseId);
      return session === undefined
        ? { kind: "failed", reason: "not-running", message: "The desktop is not running." }
        : session.control.control(command);
    },
    // The host owns the inbox; the file reaches it only through the launch
    // port, and only while this desktop runs. Only a file that landed may launch.
    deliver: async (handle, name, bytes) => {
      const session = running(handle.leaseId);
      if (session === undefined) return unavailable("not-running");
      const delivered = await launch.deliver(handle.leaseId, name, bytes);
      if (delivered.status === "delivered") session.control.sent(name);
      return delivered;
    },
    release: async (handle) => {
      sessions.get(String(handle.leaseId))?.channel.close();
      sessions.delete(String(handle.leaseId));
      return launch.stop(handle.leaseId);
    },
    verifyGone: (handle) => launch.inspect(handle.leaseId),
    listOwned: async (hostTag) => {
      const listed = await launch.listOwned(hostTag);
      if (listed.status !== "listed") return listed;
      return {
        status: "listed",
        resources: listed.leaseIds.map((leaseId) => ({
          hostTag,
          handle: { leaseId, resource: String(leaseId) },
        })),
      };
    },
  };
  return provider;
}
