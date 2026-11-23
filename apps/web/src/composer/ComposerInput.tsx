import { findSubagentModelTags, type SubagentModelTagMatch } from "@octant/domain";
import {
  createElement,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FocusEvent,
  type FormEvent,
  type HTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import { createPortal } from "react-dom";

/**
 * The composer prompt as its callers see it: the element, plus the text-field
 * surface they already read (`value`, the selection, `setSelectionRange`).
 * The prompt is plain text; `@model(...)` tags in it render as chips, and a
 * chip counts as its whole tag in every offset.
 */
export interface ComposerInputElement extends HTMLElement {
  value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  setSelectionRange(start: number, end: number): void;
}

/** What `onChange` hands a caller: the prompt, with its new value and caret. */
export interface ComposerInputChangeEvent {
  readonly target: ComposerInputElement;
  readonly currentTarget: ComposerInputElement;
}

type ForwardedAttributes = Omit<
  HTMLAttributes<HTMLElement>,
  | "children"
  | "contentEditable"
  | "defaultValue"
  | "onBlur"
  | "onChange"
  | "onClick"
  | "onDragOver"
  | "onDrop"
  | "onFocus"
  | "onInput"
  | "onKeyDown"
  | "onKeyUp"
  | "onPaste"
  | "onSelect"
  | "placeholder"
>;

export interface ComposerInputProps extends ForwardedAttributes {
  readonly value: string;
  readonly onChange?: (event: ComposerInputChangeEvent) => void;
  readonly onKeyDown?: (event: KeyboardEvent<ComposerInputElement>) => void;
  readonly onKeyUp?: (event: KeyboardEvent<ComposerInputElement>) => void;
  readonly onClick?: (event: MouseEvent<ComposerInputElement>) => void;
  readonly onPaste?: (event: ClipboardEvent<ComposerInputElement>) => void;
  readonly onDragOver?: (event: DragEvent<ComposerInputElement>) => void;
  readonly onDrop?: (event: DragEvent<ComposerInputElement>) => void;
  readonly onSelect?: (event: SyntheticEvent<ComposerInputElement>) => void;
  readonly onFocus?: (event: FocusEvent<ComposerInputElement>) => void;
  readonly onBlur?: (event: FocusEvent<ComposerInputElement>) => void;
  readonly placeholder?: string | undefined;
  /** The text-field row count callers pass; the prompt's CSS sets its height. */
  readonly rows?: number;
  readonly disabled?: boolean | undefined;
  readonly readOnly?: boolean | undefined;
  readonly autoFocus?: boolean | undefined;
  /**
   * Draws one tag's chip. `locate` reads the tag's range in the value now, as
   * typing before the chip moves it. Without a renderer a tag shows as its
   * text in a chip.
   */
  readonly renderModelChip?:
    | ((
        match: SubagentModelTagMatch,
        locate: () => { readonly start: number; readonly end: number },
      ) => ReactNode)
    | undefined;
}

const TAG_NAME = "octant-composer-input";
const CHIP_ATTRIBUTE = "data-composer-chip";
const FILLER_ATTRIBUTE = "data-composer-filler";
/** Keystrokes closer together than this undo as one step, as a text field's do. */
const TYPING_COALESCE_MS = 800;
const MAX_HISTORY = 200;

type Segment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "chip"; readonly match: SubagentModelTagMatch };

function segmentsOf(value: string): ReadonlyArray<Segment> {
  const segments: Array<Segment> = [];
  let at = 0;
  for (const match of findSubagentModelTags(value)) {
    if (match.start > at) segments.push({ kind: "text", text: value.slice(at, match.start) });
    segments.push({ kind: "chip", match });
    at = match.end;
  }
  if (at < value.length) segments.push({ kind: "text", text: value.slice(at) });
  return segments;
}

/** A trailing line break is invisible in an editable box until a node follows it. */
function needsFiller(value: string): boolean {
  return value.length === 0 || value.endsWith("\n");
}

