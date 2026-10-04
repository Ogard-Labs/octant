import { createContext, useContext, useEffect, useRef, useState, type ComponentProps } from "react";
import type {
  NativeMenuEntry,
  NativeMenuRequest,
  NativeMenuOutcome,
} from "@octant/contracts/shell";
import * as Web from "../shadcn/context-menu";
import * as Dropdown from "../shadcn/dropdown-menu";

type RootProps = ComponentProps<typeof Web.ContextMenu>;
interface NativeContext {
  readonly open: boolean;
  readonly content: React.RefObject<HTMLDivElement | null>;
  readonly side: React.RefObject<string>;
}
export const Native = createContext<NativeContext | undefined>(undefined);

/** Render the same action composition privately; only the OS presents it. */
export function ContextMenu(props: RootProps) {
  const popup = window.octantHost?.popupNativeMenu;
  return popup === undefined ? (
    <Web.ContextMenu {...props} />
  ) : (
    <NativeRoot {...props} popup={popup} />
  );
}

type NativeRootProps = (
  | (RootProps & { readonly kind?: "context" })
  | (ComponentProps<typeof Dropdown.DropdownMenu> & { readonly kind: "dropdown" })
) & { readonly popup: (request: NativeMenuRequest) => Promise<NativeMenuOutcome> };

export function NativeRoot(props: NativeRootProps) {
  const content = useRef<HTMLDivElement>(null);
  const side = useRef("bottom");
  const [request, setRequest] = useState<{
    readonly close: () => void;
    readonly trigger: HTMLElement | null;
    readonly x: number;
    readonly y: number;
  }>();
  useEffect(() => {
    if (request === undefined || content.current === null) return;
    let active = true;
    const actions = new Map<string, HTMLElement>();
    const items = readEntries(content.current, "", actions, true);
    const bounds = request.trigger?.getBoundingClientRect();
    const beside = props.kind === "dropdown" && side.current === "right" && bounds !== undefined;
    const above = props.kind === "dropdown" && side.current === "top" && bounds !== undefined;
    void props
      .popup({
        x: beside ? bounds.right : request.x,
        y: beside || above ? bounds.top : request.y,
        items,
        ...(above ? { placement: "above" } : {}),
      })
      .then((outcome) => {
        if (!active) return;
        // Return focus before invoking the action, so a dialog opened by it owns
        // focus rather than having the menu steal it back afterward.
        request.trigger?.focus({ preventScroll: true });
        if (outcome.kind === "selected") {
          const action = actions.get(outcome.id);
          if (
            action?.isConnected &&
            action.dataset.nativeMenuEnabled !== "false" &&
            action.getAttribute("aria-disabled") !== "true"
          )
            action.click();
        }
        setRequest(undefined);
        request.close();
      });
    return () => {
      active = false;
    };
  }, [request, props.popup]);
  function show(event: Event, close: () => void) {
    const trigger =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-native-menu-trigger]")
        : null;
    const bounds = trigger?.getBoundingClientRect();
    const pointer =
      props.kind !== "dropdown" &&
      event instanceof MouseEvent &&
      (event.clientX !== 0 || event.clientY !== 0);
    setRequest({
      close,
      trigger,
      x: pointer ? event.clientX : (bounds?.left ?? 0),
      y: pointer ? event.clientY : (bounds?.bottom ?? 0),
    });
  }
  const root =
    props.kind === "dropdown" ? (
      <Dropdown.DropdownMenu
        {...props}
        open={false}
        onOpenChange={(open, details) => {
          if (!open) return;
          props.onOpenChange?.(true, details);
          if (!details.isCanceled) show(details.event, () => props.onOpenChange?.(false, details));
        }}
      />
    ) : (
      <Web.ContextMenu
        {...props}
        open={false}
        onOpenChange={(open, details) => {
          if (!open) return;
          props.onOpenChange?.(true, details);
          if (!details.isCanceled) show(details.event, () => props.onOpenChange?.(false, details));
        }}
      />
    );
  return (
    <Native.Provider value={{ open: request !== undefined, content, side }}>{root}</Native.Provider>
  );
}

export function ContextMenuTrigger(props: ComponentProps<typeof Web.ContextMenuTrigger>) {
  const native = useContext(Native);
  return (
    <Web.ContextMenuTrigger
      {...props}
      {...(native === undefined
        ? {}
        : {
            "data-native-menu-trigger": "",
            "aria-expanded": native.open,
          })}
    />
  );
}

export function ContextMenuContent(props: ComponentProps<typeof Web.ContextMenuContent>) {
  const native = useContext(Native);
  if (native === undefined) return <Web.ContextMenuContent {...props} />;
  return native.open ? (
    <div hidden ref={native.content}>
      {props.children}
    </div>
  ) : null;
}

