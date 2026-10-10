import type { CSSProperties } from "react";
import {
  Bell,
  Calendar,
  Check,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  File,
  Filter,
  Folder,
  House,
  Info,
  Lock,
  Mail,
  Menu,
  Pencil,
  Plus,
  Search,
  Settings,
  Share2,
  Star,
  Trash2,
  TriangleAlert,
  User,
  X,
  type LucideIcon,
} from "lucide-react";
import type {
  CanvasMockupBlock,
  CanvasMockupComponent,
  CanvasMockupIcon,
  CanvasMockupNode,
} from "@octant/contracts/canvas";
import {
  CANVAS_MOCKUP_DEVICE_NAME,
  canvasMockupCallouts,
  canvasMockupFrames,
  canvasMockupNodeReading,
  type CanvasMockupBranch,
} from "@octant/domain";

// The bundled icon set: each meaning in the contract maps to one glyph here.
const ICON: Record<CanvasMockupIcon, LucideIcon> = {
  search: Search,
  settings: Settings,
  user: User,
  bell: Bell,
  home: House,
  plus: Plus,
  close: X,
  check: Check,
  "chevron-right": ChevronRight,
  "chevron-down": ChevronDown,
  menu: Menu,
  more: Ellipsis,
  mail: Mail,
  lock: Lock,
  calendar: Calendar,
  folder: Folder,
  file: File,
  trash: Trash2,
  edit: Pencil,
  star: Star,
  share: Share2,
  filter: Filter,
  info: Info,
  warning: TriangleAlert,
};

// Layout containers draw their children, not their own label; the label is
// still the item's spoken name.
const CONTAINERS: ReadonlySet<CanvasMockupComponent> = new Set([
  "list",
  "stack",
  "row",
  "grid",
  "nav",
]);

/** Callout numbers by node id: a callout's number is its place in the list. */
type Callouts = ReadonlyMap<string, number>;

function spoken(node: CanvasMockupNode, callouts: Callouts): string {
  return canvasMockupNodeReading(node, callouts.get(String(node.nodeId)));
}

function frameStyle(block: CanvasMockupBlock): CSSProperties | undefined {
  if (block.size === undefined) return undefined;
  // A custom frame is drawn at its own aspect, no wider than the column.
  return {
    "--canvas-mockup-frame-w": `${String(block.size.width)}px`,
    "--canvas-mockup-frame-ratio": `${String(block.size.width)} / ${String(block.size.height)}`,
  } as CSSProperties;
}

export function MockupBlock({ block }: { readonly block: CanvasMockupBlock }) {
  const fidelity = block.fidelity ?? "wireframe";
  const callouts = canvasMockupCallouts(block);
  const labels = new Map(block.nodes.map((node) => [String(node.nodeId), node.label]));
  const frames = canvasMockupFrames(block);
  const deviceDetail =
    block.size === undefined
      ? CANVAS_MOCKUP_DEVICE_NAME[block.device]
      : `${String(block.size.width)} × ${String(block.size.height)}`;
  return (
    <div className="canvas-mockup-block">
      <section
        className={`canvas-mockup canvas-mockup--${block.device} canvas-mockup--${fidelity}`}
        aria-label={`${block.title}, ${CANVAS_MOCKUP_DEVICE_NAME[block.device]} mockup`}
        aria-roledescription="mockup"
        data-device={block.device}
        data-fidelity={fidelity}
      >
        <div className="canvas-mockup__frames" data-count={frames.length}>
          {frames.map((frame) => (
            <figure key={frame.key} className="canvas-mockup__variant">
              {frame.label === undefined ? null : (
                <figcaption className="canvas-mockup__variant-label">{frame.label}</figcaption>
              )}
              <div
                className="canvas-mockup__frame"
                data-device={block.device}
                style={frameStyle(block)}
              >
                <div className="canvas-mockup__chrome" aria-hidden="true">
                  <span className="canvas-mockup__chrome-dots" />
                  <span className="canvas-mockup__chrome-title">{block.title}</span>
                  <span className="canvas-mockup__chrome-device">{deviceDetail}</span>
                </div>
                <div className="canvas-mockup__screen">
                  <ul
                    className="canvas-mockup__tree"
                    role="tree"
                    aria-label={
                      frame.label === undefined ? block.title : `${frame.label}: ${block.title}`
                    }
                  >
                    {frame.roots.map((branch) => (
                      <MockupItem
                        key={String(branch.node.nodeId)}
                        branch={branch}
                        callouts={callouts}
                      />
                    ))}
                  </ul>
                </div>
              </div>
            </figure>
          ))}
        </div>
      </section>
      {block.annotations === undefined || block.annotations.length === 0 ? null : (
        <ol className="canvas-mockup__callouts" aria-label={`Callouts on ${block.title}`}>
          {block.annotations.map((annotation, index) => (
            <li key={String(annotation.nodeId)} className="canvas-mockup__callout">
              <span className="canvas-mockup__callout-mark" aria-hidden="true">
                {index + 1}
              </span>
              <span>
                <span className="canvas-mockup__callout-target">
                  {labels.get(String(annotation.nodeId)) ?? String(annotation.nodeId)}
                </span>
                {` — ${annotation.note}`}
              </span>
            </li>
          ))}
        </ol>
      )}
      <details className="canvas-mockup__outline">
        <summary>Outline</summary>
        {frames.map((frame) => (
          <div key={frame.key} className="canvas-mockup__outline-frame">
            {frame.label === undefined ? null : (
              <p className="canvas-mockup__outline-variant">{frame.label}</p>
            )}
            <MockupOutline branches={frame.roots} callouts={callouts} />
          </div>
        ))}
      </details>
    </div>
  );
}

