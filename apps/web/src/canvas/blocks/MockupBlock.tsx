import type {
  CanvasMockupBlock,
  CanvasMockupComponent,
  CanvasMockupNode,
} from "@octant/contracts/canvas";

const COMPONENT_NAME: Record<CanvasMockupComponent, string> = {
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
};

const DEVICE_NAME = { desktop: "Desktop", tablet: "Tablet", phone: "Phone" } as const;

interface MockupBranchNode {
  readonly node: CanvasMockupNode;
  readonly children: ReadonlyArray<MockupBranchNode>;
}

function spoken(node: CanvasMockupNode): string {
  const name = `${COMPONENT_NAME[node.component]}, ${node.label}`;
  if (node.component !== "toggle") return name;
  return `${name}, ${node.on === true ? "on" : "off"}`;
}

function buildTree(nodes: ReadonlyArray<CanvasMockupNode>): ReadonlyArray<MockupBranchNode> {
  const ids = new Set(nodes.map((node) => String(node.nodeId)));
  const byParent = new Map<string, CanvasMockupNode[]>();
  for (const node of nodes) {
    const parent =
      node.parentId !== undefined && ids.has(String(node.parentId)) ? String(node.parentId) : "";
    const list = byParent.get(parent) ?? [];
    list.push(node);
    byParent.set(parent, list);
  }
  const build = (parentId: string): ReadonlyArray<MockupBranchNode> =>
    (byParent.get(parentId) ?? []).map((node) => ({
      node,
      children: build(String(node.nodeId)),
    }));
  return build("");
}

export function MockupBlock({ block }: { readonly block: CanvasMockupBlock }) {
  const tree = buildTree(block.nodes);
  return (
    <section
      className={`canvas-mockup canvas-mockup--${block.device}`}
      aria-label={`${block.title}, ${DEVICE_NAME[block.device]} mockup`}
      aria-roledescription="mockup"
      data-device={block.device}
    >
      <div className="canvas-mockup__frame" data-device={block.device}>
        <div className="canvas-mockup__chrome" aria-hidden="true">
          <span className="canvas-mockup__chrome-title">{block.title}</span>
          <span className="canvas-mockup__chrome-device">{DEVICE_NAME[block.device]}</span>
        </div>
        <ul className="canvas-mockup__tree" role="tree" aria-label={block.title}>
          {tree.map((branch) => (
            <MockupItem key={String(branch.node.nodeId)} branch={branch} />
          ))}
        </ul>
      </div>
    </section>
  );
}

function MockupItem({ branch }: { readonly branch: MockupBranchNode }) {
  if (branch.node.component === "window") {
    return (
      <li
        className="canvas-mockup__window"
        role="treeitem"
        aria-disabled="true"
        aria-label={spoken(branch.node)}
        data-component="window"
      >
        <WindowBody branches={branch.children} />
      </li>
    );
  }
  // A tabs node draws every child as a strip label in its Face; only the
  // selected tab — the first child, since this wireframe never changes
  // selection — also gets the panel beneath the strip. The other children
  // stay labels: a wireframe shows one tab's content, not all of them at once.
  const panel = branch.node.component === "tabs" ? branch.children.slice(0, 1) : branch.children;
  return (
    <li
      className={`canvas-mockup__node canvas-mockup__node--${branch.node.component}`}
      role="treeitem"
      aria-disabled="true"
      aria-label={spoken(branch.node)}
      data-component={branch.node.component}
    >
      <span className="canvas-mockup__face" aria-hidden="true">
        <Face branch={branch} />
      </span>
      <MockupGroup branches={panel} />
    </li>
  );
}

function WindowBody({ branches }: { readonly branches: ReadonlyArray<MockupBranchNode> }) {
  const header = branches.filter((branch) => branch.node.component === "header");
  const sidebar = branches.filter((branch) => branch.node.component === "sidebar");
  const main = branches.filter(
    (branch) => branch.node.component !== "header" && branch.node.component !== "sidebar",
  );
  return (
    <>
      {header.length === 0 ? null : (
        <div className="canvas-mockup__header-slot">
          <MockupGroup branches={header} />
        </div>
      )}
      <div className="canvas-mockup__columns">
        {sidebar.length === 0 ? null : (
          <div className="canvas-mockup__sidebar-slot">
            <MockupGroup branches={sidebar} />
          </div>
        )}
        <div className="canvas-mockup__main">
          <MockupGroup branches={main} />
        </div>
      </div>
    </>
  );
}

function MockupGroup({ branches }: { readonly branches: ReadonlyArray<MockupBranchNode> }) {
  if (branches.length === 0) return null;
  return (
    <ul role="group">
      {branches.map((branch) => (
        <MockupItem key={String(branch.node.nodeId)} branch={branch} />
      ))}
    </ul>
  );
}

function Face({ branch }: { readonly branch: MockupBranchNode }) {
  const { node, children } = branch;
  switch (node.component) {
    case "form-field":
      return (
        <span className="canvas-mockup__field">
          <span className="canvas-mockup__label">{node.label}</span>
          <span className="canvas-mockup__field-box" />
        </span>
      );
    case "button":
      return <span className="canvas-mockup__button">{node.label}</span>;
    case "toggle":
      return (
        <span className="canvas-mockup__toggle">
          <span className="canvas-mockup__label">{node.label}</span>
          <span className={`canvas-mockup__switch${node.on === true ? " is-on" : ""}`}>
            <span className="canvas-mockup__knob" />
          </span>
        </span>
      );
    case "tabs":
      return (
        <span className="canvas-mockup__tab-strip">
          {children.map((child, index) => (
            <span
              key={String(child.node.nodeId)}
              className={`canvas-mockup__tab${index === 0 ? " is-shown" : ""}`}
            >
              {child.node.label}
            </span>
          ))}
        </span>
      );
    case "image-placeholder":
      return (
        <span className="canvas-mockup__image">
          <span className="canvas-mockup__label">{node.label}</span>
        </span>
      );
    case "window":
    case "header":
    case "sidebar":
    case "list":
    case "list-row":
    case "card":
    case "text":
      return <span className="canvas-mockup__label">{node.label}</span>;
    default: {
      const exhaustive: never = node.component;
      return exhaustive;
    }
  }
}