export function ContextMenuItem(props: ComponentProps<typeof Web.ContextMenuItem>) {
  if (useContext(Native) === undefined) return <Web.ContextMenuItem {...props} />;
  return (
    <div
      data-native-menu-kind="item"
      data-native-menu-label={props.label}
      data-native-menu-enabled={props.disabled !== true}
      onClick={props.onClick}
    >
      {props.children}
    </div>
  );
}

export function ContextMenuGroup(props: ComponentProps<typeof Web.ContextMenuGroup>) {
  return useContext(Native) === undefined ? (
    <Web.ContextMenuGroup {...props} />
  ) : (
    <div>{props.children}</div>
  );
}
export function ContextMenuLabel(props: ComponentProps<typeof Web.ContextMenuLabel>) {
  return useContext(Native) === undefined ? (
    <Web.ContextMenuLabel {...props} />
  ) : (
    <div data-native-menu-kind="label">{props.children}</div>
  );
}
export function ContextMenuSeparator(props: ComponentProps<typeof Web.ContextMenuSeparator>) {
  return useContext(Native) === undefined ? (
    <Web.ContextMenuSeparator {...props} />
  ) : (
    <div data-native-menu-kind="separator" />
  );
}
export function ContextMenuSub(props: ComponentProps<typeof Web.ContextMenuSub>) {
  return useContext(Native) === undefined ? (
    <Web.ContextMenuSub {...props} />
  ) : (
    <div data-native-menu-kind="submenu">{props.children}</div>
  );
}
export function ContextMenuSubTrigger(props: ComponentProps<typeof Web.ContextMenuSubTrigger>) {
  return useContext(Native) === undefined ? (
    <Web.ContextMenuSubTrigger {...props} />
  ) : (
    <div
      data-native-menu-sub-trigger=""
      data-native-menu-label={props.label}
      data-native-menu-enabled={props.disabled !== true}
    >
      {props.children}
    </div>
  );
}
export function ContextMenuSubContent(props: ComponentProps<typeof Web.ContextMenuSubContent>) {
  return useContext(Native) === undefined ? (
    <Web.ContextMenuSubContent {...props} />
  ) : (
    <div>{props.children}</div>
  );
}

function readEntries(
  container: Element,
  prefix: string,
  actions: Map<string, HTMLElement>,
  ancestorsEnabled: boolean,
): ReadonlyArray<NativeMenuEntry> {
  const result: NativeMenuEntry[] = [];
  function visit(parent: Element) {
    for (const child of parent.children) {
      if (!(child instanceof HTMLElement)) continue;
      const kind = child.dataset.nativeMenuKind;
      if (kind === undefined) {
        visit(child);
        continue;
      }
      const id = `${prefix}${result.length}`;
      if (kind === "separator") {
        result.push({ kind });
        continue;
      }
      if (kind === "submenu") {
        const trigger = child.querySelector<HTMLElement>("[data-native-menu-sub-trigger]");
        result.push({
          kind,
          label: trigger?.dataset.nativeMenuLabel ?? trigger?.textContent ?? "",
          enabled: trigger?.dataset.nativeMenuEnabled !== "false",
          items: readEntries(
            child,
            `${id}.`,
            actions,
            ancestorsEnabled && trigger?.dataset.nativeMenuEnabled !== "false",
          ),
        });
        continue;
      }
      const labelledBy = child.getAttribute("aria-labelledby");
      const named = labelledBy
        ?.split(/\s+/)
        .map((id) => child.ownerDocument.getElementById(id)?.textContent ?? "")
        .join(" ");
      const label =
        child.dataset.nativeMenuLabel ??
        child.getAttribute("aria-label") ??
        named ??
        child.textContent ??
        "";
      if (kind === "label") {
        result.push({ kind: "item", id, label, enabled: false });
      } else {
        if (
          ancestorsEnabled &&
          child.dataset.nativeMenuEnabled !== "false" &&
          child.getAttribute("aria-disabled") !== "true"
        )
          actions.set(id, child);
        const itemKind = kind === "checkbox" || kind === "radio" ? kind : "item";
        result.push({
          kind: itemKind,
          id,
          label,
          enabled:
            child.dataset.nativeMenuEnabled !== "false" &&
            child.getAttribute("aria-disabled") !== "true",
          ...(itemKind === "item"
            ? {}
            : { checked: child.getAttribute("aria-checked") === "true" }),
          ...(child.title === "" ? {} : { description: child.title }),
        });
      }
    }
  }
  visit(container);
  return result;
}
