import { canvasMockupHtml } from "./canvasMockupHtml";
import type { CanvasDesignBlock, CanvasMockupBlock } from "@octant/contracts/canvas";
import type { CanvasFlowShape } from "./canvasFlowLayout";

/**
 * A flow as one self-contained, script-free section set: every screen a
 * section, every transition a real anchor, navigation by `:target` alone —
 * the pattern a design's frames already ship inside one page.
 *
 * The mockup screens are generated semantically with their hotspot nodes as
 * anchors; a design screen's section holds whatever page markup the caller
 * passes (the sandboxed frame the HTML export already writes). Pure and
 * deterministic, so the same flow always exports the same bytes.
 */

const escapeHtml = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");

/** The anchor a screen's section is reached at, stable for a screen id. */
export function canvasFlowScreenAnchor(screenId: string): string {
  return `#oct-flow-${screenId}`;
}

export interface CanvasFlowSiteInput {
  readonly flow: CanvasFlowShape;
  /** The mockup and design blocks the flow places. */
  readonly blocks: ReadonlyArray<CanvasMockupBlock | CanvasDesignBlock>;
  /**
   * The inner page markup for a design screen's section, keyed by screen id:
   * the sandboxed frame the export already writes for a design's frames.
   * Absent markup draws the screen's label alone.
   */
  readonly designScreenHtml?: ReadonlyMap<string, string> | undefined;
}

/** The `:target` navigation rules a flow site carries, scoped to its sections. */
export const CANVAS_FLOW_SITE_STYLES = [
  ".oct-flow-screen { display: none; }",
  ".oct-flow-screen:target, .oct-flow-screen:has(:target) { display: block; }",
  "body:not(:has(.oct-flow-screen:target, .oct-flow-screen :target)) .oct-flow-screen[data-start] { display: block; }",
  ".oct-flow-links { margin-top: 16px; display: flex; flex-wrap: wrap; gap: 8px; }",
  ".oct-flow-links a { padding: 6px 12px; border: 1px solid #18181b; border-radius: 6px; background: #18181b; color: #fff; text-decoration: none; }",
] as const;

function flowSiteStyles(): string {
  return `<style>${CANVAS_FLOW_SITE_STYLES.join("")}</style>`;
}

/**
 * The flow's screens as one section set. The first screen is marked as the
 * start, so the page opens on it before any anchor is followed; every
 * transition whose edge names a hotspot reaches its target from inside the
 * source screen's drawing, and the rest sit in an explicit link list so no
 * transition is left without a place to tap.
 */
export function canvasFlowSite(input: CanvasFlowSiteInput): string {
  const { flow, blocks } = input;
  const byBlockId = new Map(blocks.map((block) => [String(block.blockId), block]));
  const screenIndex = new Map(flow.screens.map((screen) => [String(screen.screenId), screen]));
  const anchorOf = (screenId: string) => canvasFlowScreenAnchor(screenId);

  // The hotspot anchors each mockup screen's generated page carries, and the
  // screen-level links listed beneath each screen.
  const hotspotsByScreen = new Map<string, Map<string, string>>();
  const linksByScreen = new Map<string, Array<{ readonly href: string; readonly label: string }>>();
  for (const edge of flow.edges) {
    const from = String(edge.fromScreenId);
    const to = String(edge.toScreenId);
    const screen = screenIndex.get(from);
    if (screen === undefined) continue;
    const label = edge.label ?? "Continue";
    if (edge.fromNodeId !== undefined) {
      const hotspots = hotspotsByScreen.get(from) ?? new Map<string, string>();
      hotspots.set(String(edge.fromNodeId), anchorOf(to));
      hotspotsByScreen.set(from, hotspots);
      continue;
    }
    const links = linksByScreen.get(from) ?? [];
    links.push({ href: anchorOf(to), label });
    linksByScreen.set(from, links);
  }

  const sections = flow.screens.map((screen, index) => {
    const screenId = String(screen.screenId);
    const block = byBlockId.get(String(screen.blockId));
    const heading = escapeHtml(
      block?.kind === "mockup"
        ? block.title
        : block?.kind === "design"
          ? (block.frames.find((frame) => String(frame.frameId) === String(screen.frameId))
              ?.title ?? block.title)
          : flow.title,
    );
    let inner: string;
    if (block?.kind === "mockup") {
      const hotspots = hotspotsByScreen.get(screenId);
      inner = canvasMockupHtml(block, {
        ...(screen.variantId === undefined ? {} : { variantId: screen.variantId }),
        ...(hotspots === undefined ? {} : { hotspots }),
      });
    } else if (block?.kind === "design") {
      inner = input.designScreenHtml?.get(screenId) ?? "";
    } else {
      inner = "";
    }
    const links = linksByScreen.get(screenId) ?? [];
    const linkList =
      links.length === 0
        ? ""
        : `<nav class="oct-flow-links" aria-label="Continue from ${heading}">${links
            .map((link) => `<a href="${escapeHtml(link.href)}">${escapeHtml(link.label)} →</a>`)
            .join("")}</nav>`;
    const start = index === 0 ? ' data-start=""' : "";
    return `<section class="oct-flow-screen" id="oct-flow-${screenId}"${start} aria-label="${heading}"><h3>${heading}</h3>${inner}${linkList}</section>`;
  });

  return `<section class="oct-flow-site" aria-label="${escapeHtml(flow.title)}">${flowSiteStyles()}${sections.join("")}</section>`;
}
