import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  browserAccessibilityTreeIsSound,
  type BrowserAccessibilityAction,
  type BrowserAccessibilityNode,
  type BrowserAccessibilityUpdate,
  type HumanBrowserResult,
} from "@octant/contracts/browser-presentation";

interface Mirror {
  readonly revision: number;
  readonly rootId: string;
  readonly focusedId: string | undefined;
  readonly nodes: ReadonlyMap<string, BrowserAccessibilityNode>;
}

/** Apply one update to the mirror Nightly holds; undefined asks Stable for the full tree. */
export function applyBrowserAccessibilityUpdate(
  held: Mirror | undefined,
  update: BrowserAccessibilityUpdate,
): Mirror | undefined {
  let nodes: Map<string, BrowserAccessibilityNode>;
  if (update.kind === "full") nodes = new Map(update.nodes.map((node) => [node.id, node]));
  else {
    if (held === undefined || held.revision !== update.base) return undefined;
    nodes = new Map(held.nodes);
    for (const id of update.removed) nodes.delete(id);
    for (const node of update.nodes) nodes.set(node.id, node);
  }
  const listed = [...nodes.values()];
  if (
    !browserAccessibilityTreeIsSound(listed, update.rootId) ||
    (update.focusedId !== undefined && !nodes.has(update.focusedId))
  )
    return undefined;
  return {
    revision: update.revision,
    rootId: update.rootId,
    focusedId: update.focusedId,
    nodes,
  };
}

/** The text a live region says: its own name and its descendants', in order. */
function spoken(nodes: ReadonlyMap<string, BrowserAccessibilityNode>, id: string): string {
  const parts: string[] = [];
  const walk = (at: string, depth: number) => {
    const node = nodes.get(at);
    if (node === undefined || depth > 64 || parts.length > 64) return;
    if (node.name !== undefined && (node.role === "text" || node.children.length === 0))
      parts.push(node.name);
    for (const child of node.children) walk(child, depth + 1);
  };
  walk(id, 0);
  return parts.join(" ").slice(0, 512);
}

const STEPPED = new Set(["slider", "spinbutton"]);
const FOCUS_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
  "gridcell",
]);
/** Roles whose own announcements the mirror's live region makes instead. */
const LIVE_ROLES = new Set(["alert", "log", "status"]);

/**
 * The page's accessibility tree, mirrored over the Browser image as a
 * positioned, visually transparent DOM subtree so VoiceOver can read and
 * operate it. It only describes: every action goes back to Stable as the
 * person's own input, and a password field has its role and name, never a
 * value. Nightly's main asks for it only while an assistive technology is on.
 */