function isElement(node: Node): node is HTMLElement {
  return node.nodeType === Node.ELEMENT_NODE;
}

function isChip(node: Node): boolean {
  return isElement(node) && node.hasAttribute(CHIP_ATTRIBUTE);
}

function chipText(node: Node): string {
  return isElement(node) ? (node.getAttribute(CHIP_ATTRIBUTE) ?? "") : "";
}

const BLOCK_TAGS = new Set(["DIV", "P", "LI", "PRE", "BLOCKQUOTE"]);

/**
 * The text a node stands for. Browsers write `<div>` and `<br>` for line
 * breaks and drops; reading them back as `\n` keeps the value plain text
 * whatever the editing engine did.
 */
function textOf(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? "";
  if (!isElement(node)) return "";
  if (isChip(node)) return chipText(node);
  if (node.tagName === "BR") return node.hasAttribute(FILLER_ATTRIBUTE) ? "" : "\n";
  let text = "";
  for (const child of node.childNodes) text += textOf(child);
  const blockBreak = BLOCK_TAGS.has(node.tagName) && node.previousSibling !== null ? "\n" : "";
  return blockBreak + text;
}

function serialize(root: HTMLElement): string {
  let text = "";
  for (const child of root.childNodes) text += textOf(child);
  return text;
}

/** The value offset of a DOM position inside `root`. */
function offsetOf(root: HTMLElement, node: Node, offset: number): number {
  let total = 0;
  const walk = (current: Node): boolean => {
    if (current === node) {
      if (current.nodeType === Node.TEXT_NODE) {
        total += offset;
        return true;
      }
      if (isChip(current)) {
        total += offset === 0 ? 0 : textOf(current).length;
        return true;
      }
      if (isElement(current) && BLOCK_TAGS.has(current.tagName) && current.previousSibling) {
        total += 1;
      }
      for (const child of Array.from(current.childNodes).slice(0, offset)) {
        total += textOf(child).length;
      }
      return true;
    }
    if (current.nodeType === Node.TEXT_NODE || isChip(current)) {
      total += textOf(current).length;
      return false;
    }
    if (isElement(current) && current.tagName === "BR") {
      total += textOf(current).length;
      return false;
    }
    if (isElement(current) && current !== root && BLOCK_TAGS.has(current.tagName)) {
      if (current.previousSibling !== null) total += 1;
    }
    for (const child of current.childNodes) if (walk(child)) return true;
    return false;
  };
  for (const child of root.childNodes) if (walk(child)) return total;
  if (node === root) {
    total = 0;
    for (const child of Array.from(root.childNodes).slice(0, offset)) total += textOf(child).length;
  }
  return total;
}

/**
 * The DOM position for a value offset in a canonical prompt (text nodes,
 * chips, and an optional filler). An offset inside a chip lands after it.
 */
function positionOf(root: HTMLElement, index: number): { node: Node; offset: number } {
  let remaining = index;
  const children = Array.from(root.childNodes);
  for (const [childIndex, child] of children.entries()) {
    const length = textOf(child).length;
    if (child.nodeType === Node.TEXT_NODE) {
      if (remaining <= length) return { node: child, offset: remaining };
    } else if (remaining === 0) {
      return { node: root, offset: childIndex };
    } else if (remaining < length) {
      return { node: root, offset: childIndex + 1 };
    }
    remaining -= length;
  }
  const last = children.at(-1);
  if (last !== undefined && isElement(last) && last.hasAttribute(FILLER_ATTRIBUTE)) {
    return { node: root, offset: children.length - 1 };
  }
  return { node: root, offset: children.length };
}

