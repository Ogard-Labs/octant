/**
 * Local, opt-in interaction marks. They never leave the process and do not
 * run unless `OCTANT_PERF_TRACE=1` is set on the process or
 * `globalThis.__OCTANT_PERF_TRACE` is true. Layers distinguish host/server
 * work from renderer work from native-window work from provider/network time
 * without shipping product telemetry.
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
}

export function readInteractionMarks(): ReadonlyArray<InteractionMark> {
  return holder().__OCTANT_PERF_MARKS ?? [];
}

export function clearInteractionMarks(): void {
  holder().__OCTANT_PERF_MARKS = [];
}
