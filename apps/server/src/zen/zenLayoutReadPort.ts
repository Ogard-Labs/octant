import type { WindowId, ZenAssistantElementSummary, ZenSpace } from "@octant/contracts";

/**
 * The layout of the Zen space in front of a window, and nothing of what its
 * elements say. Zen is separable from the host, so the assistant tool reads
 * the space through this bounded snapshot rather than the host's full
 * bootstrap, which also carries note, checklist, and pinned-thread content.
 */
export type ZenLayoutSnapshot =
  | {
      readonly status: "ok";
      readonly version: ZenSpace["version"];
      readonly dimming: ZenSpace["appearance"]["dimming"];
      readonly elementOpacity: ZenSpace["appearance"]["elementOpacity"];
      readonly elements: ReadonlyArray<ZenAssistantElementSummary>;
    }
  | { readonly status: "refused"; readonly reason: "unknown-space" };

/**
 * Reads only the space of the window the caller is bound to; it takes no
 * space id, so a caller cannot name another window's space through it.
 */
export interface ZenLayoutReadPort {
  readonly layout: (windowId: WindowId) => ZenLayoutSnapshot;
}

export function zenLayoutOf(space: ZenSpace | null): ZenLayoutSnapshot {
  if (space === null) return { status: "refused", reason: "unknown-space" };
  return {
    status: "ok",
    version: space.version,
    dimming: space.appearance.dimming,
    elementOpacity: space.appearance.elementOpacity,
    elements: space.elements.map((element) => ({
      elementId: element.elementId,
      kind: element.kind,
      ...("title" in element && element.title !== undefined ? { title: element.title } : {}),
      geometry: element.geometry,
      zIndex: element.zIndex,
      minimized: element.minimized,
    })),
  };
}