/**
 * The component tree as a plain nested list: what a reader gets when the
 * drawing does not suit them, and what the Markdown and HTML exports write.
 */
function MockupOutline({
  branches,
  callouts,
}: {
  readonly branches: ReadonlyArray<CanvasMockupBranch>;
  readonly callouts: Callouts;
}) {
  if (branches.length === 0) return null;
  return (
    <ul>
      {branches.map((branch) => (
        <li key={String(branch.node.nodeId)}>
          {spoken(branch.node, callouts)}
          <MockupOutline branches={branch.children} callouts={callouts} />
        </li>
      ))}
    </ul>
  );
}

function MockupItem({
  branch,
  callouts,
}: {
  readonly branch: CanvasMockupBranch;
  readonly callouts: Callouts;
}) {
  const { node } = branch;
  const callout = callouts.get(String(node.nodeId));
  const common = {
    role: "treeitem",
    "aria-disabled": true,
    "aria-label": spoken(node, callouts),
    "data-component": node.component,
    ...(node.tone === undefined ? {} : { "data-tone": node.tone }),
  } as const;
  if (node.component === "window") {
    return (
      <li className="canvas-mockup__window" {...common}>
        {callout === undefined ? null : (
          <span className="canvas-mockup__face canvas-mockup__window-mark" aria-hidden="true">
            <CalloutMark number={callout} />
          </span>
        )}
        <WindowBody branches={branch.children} callouts={callouts} />
      </li>
    );
  }
  if (node.component === "modal") {
    return (
      <li className="canvas-mockup__node canvas-mockup__node--modal" {...common}>
        <div className="canvas-mockup__modal-box">
          <span className="canvas-mockup__face" aria-hidden="true">
            <CalloutMark number={callout} />
            <span className="canvas-mockup__modal-title">{node.label}</span>
          </span>
          <MockupGroup branches={branch.children} callouts={callouts} />
        </div>
      </li>
    );
  }
  // A tabs node draws every child as a strip label in its Face; only the
  // selected tab — the first child, since this wireframe never changes
  // selection — also gets the panel beneath the strip. The other children
  // stay labels: a wireframe shows one tab's content, not all of them at once.
  const panel = node.component === "tabs" ? branch.children.slice(0, 1) : branch.children;
  const style =
    node.component === "grid"
      ? ({ "--canvas-mockup-grid-columns": String(node.gridColumns ?? 2) } as CSSProperties)
      : undefined;
  return (
    <li
      className={`canvas-mockup__node canvas-mockup__node--${node.component}${node.on === true ? " is-on" : ""}`}
      {...common}
      style={style}
    >
      {CONTAINERS.has(node.component) && callout === undefined ? null : (
        <span className="canvas-mockup__face" aria-hidden="true">
          <CalloutMark number={callout} />
          {CONTAINERS.has(node.component) ? null : <Face branch={branch} />}
        </span>
      )}
      <MockupGroup branches={panel} callouts={callouts} />
    </li>
  );
}

function CalloutMark({ number }: { readonly number: number | undefined }) {
  if (number === undefined) return null;
  return <span className="canvas-mockup__callout-mark">{number}</span>;
}

