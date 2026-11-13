/**
 * Local, opt-in host marks for packaged launch. They never leave the machine
 * and do not run unless `OCTANT_PERF_TRACE=1`. The layer names match the
 * renderer tracer so a local session can tell native-window work from server
 * startup from later renderer work.
 *
 * Each mark is also written as one line on the desktop's own stderr, because
 * a `performance.mark` stays inside the process: the packaged smoke that saw a
 * cold launch sit on "Connecting to Chat" could not tell which phase was slow.
 * Wall-clock milliseconds let the smoke line marks up with the host's service
 * log and its own launch time.
 */
export type HostInteractionLayer = "host" | "server" | "native-window" | "renderer";

export interface HostInteractionMark {
  readonly layer: HostInteractionLayer;
  readonly name: string;
  /** Wall-clock milliseconds since the epoch. */
  readonly at: number;
}

const LINE_PREFIX = "octant-perf ";
const LAYERS: ReadonlySet<string> = new Set(["host", "server", "native-window", "renderer"]);

export function hostInteractionTraceEnabled(): boolean {
  return process.env.OCTANT_PERF_TRACE === "1";
}

export function markHostInteraction(layer: HostInteractionLayer, name: string): void {
  if (!hostInteractionTraceEnabled()) return;
  if (typeof performance.mark === "function") {
    performance.mark(`octant:${layer}:${name}`);
  }
  process.stderr.write(`${formatHostInteractionMark({ layer, name, at: Date.now() })}\n`);
}

export function formatHostInteractionMark(mark: HostInteractionMark): string {
  return `${LINE_PREFIX}${mark.layer}:${mark.name} ${mark.at}`;
}

/** Reads one output line back as a mark; any other output reads as nothing. */
export function readHostInteractionMark(line: string): HostInteractionMark | undefined {
  const match = /^octant-perf ([a-z-]+):([a-z0-9-]+) (\d+)$/.exec(line.trim());
  if (match === null) return undefined;
  const [, layer, name, at] = match;
  if (layer === undefined || name === undefined || at === undefined) return undefined;
  if (!isHostInteractionLayer(layer)) return undefined;
  return { layer, name, at: Number(at) };
}

function isHostInteractionLayer(value: string): value is HostInteractionLayer {
  return LAYERS.has(value);
}

/**
 * The renderer's first Chat read. Until it is answered the window says
 * "Connecting to Chat…", so its send and answer bound that wait.
 */
export function isChatBootstrapRequest(requestUrl: string, serverOrigin: string): boolean {
  try {
    const url = new URL(requestUrl);
    return url.origin === serverOrigin && url.pathname === "/api/chat/bootstrap";
  } catch {
    return false;
  }
}
