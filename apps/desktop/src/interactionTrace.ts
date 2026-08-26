/**
 * Local, opt-in host marks for packaged launch. They never leave the process
 * and do not run unless `OCTANT_PERF_TRACE=1`. The layer names match the
 * renderer tracer so a local session can tell native-window work from server
 * startup from later renderer work.
 */
export type HostInteractionLayer = "host" | "server" | "native-window";

export function markHostInteraction(layer: HostInteractionLayer, name: string): void {
  if (process.env.OCTANT_PERF_TRACE !== "1") return;
  if (typeof performance.mark === "function") {
    performance.mark(`octant:${layer}:${name}`);
  }
}