function isCanonical(root: HTMLElement, value: string): boolean {
  const expected = segmentsOf(value);
  const nodes = Array.from(root.childNodes);
  const filler = needsFiller(value) ? 1 : 0;
  if (nodes.length !== expected.length + filler) return false;
  for (const [index, segment] of expected.entries()) {
    const node = nodes[index];
    if (node === undefined) return false;
    if (segment.kind === "text") {
      if (node.nodeType !== Node.TEXT_NODE || node.nodeValue !== segment.text) return false;
    } else if (!isChip(node) || chipText(node) !== segment.match.text) {
      return false;
    }
  }
  if (filler === 1) {
    const last = nodes.at(-1);
    if (last === undefined || !isElement(last) || !last.hasAttribute(FILLER_ATTRIBUTE))
      return false;
  }
  return true;
}

interface ChipHost {
  readonly key: string;
  readonly node: HTMLElement;
  readonly match: SubagentModelTagMatch;
}

/** Rebuilds the prompt's DOM from `value`, reusing chip hosts whose tag is unchanged. */
function render(
  root: HTMLElement,
  value: string,
  keys: WeakMap<HTMLElement, string>,
  nextKey: () => string,
): ReadonlyArray<ChipHost> {
  const reusable = new Map<string, Array<HTMLElement>>();
  for (const child of Array.from(root.childNodes)) {
    if (!isElement(child) || !isChip(child)) continue;
    const text = chipText(child);
    reusable.set(text, [...(reusable.get(text) ?? []), child]);
  }
  const document = root.ownerDocument;
  const hosts: Array<ChipHost> = [];
  const nodes: Array<Node> = [];
  for (const segment of segmentsOf(value)) {
    if (segment.kind === "text") {
      nodes.push(document.createTextNode(segment.text));
      continue;
    }
    const host = reusable.get(segment.match.text)?.shift() ?? document.createElement("span");
    host.setAttribute(CHIP_ATTRIBUTE, segment.match.text);
    host.setAttribute("contenteditable", "false");
    host.className = "composer-chip";
    let key = keys.get(host);
    if (key === undefined) {
      key = nextKey();
      keys.set(host, key);
    }
    hosts.push({ key, node: host, match: segment.match });
    nodes.push(host);
  }
  if (needsFiller(value)) {
    const filler = document.createElement("br");
    filler.setAttribute(FILLER_ATTRIBUTE, "");
    nodes.push(filler);
  }
  root.replaceChildren(...nodes);
  return hosts;
}

interface Snapshot {
  readonly value: string;
  readonly caret: number;
}

/**
 * The prompt every composer shares. It edits like a text field and holds
 * plain text, so drafts, sends, and copies stay text; what it adds is that a
 * `@model(...)` tag sits in the text as one chip. The DOM is rebuilt from the
 * value only when it no longer matches it (a chip appeared or left, a line
 * break, a paste); ordinary typing and IME composition keep the browser's own
 * nodes, so the caret and composition are never disturbed.
 */