export function EmbeddedBrowserAccessibility(props: {
  readonly presentationId: string | undefined;
  readonly execute: (request: Readonly<Record<string, unknown>>) => Promise<HumanBrowserResult>;
  readonly scaleX: number;
  readonly scaleY: number;
  /** Characters typed into a mirrored password field, sent on as typed characters. */
  readonly secureText: (text: string) => void;
}) {
  const [mirror, setMirror] = useState<Mirror | undefined>(undefined);
  const [polite, setPolite] = useState("");
  const [assertive, setAssertive] = useState("");
  const container = useRef<HTMLDivElement>(null);
  const latest = useRef({ mirror, props });
  latest.current = { mirror, props };
  const spokenText = useRef(new Map<string, string>());

  useEffect(() => {
    const presentationId = props.presentationId;
    setMirror(undefined);
    spokenText.current.clear();
    if (presentationId === undefined) return;
    let disposed = false;
    let held: Mirror | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pause = (ms: number) =>
      new Promise<void>((done) => {
        timer = setTimeout(done, ms);
      });
    void (async () => {
      while (!disposed) {
        const result = await latest.current.props
          .execute({ kind: "accessibility", presentationId, revision: held?.revision ?? 0 })
          .catch((): HumanBrowserResult => ({ status: "refused" }));
        if (disposed) return;
        if (result.status === "accessibility") {
          const next = applyBrowserAccessibilityUpdate(held, result.update);
          if (next === undefined) {
            held = undefined;
            continue;
          }
          const announcing = held !== undefined;
          held = next;
          // Announce what changed in the page's live regions, never the first read.
          for (const node of next.nodes.values()) {
            if (node.live === undefined) continue;
            const said = spoken(next.nodes, node.id);
            const before = spokenText.current.get(node.id);
            spokenText.current.set(node.id, said);
            if (announcing && said !== "" && said !== before)
              (node.live === "assertive" ? setAssertive : setPolite)(said);
          }
          setMirror(next);
        } else if (result.status === "idle") continue;
        else {
          // No assistive technology, a hidden view or a retired presentation.
          held = undefined;
          setMirror(undefined);
          await pause(1_000);
        }
      }
    })();
    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [props.presentationId]);

  // Focus follows the page's focused node while the person is in the mirror.
  useEffect(() => {
    const focusedId = mirror?.focusedId;
    const element = container.current;
    if (focusedId === undefined || element === null || !document.hasFocus()) return;
    const group = element.parentElement;
    const active = document.activeElement;
    if (
      active === null ||
      !(active === group || element.contains(active)) ||
      (active instanceof HTMLElement && active.dataset.mirrorId === focusedId)
    )
      return;
    const target = element.querySelector<HTMLElement>(`[data-mirror-id="${focusedId}"]`);
    target?.focus({ preventScroll: true });
  }, [mirror?.focusedId, mirror?.revision]);

  const act = (nodeId: string, action: BrowserAccessibilityAction) => {
    const held = latest.current.mirror;
    const presentationId = latest.current.props.presentationId;
    if (held === undefined || presentationId === undefined) return;
    void latest.current.props
      .execute({
        kind: "accessibility-action",
        presentationId,
        revision: held.revision,
        nodeId,
        action,
      })
      .catch(() => undefined);
  };

  if (mirror === undefined) return null;
  const render = (id: string, origin: { x: number; y: number }, depth: number): ReactNode => {
    const node = mirror.nodes.get(id);
    if (node === undefined || depth > 64) return null;
    const bounds = node.bounds;
    const style: CSSProperties = {
      position: "absolute",
      left: bounds === undefined ? 0 : (bounds.x - origin.x) * props.scaleX,
      top: bounds === undefined ? 0 : (bounds.y - origin.y) * props.scaleY,
      width: bounds === undefined ? 0 : bounds.width * props.scaleX,
      height: bounds === undefined ? 0 : bounds.height * props.scaleY,
      margin: 0,
      padding: 0,
      border: 0,
      background: "transparent",
      color: "transparent",
      caretColor: "transparent",
      outline: "none",
      overflow: "visible",
      font: "inherit",
      whiteSpace: "pre",
    };
    const childOrigin = bounds === undefined ? origin : { x: bounds.x, y: bounds.y };
    const children = node.children.map((child) => render(child, childOrigin, depth + 1));
    const focusable = node.focusable === true || FOCUS_ROLES.has(node.role);
    const common = {
      "data-mirror-id": node.id,
      style,
      ...(focusable ? { tabIndex: -1 } : {}),
      onFocus: (event: React.FocusEvent) => {
        if (event.target !== event.currentTarget) return;
        if (latest.current.mirror?.focusedId !== node.id && focusable)
          act(node.id, { action: "focus" });
      },
      onClick: (event: React.MouseEvent) => {
        event.stopPropagation();
        event.preventDefault();
        act(node.id, { action: "press" });
      },
      onKeyDown: (event: React.KeyboardEvent) => {
        // Trusted keys reach the page through the Browser group as typed; a
        // key an assistive technology made up for a step is its own action.
        if (event.nativeEvent.isTrusted) return;
        event.stopPropagation();
        event.preventDefault();
        if (!STEPPED.has(node.role)) return;
        if (event.key === "ArrowUp" || event.key === "ArrowRight")
          act(node.id, { action: "increment" });
        if (event.key === "ArrowDown" || event.key === "ArrowLeft")
          act(node.id, { action: "decrement" });
      },
      onKeyUp: (event: React.KeyboardEvent) => {
        if (!event.nativeEvent.isTrusted) event.stopPropagation();
      },
    };
    const states = {
      ...(node.description === undefined ? {} : { "aria-description": node.description }),
      ...(node.disabled === true ? { "aria-disabled": true } : {}),
      ...(node.required === true ? { "aria-required": true } : {}),
      ...(node.invalid === true ? { "aria-invalid": true } : {}),
      ...(node.readonly === true ? { "aria-readonly": true } : {}),
      ...(node.checked === undefined ? {} : { "aria-checked": node.checked }),
      ...(node.pressed === undefined ? {} : { "aria-pressed": node.pressed }),
      ...(node.expanded === undefined ? {} : { "aria-expanded": node.expanded }),
      ...(node.selected === undefined ? {} : { "aria-selected": node.selected }),
      ...(node.level === undefined ? {} : { "aria-level": node.level }),
      ...(node.valueNow === undefined ? {} : { "aria-valuenow": node.valueNow }),
      ...(node.valueMin === undefined ? {} : { "aria-valuemin": node.valueMin }),
      ...(node.valueMax === undefined ? {} : { "aria-valuemax": node.valueMax }),
      ...(STEPPED.has(node.role) && node.value !== undefined
        ? { "aria-valuetext": node.value }
        : {}),
    };
    if (node.role === "text")
      return (
        <span key={node.id} {...common}>
          {node.name}
        </span>
      );
    if (node.role === "textbox" || node.role === "searchbox") {
      if (node.secure === true)
        return (
          <input
            key={node.id}
            {...common}
            type="password"
            aria-label={node.name}
            autoComplete="off"
            {...states}
            onInput={(event) => {
              // A dead key composes here; the page gets the character, the field keeps nothing.
              const field = event.currentTarget;
              const typed = field.value;
              field.value = "";
              if (typed !== "") latest.current.props.secureText(typed);
            }}
          />
        );
      const field = {
        ...common,
        "aria-label": node.name,
        ...(node.role === "searchbox" ? { role: "searchbox" } : {}),
        value: node.value ?? "",
        readOnly: node.readonly === true,
        disabled: node.disabled === true,
        ...states,
        // Typing reaches the page as keys; only a value set some other way,
        // such as by an assistive technology or a finished composition, travels.
        onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
          if (!(event.nativeEvent as InputEvent).isComposing)
            act(node.id, { action: "set-value", value: event.currentTarget.value.slice(0, 1_024) });
        },
      };
      return node.multiline === true ? (
        <textarea key={node.id} {...field} />
      ) : (
        <input key={node.id} {...field} type="text" />
      );
    }
    const role =
      node.role === "generic" ? (node.name === undefined ? undefined : "group") : node.role;
    return (
      <div
        key={node.id}
        {...common}
        {...(role === undefined ? {} : { role })}
        {...(node.name === undefined || role === undefined ? {} : { "aria-label": node.name })}
        {...(LIVE_ROLES.has(node.role) ? { "aria-live": "off" as const } : {})}
        {...states}
      >
        {node.role === "combobox" && node.value !== undefined ? node.value : null}
        {children}
      </div>
    );
  };
  return (
    <div
      ref={container}
      data-testid="browser-accessibility-mirror"
      style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden" }}
    >
      {render(mirror.rootId, { x: 0, y: 0 }, 0)}
      <div
        role="status"
        aria-live="polite"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          overflow: "hidden",
          color: "transparent",
        }}
      >
        {polite}
      </div>
      <div
        role="alert"
        aria-live="assertive"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          overflow: "hidden",
          color: "transparent",
        }}
      >
        {assertive}
      </div>
    </div>
  );
}
