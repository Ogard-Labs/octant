import type {
  CanvasMockupBlock,
  CanvasMockupComponent,
  CanvasMockupDevice,
  CanvasMockupNode,
} from "@octant/contracts/canvas";

/** What a reader calls each component: the spoken and exported name. */
export const CANVAS_MOCKUP_COMPONENT_NAME: Readonly<Record<CanvasMockupComponent, string>> = {
  window: "Window",
  header: "Header",
  sidebar: "Sidebar",
  list: "List",
  "list-row": "List row",
  "form-field": "Form field",
  button: "Button",
  toggle: "Toggle",
  tabs: "Tabs",
  card: "Card",
  "image-placeholder": "Image placeholder",
  text: "Text",
  stack: "Stack",
  row: "Row",
  grid: "Grid",
  heading: "Heading",
  select: "Select",
  checkbox: "Checkbox",
  table: "Table",
  avatar: "Avatar",
  badge: "Badge",
  icon: "Icon",
  nav: "Navigation",
  modal: "Modal",
  toast: "Toast",
};

export const CANVAS_MOCKUP_DEVICE_NAME: Readonly<Record<CanvasMockupDevice, string>> = {
  desktop: "Desktop",
  browser: "Browser",
  tablet: "Tablet",
  phone: "Phone",
  "dock-panel": "Dock panel",
  custom: "Custom",
};

export interface CanvasMockupBranch {
  readonly node: CanvasMockupNode;
  readonly children: ReadonlyArray<CanvasMockupBranch>;
}

/** One drawn frame: the whole screen, or one variant of it. */
export interface CanvasMockupFrame {
  readonly key: string;
  readonly label: string | undefined;
  readonly roots: ReadonlyArray<CanvasMockupBranch>;
}

/** Callout numbers by node id: a callout's number is its place in the list. */
export function canvasMockupCallouts(block: CanvasMockupBlock): ReadonlyMap<string, number> {
  return new Map(
    (block.annotations ?? []).map((annotation, index) => [String(annotation.nodeId), index + 1]),
  );
}

/**
 * A node as a reader hears it: its component and label, then what the drawing
 * shows about it (a value, a state, a tone, a table's shape, a callout). The
 * screen speaks it, the outline lists it, and the exports write it, so all
 * three say the same thing.
 */
export function canvasMockupNodeReading(node: CanvasMockupNode, callout?: number): string {
  const parts = [CANVAS_MOCKUP_COMPONENT_NAME[node.component], node.label];
  if (node.value !== undefined) parts.push(node.value);
  if (node.component === "toggle") parts.push(node.on === true ? "on" : "off");
  if (node.component === "checkbox") parts.push(node.on === true ? "checked" : "not checked");
  if (node.component === "list-row" && node.on === true) parts.push("current");
  if (node.tone !== undefined && node.tone !== "neutral") parts.push(node.tone);
  if (node.component === "table") {
    const columns = node.columns ?? [];
    const rows = node.rows?.length ?? 0;
    parts.push(
      `${String(columns.length)} ${columns.length === 1 ? "column" : "columns"}: ${columns.join(", ")}`,
      `${String(rows)} ${rows === 1 ? "row" : "rows"}`,
    );
  }
  if (callout !== undefined) parts.push(`callout ${String(callout)}`);
  return parts.join(", ");
}

/**
 * The block's frames, each a tree built from the parent chain. A parent the
 * block does not hold puts the node at the top level rather than dropping it;
 * the domain policy refuses such a block before it is stored.
 */
export function canvasMockupFrames(block: CanvasMockupBlock): ReadonlyArray<CanvasMockupFrame> {
  const ids = new Set(block.nodes.map((node) => String(node.nodeId)));
  const byParent = new Map<string, CanvasMockupNode[]>();
  for (const node of block.nodes) {
    const parent =
      node.parentId !== undefined && ids.has(String(node.parentId)) ? String(node.parentId) : "";
    const list = byParent.get(parent) ?? [];
    list.push(node);
    byParent.set(parent, list);
  }
  const build = (parentId: string, seen: ReadonlySet<string>): ReadonlyArray<CanvasMockupBranch> =>
    (byParent.get(parentId) ?? [])
      .filter((node) => !seen.has(String(node.nodeId)))
      .map((node) => ({
        node,
        children: build(String(node.nodeId), new Set([...seen, String(node.nodeId)])),
      }));
  const roots = build("", new Set());
  if (block.variants === undefined) return [{ key: "screen", label: undefined, roots }];
  return block.variants.map((variant) => ({
    key: String(variant.variantId),
    label: variant.label,
    roots: roots.filter((branch) => String(branch.node.variantId) === String(variant.variantId)),
  }));
}
