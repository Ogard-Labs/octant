import {
  CANVAS_MOCKUP_COMPONENT_NAME,
  canvasMockupFrames,
  type CanvasMockupBranch,
} from "./canvasMockupOutline";
import type { CanvasMockupBlock, CanvasMockupNode } from "@octant/contracts/canvas";

/**
 * One mockup variant as a semantic, inert web page.
 *
 * The catalog is closed and typed, so a mockup can be rendered as honest HTML
 * without a script: every control is a real element a reader and a browser
 * understand, disabled where it is drawn disabled, and the nodes a flow names
 * as hotspots become real anchors to the targets the caller passes. Pure and
 * deterministic, so the app's player and an export generate the same shape.
 */

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

export interface CanvasMockupHtmlOptions {
  /** The variant to render; the block's single frame when omitted. */
  readonly variantId?: string | undefined;
  /**
   * The nodes the page should make navigable, by node id: the anchor each
   * becomes the value. Every other node stays inert.
   */
  readonly hotspots?: ReadonlyMap<string, string> | undefined;
}

/** One rendered element: its markup, and the heading level its children start at. */
interface Rendered {
  readonly markup: string;
  readonly headingLevel: number;
}

function nodeLabel(node: CanvasMockupNode): string {
  return escapeHtml(node.label);
}

function initials(label: string): string {
  return label
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase())
    .slice(0, 2)
    .join("");
}

function table(node: CanvasMockupNode): string {
  const columns = node.columns ?? [];
  const rows = node.rows ?? [];
  const head =
    columns.length === 0
      ? ""
      : `<thead><tr>${columns.map((column) => `<th scope="col">${escapeHtml(column)}</th>`).join("")}</tr></thead>`;
  const body =
    rows.length === 0
      ? ""
      : `<tbody>${rows
          .map(
            (cells) =>
              `<tr>${columns.map((_column, index) => `<td>${escapeHtml(cells[index] ?? "")}</td>`).join("")}</tr>`,
          )
          .join("")}</tbody>`;
  return `<table class="oct-mockup-table">${head}${body}</table>`;
}

/** The children a node shows: every kind except tabs shows all; tabs shows the first. */
function shownChildren(branch: CanvasMockupBranch): ReadonlyArray<CanvasMockupBranch> {
  return branch.node.component === "tabs" ? branch.children.slice(0, 1) : branch.children;
}

function renderNode(
  branch: CanvasMockupBranch,
  hotspots: ReadonlyMap<string, string>,
  headingLevel: number,
): Rendered {
  const { node } = branch;
  const label = nodeLabel(node);
  const name = CANVAS_MOCKUP_COMPONENT_NAME[node.component];
  const children = shownChildren(branch);
  const childMarkup = children
    .map((child) => renderNode(child, hotspots, Math.min(headingLevel + 1, 6)).markup)
    .join("");
  // A hotspot is the one thing on the page that goes somewhere: the anchor a
  // flow's edge named, so the page's links are exactly the author's transitions.
  const anchor = hotspots.get(String(node.nodeId));
  const hotspotMarkup =
    anchor === undefined
      ? ""
      : `<a class="oct-mockup-hotspot" href="${escapeHtml(anchor)}">${label}</a>`;
  const hotspotLabel = `<span class="oct-mockup-part" data-component="${node.component}">${hotspotMarkup.length > 0 ? hotspotMarkup : label}</span>`;

  switch (node.component) {
    case "window": {
      const header = children.filter((child) => child.node.component === "header");
      const sidebar = children.filter((child) => child.node.component === "sidebar");
      const main = children.filter(
        (child) => child.node.component !== "header" && child.node.component !== "sidebar",
      );
      const render = (list: ReadonlyArray<CanvasMockupBranch>) =>
        list.map((child) => renderNode(child, hotspots, headingLevel).markup).join("");
      return {
        markup: `<section class="oct-mockup-window" aria-label="${label}">${render(header)}${render(sidebar)}${render(main)}</section>`,
        headingLevel,
      };
    }
    case "header":
      return {
        markup: `<header class="oct-mockup-header">${hotspotLabel}${childMarkup}</header>`,
        headingLevel,
      };
    case "sidebar":
      return {
        markup: `<aside class="oct-mockup-sidebar">${hotspotLabel}${childMarkup}</aside>`,
        headingLevel,
      };
    case "nav":
      return { markup: `<nav aria-label="${label}">${childMarkup}</nav>`, headingLevel };
    case "list":
      return {
        markup: `<ul class="oct-mockup-list" aria-label="${label}">${childMarkup}</ul>`,
        headingLevel,
      };
    case "list-row":
      return {
        markup: `<li class="oct-mockup-row${node.on === true ? " is-current" : ""}">${hotspotMarkup.length > 0 ? hotspotMarkup : label}</li>`,
        headingLevel,
      };
    case "heading":
      return {
        markup: `<h${String(Math.min(headingLevel, 6))}>${label}</h${String(Math.min(headingLevel, 6))}>`,
        headingLevel: Math.min(headingLevel + 1, 6),
      };
    case "text":
      return { markup: `<p>${label}</p>`, headingLevel };
    case "card":
      return {
        markup: `<div class="oct-mockup-card">${hotspotLabel}${childMarkup}</div>`,
        headingLevel,
      };
    case "stack":
    case "row":
    case "grid":
      return {
        markup: `<div class="oct-mockup-${node.component}">${hotspotLabel}${childMarkup}</div>`,
        headingLevel,
      };
    case "form-field":
    case "select":
      return {
        markup: `<p class="oct-mockup-field"><span>${label}</span>${node.value === undefined ? "" : `<data value="${escapeHtml(node.value)}">${escapeHtml(node.value)}</data>`}</p>`,
        headingLevel,
      };
    case "button":
      return {
        markup:
          hotspotMarkup.length > 0
            ? hotspotMarkup
            : `<button class="oct-mockup-button" type="button" disabled>${label}</button>`,
        headingLevel,
      };
    case "toggle":
    case "checkbox":
      return {
        markup: `<p class="oct-mockup-check"><input type="checkbox" disabled${node.on === true ? " checked" : ""} aria-label="${label}"> <span>${label}</span></p>`,
        headingLevel,
      };
    case "tabs": {
      const strip = branch.children.map((child) => `<li>${nodeLabel(child.node)}</li>`).join("");
      return {
        markup: `<div class="oct-mockup-tabs"><ul class="oct-mockup-tabstrip">${strip}</ul>${childMarkup}</div>`,
        headingLevel,
      };
    }
    case "table":
      return {
        markup: `<p class="oct-mockup-part">${name}: ${label}</p>${table(node)}`,
        headingLevel,
      };
    case "image-placeholder":
      return {
        markup: `<figure class="oct-mockup-image"><figcaption>${label}</figcaption></figure>`,
        headingLevel,
      };
    case "avatar":
      return {
        markup: `<p class="oct-mockup-avatar"><span aria-hidden="true">${escapeHtml(initials(node.label))}</span><span>${label}</span></p>`,
        headingLevel,
      };
    case "badge":
      return {
        markup: `<p><span class="oct-mockup-badge"${node.tone === undefined ? "" : ` data-tone="${node.tone}"`}>${label}</span></p>`,
        headingLevel,
      };
    case "icon":
      return { markup: `<p class="oct-mockup-part">${name}: ${label}</p>`, headingLevel };
    case "modal":
      return {
        markup: `<div class="oct-mockup-modal" role="dialog" aria-label="${label}">${hotspotLabel}${childMarkup}</div>`,
        headingLevel,
      };
    case "toast":
      return { markup: `<p class="oct-mockup-toast">${label}</p>`, headingLevel };
  }
}

