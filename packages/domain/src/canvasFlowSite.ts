import { CANVAS_MOCKUP_HTML_STYLES, canvasMockupPage } from "./canvasMockupHtml";
import type { CanvasDesignBlock, CanvasMockupBlock } from "@octant/contracts/canvas";
import type { CanvasFlowShape } from "./canvasFlowLayout";

/**
 * A flow as one self-contained section set that navigates without a script: every screen a
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

/**
 * The anchor a screen's section is reached at, stable for a screen id. A
 * screen id is unique only inside its flow, so a document with two flows
 * scopes each flow's anchors by the flow's block id; `~` is outside the id
 * alphabet, so two scoped anchors never collide.
 */
export function canvasFlowScreenAnchor(screenId: string, scope?: string): string {
  return scope === undefined ? `#oct-flow-${screenId}` : `#oct-flow-${scope}~${screenId}`;
}

export interface CanvasFlowSiteInput {
  readonly flow: CanvasFlowShape;
  /** The flow's block id, scoping its anchors when a page holds more than one flow. */
  readonly scope?: string | undefined;
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
  ".oct-flow-site:not(:has(.oct-flow-screen:target, .oct-flow-screen :target)) > .oct-flow-screen[data-start] { display: block; }",
  ".oct-flow-links { margin-top: 16px; display: flex; flex-wrap: wrap; gap: 8px; }",
  ".oct-flow-links a { padding: 6px 12px; border: 1px solid #18181b; border-radius: 6px; background: #18181b; color: #fff; text-decoration: none; }",
] as const;

/** The navigation rules and the generated mockup pages' own stylesheet. */
function flowSiteStyles(): string {
  return `<style>${[...CANVAS_FLOW_SITE_STYLES, ...CANVAS_MOCKUP_HTML_STYLES].join("")}</style>`;
}

/**
 * The flow's screens as one section set. The first screen is marked as the
 * start, so the page opens on it before any anchor is followed, and the start
 * rule is scoped to its own site so following an anchor in one flow never
 * hides another flow's start screen. Every transition whose edge names a
 * hotspot the screen's page draws reaches its target from inside that
 * drawing; the rest (a screen-level edge, or a hotspot the page cannot draw)
 * sit in an explicit link list, so no transition is left without a place to
 * tap.
 */
export function canvasFlowSite(input: CanvasFlowSiteInput): string {
  const { flow, blocks } = input;
  const byBlockId = new Map(blocks.map((block) => [String(block.blockId), block]));
  const screenIndex = new Map(flow.screens.map((screen) => [String(screen.screenId), screen]));
  const anchorOf = (screenId: string) => canvasFlowScreenAnchor(screenId, input.scope);

  // The hotspot anchors each mockup screen's generated page carries, and the
  // screen-level links listed beneath each screen.
  const hotspotsByScreen = new Map<string, Map<string, string>>();
  const hotspotEdgesByScreen = new Map<
    string,
    Array<{ readonly nodeId: string; readonly href: string; readonly label: string }>
  >();
  const linksByScreen = new Map<string, Array<{ readonly href: string; readonly label: string }>>();
  for (const edge of flow.edges) {
    const from = String(edge.fromScreenId);
    const to = String(edge.toScreenId);
    const screen = screenIndex.get(from);
    if (screen === undefined) continue;
    const label = edge.label ?? "Continue";
    const fromBlock = byBlockId.get(String(screen.blockId));
    if (edge.fromNodeId !== undefined && fromBlock?.kind === "mockup") {
      const hotspots = hotspotsByScreen.get(from) ?? new Map<string, string>();
      hotspots.set(String(edge.fromNodeId), anchorOf(to));
      hotspotsByScreen.set(from, hotspots);
      const hotspotEdges = hotspotEdgesByScreen.get(from) ?? [];
      hotspotEdges.push({ nodeId: String(edge.fromNodeId), href: anchorOf(to), label });
      hotspotEdgesByScreen.set(from, hotspotEdges);
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
    const links = [...(linksByScreen.get(screenId) ?? [])];
    if (block?.kind === "mockup") {
      const hotspots = hotspotsByScreen.get(screenId);
      const page = canvasMockupPage(block, {
        ...(screen.variantId === undefined ? {} : { variantId: screen.variantId }),
        ...(hotspots === undefined ? {} : { hotspots }),
      });
      inner = page.markup;
      for (const edge of hotspotEdgesByScreen.get(screenId) ?? []) {
        if (!page.linkedNodeIds.has(edge.nodeId))
          links.push({ href: edge.href, label: edge.label });
      }
    } else if (block?.kind === "design") {
      inner = input.designScreenHtml?.get(screenId) ?? "";
    } else {
      inner = "";
    }
    const linkList =
      links.length === 0
        ? ""
        : `<nav class="oct-flow-links" aria-label="Continue from ${heading}">${links
            .map((link) => `<a href="${escapeHtml(link.href)}">${escapeHtml(link.label)} →</a>`)
            .join("")}</nav>`;
    const start = index === 0 ? ' data-start=""' : "";
    return `<section class="oct-flow-screen" id="${escapeHtml(anchorOf(screenId).slice(1))}"${start} aria-label="${heading}"><h3>${heading}</h3>${inner}${linkList}</section>`;
  });

  return `<section class="oct-flow-site" aria-label="${escapeHtml(flow.title)}">${flowSiteStyles()}${sections.join("")}</section>`;
}
