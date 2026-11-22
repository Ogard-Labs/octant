/**
 * Local, opt-in interaction marks. They never leave the machine and do not
 * run unless `OCTANT_PERF_TRACE=1` is set on the process or
 * `globalThis.__OCTANT_PERF_TRACE` is true. Layers distinguish host/server
 * work from renderer work from native-window work from provider/network time
 * without shipping product telemetry.
 *
 * Each mark is also written as one `octant-perf <layer>:<name> <epoch-ms>`
 * console line so the desktop host — which keeps its own marks on stderr for
 * the packaged launch benchmark — can relay renderer marks the same way. In a
 * browser the line only reaches the page's own console.
 */
export type InteractionLayer = "host" | "server" | "renderer" | "native-window" | "provider";

export interface InteractionMark {
  readonly layer: InteractionLayer;
  readonly name: string;
  readonly at: number;
}

interface InteractionTraceHolder {
  __OCTANT_PERF_TRACE?: boolean;
  __OCTANT_PERF_MARKS?: InteractionMark[];
}

function holder(): InteractionTraceHolder {
  return globalThis as InteractionTraceHolder;
}

function isEnabled(): boolean {
  if (holder().__OCTANT_PERF_TRACE === true) return true;
  try {
    return typeof process !== "undefined" && process.env.OCTANT_PERF_TRACE === "1";
  } catch {
    return false;
  }
}

export function markInteraction(layer: InteractionLayer, name: string): void {
  if (!isEnabled()) return;
  const at = performance.now();
  const mark: InteractionMark = { layer, name, at };
  const current = holder();
  const marks = current.__OCTANT_PERF_MARKS ?? [];
  marks.push(mark);
  current.__OCTANT_PERF_MARKS = marks;
  if (typeof performance.mark === "function") {
    performance.mark(`octant:${layer}:${name}`);
  }
  console.debug(`octant-perf ${layer}:${name} ${Math.round(performance.timeOrigin + at)}`);
}

export function markInteractionAfterPaint(name: string): void {
  if (!isEnabled()) return;
  const afterFrame = () => markInteraction("renderer", `${name}-painted`);
  if (typeof requestAnimationFrame !== "function") {
    queueMicrotask(afterFrame);
    return;
  }
  requestAnimationFrame(() => requestAnimationFrame(afterFrame));
}

export function readInteractionMarks(): ReadonlyArray<InteractionMark> {
  return holder().__OCTANT_PERF_MARKS ?? [];
}

/** The fresh profile opens setup over the composer. Only count a frame
 * where the control the person actually sees can receive a pointer event. */
export function traceLaunchControl(kind: "setup" | "composer"): (() => void) | undefined {
  if (!isEnabled() || readInteractionMarks().some((mark) => mark.name === "usable-painted")) return;
  const selector =
    kind === "setup"
      ? "[data-launch-control='setup']:enabled"
      : ".workspace-layer textarea.composer-input:enabled:not([readonly])";
  const deadline = performance.now() + 45_000;
  let last: Element | undefined;
  let frame = requestAnimationFrame(check);
  function check() {
    if (performance.now() >= deadline) return;
    const target = Array.from(document.querySelectorAll(selector)).find((control) => {
      if (control.closest("[inert], [aria-hidden='true']")) return false;
      const rect = control.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return hit !== null && control.contains(hit);
    });
    if (target !== undefined && target === last) {
      markInteraction("renderer", "usable-painted");
      return;
    }
    last = target;
    frame = requestAnimationFrame(check);
  }
  return () => cancelAnimationFrame(frame);
}

export function clearInteractionMarks(): void {
  holder().__OCTANT_PERF_MARKS = [];
}