/**
 * The block's page: one frame's tree rendered as semantic HTML. The frame is
 * the named variant, or the single frame of a block without variants.
 */
export function canvasMockupHtml(
  block: CanvasMockupBlock,
  options: CanvasMockupHtmlOptions = {},
): string {
  const hotspots = options.hotspots ?? new Map<string, string>();
  const frames = canvasMockupFrames(block);
  const frame =
    options.variantId === undefined
      ? frames[0]
      : frames.find((candidate) => candidate.key === String(options.variantId));
  if (frame === undefined) return "";
  const body = frame.roots.map((branch) => renderNode(branch, hotspots, 2).markup).join("");
  const title = escapeHtml(
    frame.label === undefined ? block.title : `${frame.label}: ${block.title}`,
  );
  return `<section class="oct-mockup-page" aria-label="${title}"><h2>${title}</h2>${body}</section>`;
}

/** The small neutral stylesheet a generated mockup page carries. */
export const CANVAS_MOCKUP_HTML_STYLES = [
  ".oct-mockup-page { font-family: system-ui, sans-serif; color: #1c1c22; background: #fff; padding: 16px; max-width: 720px; margin: 0 auto; }",
  ".oct-mockup-window { display: grid; gap: 12px; }",
  ".oct-mockup-header, .oct-mockup-sidebar { color: #52525b; }",
  ".oct-mockup-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }",
  ".oct-mockup-row { padding: 6px 8px; border: 1px solid #d4d4d8; border-radius: 6px; }",
  ".oct-mockup-row.is-current { background: #f4f4f5; }",
  ".oct-mockup-button { padding: 6px 12px; border: 1px solid #a1a1aa; border-radius: 6px; background: #fafafa; color: inherit; }",
  ".oct-mockup-hotspot { display: inline-block; padding: 6px 12px; border: 1px solid #18181b; border-radius: 6px; background: #18181b; color: #fff; text-decoration: none; }",
  ".oct-mockup-field { display: grid; gap: 2px; }",
  ".oct-mockup-field data { border: 1px solid #d4d4d8; border-radius: 6px; padding: 6px 8px; background: #fafafa; }",
  ".oct-mockup-card { border: 1px solid #d4d4d8; border-radius: 8px; padding: 12px; display: grid; gap: 8px; }",
  ".oct-mockup-stack, .oct-mockup-row, .oct-mockup-grid { display: grid; gap: 8px; }",
  ".oct-mockup-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }",
  ".oct-mockup-tabstrip { display: flex; gap: 8px; list-style: none; margin: 0 0 8px; padding: 0; color: #52525b; }",
  ".oct-mockup-table { border-collapse: collapse; width: 100%; }",
  ".oct-mockup-table th, .oct-mockup-table td { border: 1px solid #d4d4d8; padding: 6px 8px; text-align: left; }",
  ".oct-mockup-image { border: 1px dashed #a1a1aa; border-radius: 8px; padding: 24px; text-align: center; color: #71717a; margin: 0; }",
  ".oct-mockup-avatar span:first-child { display: inline-grid; place-items: center; width: 28px; height: 28px; border-radius: 999px; background: #e4e4e7; margin-right: 6px; font-size: 12px; }",
  ".oct-mockup-badge { display: inline-block; padding: 2px 8px; border: 1px solid #a1a1aa; border-radius: 999px; font-size: 12px; }",
  ".oct-mockup-modal { border: 1px solid #a1a1aa; border-radius: 10px; padding: 16px; display: grid; gap: 8px; max-width: 320px; }",
  ".oct-mockup-toast { border: 1px solid #a1a1aa; border-radius: 999px; padding: 6px 12px; display: inline-block; }",
  ".oct-mockup-part { color: #52525b; }",
] as const;