export const ComposerInput = forwardRef<ComposerInputElement, ComposerInputProps>(
  function ComposerInput(props, forwardedRef) {
    const {
      value,
      onChange,
      onKeyDown,
      onKeyUp,
      onClick,
      onPaste,
      onDragOver,
      onDrop,
      onSelect,
      onFocus,
      onBlur,
      placeholder,
      rows: _rows,
      disabled,
      readOnly,
      autoFocus,
      renderModelChip,
      ...attributes
    } = props;
    const rootRef = useRef<ComposerInputElement | null>(null);
    const modelRef = useRef(value);
    const pendingRef = useRef<{ start: number; end: number } | undefined>(undefined);
    const lastSelectionRef = useRef<{ start: number; end: number }>({
      start: value.length,
      end: value.length,
    });
    const composingRef = useRef(false);
    const historyRef = useRef<{
      entries: Array<Snapshot>;
      index: number;
      at: number;
      typing: boolean;
    }>({
      entries: [{ value, caret: value.length }],
      index: 0,
      at: 0,
      typing: false,
    });
    const keysRef = useRef(new WeakMap<HTMLElement, string>());
    const keyCounterRef = useRef(0);
    const [chipHosts, setChipHosts] = useState<ReadonlyArray<ChipHost>>([]);
    const [, tick] = useReducer((count: number) => count + 1, 0);
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;

    const nextKey = useCallback(() => {
      keyCounterRef.current += 1;
      return `chip-${keyCounterRef.current}`;
    }, []);

    const readSelection = (root: HTMLElement): { start: number; end: number } | undefined => {
      const selection = root.ownerDocument.getSelection();
      if (selection === null || selection.rangeCount === 0) return undefined;
      const range = selection.getRangeAt(0);
      if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
        return undefined;
      }
      const start = offsetOf(root, range.startContainer, range.startOffset);
      const end = offsetOf(root, range.endContainer, range.endOffset);
      return { start: Math.min(start, end), end: Math.max(start, end) };
    };

    const currentSelection = (root: HTMLElement): { start: number; end: number } => {
      if (pendingRef.current !== undefined) return pendingRef.current;
      const read = readSelection(root);
      if (read !== undefined) lastSelectionRef.current = read;
      return lastSelectionRef.current;
    };

    const applySelection = (root: HTMLElement, start: number, end: number) => {
      const length = modelRef.current.length;
      const clampedStart = Math.max(0, Math.min(start, length));
      const clampedEnd = Math.max(clampedStart, Math.min(end, length));
      lastSelectionRef.current = { start: clampedStart, end: clampedEnd };
      if (root.ownerDocument.activeElement !== root) return;
      const selection = root.ownerDocument.getSelection();
      if (selection === null) return;
      const from = positionOf(root, clampedStart);
      const to = positionOf(root, clampedEnd);
      const range = root.ownerDocument.createRange();
      range.setStart(from.node, from.offset);
      range.setEnd(to.node, to.offset);
      selection.removeAllRanges();
      selection.addRange(range);
    };

    const rebuild = (root: HTMLElement) => {
      setChipHosts(render(root, modelRef.current, keysRef.current, nextKey));
    };

    // Only a run of plain typing undoes as one step; a line break, a paste, a
    // chip added or removed, or an undo each stand alone, as in a text field.
    const remember = (snapshot: Snapshot, typing: boolean) => {
      const history = historyRef.current;
      const now = Date.now();
      const entries = history.entries.slice(0, history.index + 1);
      const coalesce =
        typing && history.typing && entries.length > 1 && now - history.at < TYPING_COALESCE_MS;
      if (coalesce) {
        entries[entries.length - 1] = snapshot;
      } else {
        entries.push(snapshot);
      }
      while (entries.length > MAX_HISTORY) entries.shift();
      historyRef.current = { entries, index: entries.length - 1, at: now, typing };
    };

    const emit = (next: string, caret: number, options: { readonly typing: boolean }) => {
      const root = rootRef.current;
      if (root === null) return;
      modelRef.current = next;
      pendingRef.current = { start: caret, end: caret };
      lastSelectionRef.current = { start: caret, end: caret };
      remember({ value: next, caret }, options.typing);
      onChangeRef.current?.({ target: root, currentTarget: root });
      tick();
    };

    const replaceSelection = (root: HTMLElement, text: string) => {
      const { start, end } = currentSelection(root);
      const current = modelRef.current;
      emit(`${current.slice(0, start)}${text}${current.slice(end)}`, start + text.length, {
        typing: false,
      });
    };

    const restore = (root: ComposerInputElement, direction: -1 | 1) => {
      const history = historyRef.current;
      const index = history.index + direction;
      const snapshot = history.entries[index];
      if (snapshot === undefined) return;
      historyRef.current = { ...history, index, at: 0, typing: false };
      modelRef.current = snapshot.value;
      pendingRef.current = { start: snapshot.caret, end: snapshot.caret };
      onChangeRef.current?.({ target: root, currentTarget: root });
      tick();
    };

    const attach = useCallback((node: HTMLElement | null) => {
      if (node === null) {
        rootRef.current = null;
        return;
      }
      const root = node as ComposerInputElement;
      if (rootRef.current === root) return;
      Object.defineProperties(root, {
        value: {
          configurable: true,
          get: () => modelRef.current,
          // A caller (or a test) that assigns the value replaces the whole
          // prompt, as assigning a text field's value does.
          set: (next: unknown) => {
            modelRef.current = typeof next === "string" ? next : String(next ?? "");
            setChipHosts(render(root, modelRef.current, keysRef.current, nextKey));
            lastSelectionRef.current = {
              start: modelRef.current.length,
              end: modelRef.current.length,
            };
          },
        },
        selectionStart: { configurable: true, get: () => currentSelection(root).start },
        selectionEnd: { configurable: true, get: () => currentSelection(root).end },
        setSelectionRange: {
          configurable: true,
          value: (start: number, end: number) => {
            pendingRef.current = undefined;
            applySelection(root, start, end);
          },
        },
      });
      rootRef.current = root;
      setChipHosts(render(root, modelRef.current, keysRef.current, nextKey));
    }, []);

    useImperativeHandle<ComposerInputElement | null, ComposerInputElement | null>(
      forwardedRef,
      () => rootRef.current,
      [],
    );

    // Bring the DOM back in line with the value after every render: a new
    // value from the caller, a refused change, or an edit this prompt made.
    useLayoutEffect(() => {
      const root = rootRef.current;
      if (root === null) return;
      if (modelRef.current !== value) {
        const external = pendingRef.current === undefined;
        modelRef.current = value;
        if (external) {
          pendingRef.current = { start: value.length, end: value.length };
          remember({ value, caret: value.length }, false);
        }
      }
      if (composingRef.current) return;
      if (!isCanonical(root, modelRef.current)) rebuild(root);
      const pending = pendingRef.current;
      if (pending !== undefined) {
        pendingRef.current = undefined;
        applySelection(root, pending.start, pending.end);
      }
    });

    useEffect(() => {
      const root = rootRef.current;
      if (root === null) return;
      const onBeforeInput = (event: InputEvent) => {
        switch (event.inputType) {
          case "insertParagraph":
          case "insertLineBreak":
            event.preventDefault();
            replaceSelection(root, "\n");
            return;
          case "historyUndo":
            event.preventDefault();
            restore(root, -1);
            return;
          case "historyRedo":
            event.preventDefault();
            restore(root, 1);
            return;
          default:
            if (event.inputType.startsWith("format")) event.preventDefault();
        }
      };
      const onNativeInput = () => {
        const next = serialize(root);
        const caret = readSelection(root)?.start ?? next.length;
        if (next === modelRef.current) return;
        const chipsChanged =
          findSubagentModelTags(next).length !== findSubagentModelTags(modelRef.current).length;
        emit(next, caret, { typing: !chipsChanged });
      };
      // A test (or a caller) that assigns `value` and fires `change`, as it
      // would on a text field, reaches `onChange` here; browsers never fire
      // `change` on an editable element themselves.
      const onNativeChange = () => {
        remember({ value: modelRef.current, caret: modelRef.current.length }, false);
        onChangeRef.current?.({ target: root, currentTarget: root });
        tick();
      };
      const onCompositionStart = () => {
        composingRef.current = true;
      };
      const onCompositionEnd = () => {
        composingRef.current = false;
        tick();
      };
      root.addEventListener("beforeinput", onBeforeInput);
      root.addEventListener("input", onNativeInput);
      root.addEventListener("change", onNativeChange);
      root.addEventListener("compositionstart", onCompositionStart);
      root.addEventListener("compositionend", onCompositionEnd);
      return () => {
        root.removeEventListener("beforeinput", onBeforeInput);
        root.removeEventListener("input", onNativeInput);
        root.removeEventListener("change", onNativeChange);
        root.removeEventListener("compositionstart", onCompositionStart);
        root.removeEventListener("compositionend", onCompositionEnd);
      };
    }, []);

    // A `<label for>` names a text field but not an editable element, so the
    // prompt takes the label's name through `aria-labelledby` instead.
    const id = attributes.id;
    const named =
      attributes["aria-label"] !== undefined || attributes["aria-labelledby"] !== undefined;
    useLayoutEffect(() => {
      const root = rootRef.current;
      if (root === null || id === undefined || named) return;
      const label = root.ownerDocument.querySelector<HTMLLabelElement>(
        `label[for="${CSS.escape(id)}"]`,
      );
      if (label === null) return;
      if (label.id === "") label.id = `${id}-label`;
      root.setAttribute("aria-labelledby", label.id);
    }, [id, named]);

    useEffect(() => {
      if (autoFocus === true) rootRef.current?.focus();
    }, []);

    const editable = disabled !== true && readOnly !== true;
    const element = createElement(TAG_NAME, {
      ...attributes,
      ref: attach,
      role: "textbox",
      "aria-multiline": "true",
      "aria-disabled": disabled === true ? "true" : undefined,
      "aria-readonly": readOnly === true ? "true" : undefined,
      "aria-placeholder": placeholder,
      placeholder,
      disabled: disabled === true ? true : undefined,
      readonly: readOnly === true ? "" : undefined,
      "data-empty": value.length === 0 ? "true" : undefined,
      contentEditable: editable ? "true" : "false",
      suppressContentEditableWarning: true,
      spellCheck: attributes.spellCheck ?? true,
      tabIndex: disabled === true ? -1 : (attributes.tabIndex ?? 0),
      onKeyDown: (event: KeyboardEvent<ComposerInputElement>) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || event.nativeEvent.isComposing || !editable) return;
        const root = rootRef.current;
        if (root === null) return;
        if (event.key === "Enter") {
          event.preventDefault();
          replaceSelection(root, "\n");
          return;
        }
        const modifier = event.metaKey || event.ctrlKey;
        if (modifier && !event.altKey && event.key.toLowerCase() === "z") {
          event.preventDefault();
          restore(root, event.shiftKey ? 1 : -1);
        } else if (modifier && !event.altKey && event.key.toLowerCase() === "y") {
          event.preventDefault();
          restore(root, 1);
        }
      },
      onKeyUp,
      onClick,
      onDragOver,
      onDrop,
      onSelect,
      onFocus,
      onBlur,
      onPaste: (event: ClipboardEvent<ComposerInputElement>) => {
        onPaste?.(event);
        if (event.defaultPrevented || !editable) return;
        const root = rootRef.current;
        if (root === null) return;
        event.preventDefault();
        replaceSelection(root, event.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n"));
      },
      onCopy: (event: ClipboardEvent<ComposerInputElement>) => {
        const root = rootRef.current;
        if (root === null) return;
        const { start, end } = currentSelection(root);
        if (start === end) return;
        event.preventDefault();
        event.clipboardData.setData("text/plain", modelRef.current.slice(start, end));
      },
      onCut: (event: ClipboardEvent<ComposerInputElement>) => {
        const root = rootRef.current;
        if (root === null) return;
        const { start, end } = currentSelection(root);
        if (start === end) return;
        event.preventDefault();
        event.clipboardData.setData("text/plain", modelRef.current.slice(start, end));
        if (editable) replaceSelection(root, "");
      },
      onInput: (_event: FormEvent<ComposerInputElement>) => undefined,
    });

    return (
      <>
        {element}
        {chipHosts.map((host) =>
          createPortal(
            renderModelChip?.(host.match, () => {
              const root = rootRef.current;
              const start = root === null ? host.match.start : offsetOf(root, host.node, 0);
              return { start, end: start + host.match.text.length };
            }) ?? <span className="composer-chip__label">{host.match.text}</span>,
            host.node,
            host.key,
          ),
        )}
      </>
    );
  },
);