function WindowBody({
  branches,
  callouts,
}: {
  readonly branches: ReadonlyArray<CanvasMockupBranch>;
  readonly callouts: Callouts;
}) {
  const header = branches.filter((branch) => branch.node.component === "header");
  const sidebar = branches.filter((branch) => branch.node.component === "sidebar");
  const main = branches.filter(
    (branch) => branch.node.component !== "header" && branch.node.component !== "sidebar",
  );
  return (
    <>
      {header.length === 0 ? null : (
        <div className="canvas-mockup__header-slot">
          <MockupGroup branches={header} callouts={callouts} />
        </div>
      )}
      <div className="canvas-mockup__columns">
        {sidebar.length === 0 ? null : (
          <div className="canvas-mockup__sidebar-slot">
            <MockupGroup branches={sidebar} callouts={callouts} />
          </div>
        )}
        <div className="canvas-mockup__main">
          <MockupGroup branches={main} callouts={callouts} />
        </div>
      </div>
    </>
  );
}

function MockupGroup({
  branches,
  callouts,
}: {
  readonly branches: ReadonlyArray<CanvasMockupBranch>;
  readonly callouts: Callouts;
}) {
  if (branches.length === 0) return null;
  return (
    <ul role="group">
      {branches.map((branch) => (
        <MockupItem key={String(branch.node.nodeId)} branch={branch} callouts={callouts} />
      ))}
    </ul>
  );
}

function Glyph({ icon }: { readonly icon: CanvasMockupIcon | undefined }) {
  if (icon === undefined) return null;
  const Icon = ICON[icon];
  return <Icon className="canvas-mockup__glyph" size={14} strokeWidth={1.75} />;
}

function initials(label: string): string {
  return label
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}

function Face({ branch }: { readonly branch: CanvasMockupBranch }) {
  const { node, children } = branch;
  switch (node.component) {
    case "form-field":
      return (
        <span className="canvas-mockup__field">
          <span className="canvas-mockup__label">{node.label}</span>
          <span className="canvas-mockup__field-box">
            {node.value === undefined ? null : (
              <span className="canvas-mockup__value">{node.value}</span>
            )}
          </span>
        </span>
      );
    case "select":
      return (
        <span className="canvas-mockup__field">
          <span className="canvas-mockup__label">{node.label}</span>
          <span className="canvas-mockup__field-box canvas-mockup__field-box--select">
            <span className="canvas-mockup__value">{node.value ?? ""}</span>
            <ChevronDown className="canvas-mockup__glyph" size={14} strokeWidth={1.75} />
          </span>
        </span>
      );
    case "button":
      return (
        <span className="canvas-mockup__button">
          <Glyph icon={node.icon} />
          {node.label}
        </span>
      );
    case "toggle":
      return (
        <span className="canvas-mockup__toggle">
          <span className="canvas-mockup__label">{node.label}</span>
          <span className={`canvas-mockup__switch${node.on === true ? " is-on" : ""}`}>
            <span className="canvas-mockup__knob" />
          </span>
        </span>
      );
    case "checkbox":
      return (
        <span className="canvas-mockup__check">
          <span className={`canvas-mockup__box${node.on === true ? " is-on" : ""}`}>
            {node.on === true ? <Check size={12} strokeWidth={2.5} /> : null}
          </span>
          <span className="canvas-mockup__label">{node.label}</span>
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
    case "table":
      return (
        <table className="canvas-mockup__table">
          <thead>
            <tr>
              {(node.columns ?? []).map((column, index) => (
                <th key={index}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(node.rows ?? []).map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((value, index) => (
                  <td key={index}>{value}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    case "avatar":
      return <span className="canvas-mockup__avatar">{initials(node.label)}</span>;
    case "badge":
      return <span className="canvas-mockup__badge">{node.label}</span>;
    case "icon":
      return (
        <span className="canvas-mockup__icon">
          <Glyph icon={node.icon ?? "info"} />
        </span>
      );
    case "toast":
      return <span className="canvas-mockup__toast">{node.label}</span>;
    case "heading":
      return <span className="canvas-mockup__heading">{node.label}</span>;
    case "list-row":
      return (
        <span className="canvas-mockup__row-face">
          <Glyph icon={node.icon} />
          <span className="canvas-mockup__label">{node.label}</span>
        </span>
      );
    case "header":
      return <span className="canvas-mockup__header-title">{node.label}</span>;
    case "window":
    case "modal":
    case "sidebar":
    case "list":
    case "stack":
    case "row":
    case "grid":
    case "nav":
    case "card":
    case "text":
      return <span className="canvas-mockup__label">{node.label}</span>;
    default: {
      const exhaustive: never = node.component;
      return exhaustive;
    }
  }
}
