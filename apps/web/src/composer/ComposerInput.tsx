import {
  composerTextReplaced,
  noteTypedComposerText,
} from "@octant/client-runtime/typed-composer-text";
import { findSubagentModelTags, type SubagentModelTagMatch } from "@octant/domain";
import {
  createElement,
  forwardRef,
  useCallback,
  useEffect,
  useId,
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
} from "react";
import { createPortal, flushSync } from "react-dom";
import { MAX_THREAD_MESSAGE_QUEUE_PROMPT_CHARACTERS } from "@octant/contracts/thread-message-queue";
import { lazyOr } from "../lib/lazyOr";
import type { ComposerQuotePlace } from "./composerQuote";
import {
  COMPOSER_QUOTE_CLIPBOARD_TYPE,
  loadComposerQuoteTools,
  loadedComposerQuoteTools,
  QUOTE_HEADER_TAIL,
} from "./composerQuoteMark";
import type { ComposerQuoteChipProps } from "./ComposerQuoteChip";

const LazyQuoteChip = lazyOr<ComposerQuoteChipProps>(
  async () => (await import("./ComposerQuoteChip")).ComposerQuoteChip,
  ({ quote }) => (
    <span className="composer-chip__label">
      {`Quote · ${quote.text.slice(0, 40)}${quote.comment === "" ? "" : ` · Note: ${quote.comment.slice(0, 40)}`}`}
    </span>
  ),
);

/**
 * The composer prompt as its callers see it: the element, plus the text-field
 * surface they already read (`value`, the selection, `setSelectionRange`).
 * The prompt is plain text; `@model(...)` tags and the caller's own inline
 * chips in it render as chips, and a chip counts as its whole text in every
 * offset.
 */
export interface ComposerInputElement extends HTMLElement {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  setSelectionRange(start: number, end: number): void;
}

/** What `onChange` hands a caller: the prompt, with its new value and caret. */
export interface ComposerInputChangeEvent {
  readonly target: ComposerInputElement;
  readonly currentTarget: ComposerInputElement;
}

/** One place a caller's inline chip stands in the prompt. */
export interface ComposerInlineChipPlace {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  /** Names what the chip stands for; two chips can read alike in the text. */
  readonly id: string;
}

/** Reads a chip's range in the value now, as typing before the chip moves it. */
export type LocateComposerChip = () => { readonly start: number; readonly end: number };

/** Chips a caller owns in the prompt's text, such as mentioned threads. */
export interface ComposerInlineChips {
  readonly find: (value: string) => ReadonlyArray<ComposerInlineChipPlace>;
  readonly render: (id: string, locate: LocateComposerChip) => ReactNode;
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
  /** The caret or selection moved, by key, pointer, or code. */
  readonly onSelect?: (event: ComposerInputChangeEvent) => void;
  readonly onFocus?: (event: FocusEvent<ComposerInputElement>) => void;
  readonly onBlur?: (event: FocusEvent<ComposerInputElement>) => void;
  readonly placeholder?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly readOnly?: boolean | undefined;
  readonly autoFocus?: boolean | undefined;
  /**
   * Draws one tag's chip. `locate` reads the tag's range in the value now, as
   * typing before the chip moves it. Without a renderer a tag shows as its
   * text in a chip.
   */
  readonly renderModelChip?:
    | ((match: SubagentModelTagMatch, locate: LocateComposerChip) => ReactNode)
    | undefined;
  readonly inlineChips?: ComposerInlineChips | undefined;
  /**
   * The draft this prompt holds (a thread's or a new task's key), which says
   * whose typing a send may claim. Without one, the prompt is its own draft.
   */
  readonly typedScope?: string | undefined;
  /**
   * The prompts already sent in this thread, newest first. In an empty prompt
   * ArrowUp brings them back one by one and ArrowDown walks forward again,
   * for as long as the recalled text is unedited. A caller with attachments
   * or other context beside the prompt passes none.
   */
  readonly recall?: ReadonlyArray<string> | undefined;
  /**
   * Takes a paste too large for the prompt as a text file instead: 32 KiB or
   * more, or enough to push the prompt past what a message may hold. ⌘⇧V
   * (Ctrl+Shift+V) pastes it inline anyway. Without it every paste is text.
   */
  readonly onPasteAsFile?: ((file: File) => void) | undefined;
}

const TAG_NAME = "octant-composer-input";
const CHIP_ATTRIBUTE = "data-composer-chip";
const CHIP_ID_ATTRIBUTE = "data-composer-chip-id";
const FILLER_ATTRIBUTE = "data-composer-filler";
/** Keystrokes closer together than this undo as one step, as a text field's do. */
const TYPING_COALESCE_MS = 800;
const MAX_HISTORY = 200;
/** A paste this large reads better as a file than as a wall of text in the prompt. */
const PASTE_AS_FILE_BYTES = 32 * 1024;
/** How soon after ⌘⇧V its paste arrives, if the browser sends one at all. */
const PLAIN_PASTE_WINDOW_MS = 500;

type Chip =
  | {
      readonly kind: "model";
      readonly start: number;
      readonly end: number;
      readonly text: string;
      readonly id: string;
      readonly match: SubagentModelTagMatch;
    }
  | {
      readonly kind: "quote";
      readonly start: number;
      readonly end: number;
      readonly text: string;
      readonly id: string;
      readonly quote: ComposerQuotePlace;
    }
  | ({ readonly kind: "inline" } & ComposerInlineChipPlace);

type Segment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "chip"; readonly chip: Chip };

type FindInlineChips = ComposerInlineChips["find"] | undefined;

function overlaps(
  range: { readonly start: number; readonly end: number },
  chips: ReadonlyArray<Chip>,
): boolean {
  return chips.some((chip) => range.start < chip.end && chip.start < range.end);
}

/**
 * Every chip in the prompt, in order. A quote's words are the quote's own, so
 * a tag inside a quote is quoted text, and a tag inside a caller's chip is that
 * chip's text.
 */
function chipsOf(value: string, findInline: FindInlineChips): ReadonlyArray<Chip> {
  // Until the quote code loads no quote Octant wrote can exist, so none is found.
  const quotes = (loadedComposerQuoteTools()?.findComposerQuotes(value) ?? []).map(
    (quote, index): Chip => ({
      kind: "quote",
      start: quote.start,
      end: quote.end,
      text: quote.chipText,
      id: `quote:${String(index)}`,
      quote,
    }),
  );
  const inline = [
    ...quotes,
    ...(findInline?.(value) ?? [])
      .filter((place) => !overlaps(place, quotes))
      .map((place): Chip => ({ ...place, kind: "inline" })),
  ];
  const models = findSubagentModelTags(value)
    .filter((match) => !overlaps(match, inline))
    .map(
      (match): Chip => ({
        kind: "model",
        start: match.start,
        end: match.end,
        text: match.text,
        id: "",
        match,
      }),
    );
  return [...inline, ...models].sort((left, right) => left.start - right.start);
}

function segmentsOf(value: string, findInline: FindInlineChips): ReadonlyArray<Segment> {
  const segments: Array<Segment> = [];
  let at = 0;
  for (const chip of chipsOf(value, findInline)) {
    if (chip.start > at) segments.push({ kind: "text", text: value.slice(at, chip.start) });
    segments.push({ kind: "chip", chip });
    at = chip.end;
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

function lineBreaks(text: string): number {
  return text.split("\n").length - 1;
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

function chipId(node: Node): string {
  return isElement(node) ? (node.getAttribute(CHIP_ID_ATTRIBUTE) ?? "") : "";
}

function isCanonical(root: HTMLElement, value: string, findInline: FindInlineChips): boolean {
  const expected = segmentsOf(value, findInline);
  const nodes = Array.from(root.childNodes);
  const filler = needsFiller(value) ? 1 : 0;
  if (nodes.length !== expected.length + filler) return false;
  for (const [index, segment] of expected.entries()) {
    const node = nodes[index];
    if (node === undefined) return false;
    if (segment.kind === "text") {
      if (node.nodeType !== Node.TEXT_NODE || node.nodeValue !== segment.text) return false;
    } else if (
      !isChip(node) ||
      chipText(node) !== segment.chip.text ||
      chipId(node) !== segment.chip.id
    ) {
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

/** Writes a copy's text, and beside it, under Octant's own type, the quotes Octant wrote in it. */
function copyText(clipboard: DataTransfer, text: string): void {
  clipboard.setData("text/plain", text);
  const quotes = loadedComposerQuoteTools()?.composerQuoteTextsIn(text) ?? [];
  if (quotes.length > 0) clipboard.setData(COMPOSER_QUOTE_CLIPBOARD_TYPE, JSON.stringify(quotes));
}

/** The quotes a paste's clipboard says a composer copied, each still whole in the pasted text. */
function copiedQuotes(clipboard: DataTransfer, text: string): ReadonlyArray<string> {
  const marked = clipboard.getData(COMPOSER_QUOTE_CLIPBOARD_TYPE);
  if (marked === "") return [];
  try {
    const quotes: unknown = JSON.parse(marked);
    return Array.isArray(quotes)
      ? quotes.filter((quote): quote is string => typeof quote === "string" && text.includes(quote))
      : [];
  } catch {
    return [];
  }
}

interface ChipHost {
  readonly key: string;
  readonly node: HTMLElement;
  readonly chip: Chip;
}

/** Rebuilds the prompt's DOM from `value`, reusing chip hosts whose chip is unchanged. */
function render(
  root: HTMLElement,
  value: string,
  keys: WeakMap<HTMLElement, string>,
  nextKey: () => string,
  findInline: FindInlineChips,
): ReadonlyArray<ChipHost> {
  const reusable = new Map<string, Array<HTMLElement>>();
  for (const child of Array.from(root.childNodes)) {
    if (!isElement(child) || !isChip(child)) continue;
    const identity = `${chipId(child)}\n${chipText(child)}`;
    reusable.set(identity, [...(reusable.get(identity) ?? []), child]);
  }
  const document = root.ownerDocument;
  const hosts: Array<ChipHost> = [];
  const nodes: Array<Node> = [];
  for (const segment of segmentsOf(value, findInline)) {
    if (segment.kind === "text") {
      nodes.push(document.createTextNode(segment.text));
      continue;
    }
    const { chip } = segment;
    const host =
      reusable.get(`${chip.id}\n${chip.text}`)?.shift() ?? document.createElement("span");
    host.setAttribute(CHIP_ATTRIBUTE, chip.text);
    if (chip.id !== "") host.setAttribute(CHIP_ID_ATTRIBUTE, chip.id);
    host.setAttribute("contenteditable", "false");
    host.className = "composer-chip";
    let key = keys.get(host);
    if (key === undefined) {
      key = nextKey();
      keys.set(host, key);
    }
    hosts.push({ key, node: host, chip });
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
  /**
   * The person's own input left this text. An undo or redo that lands on it
   * counts as typed again; one that lands on text a caller wrote does not.
   */
  readonly typed: boolean;
}

/**
 * The prompt every composer shares. It edits like a text field and holds
 * plain text, so drafts, sends, and copies stay text; what it adds is that a
 * `@model(...)` tag, or a chip its caller finds in the text, sits in the text
 * as one chip. The DOM is rebuilt from the
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
      disabled,
      readOnly,
      autoFocus,
      renderModelChip,
      inlineChips,
      typedScope,
      recall,
      onPasteAsFile,
      ...attributes
    } = props;
    const ownScope = `composer:${useId()}`;
    const scopeRef = useRef(typedScope ?? ownScope);
    scopeRef.current = typedScope ?? ownScope;
    const rootRef = useRef<ComposerInputElement | null>(null);
    const modelRef = useRef(value);
    // The value the caller last gave or was told; assigning `value` and then
    // firing `input`, as code does to a text field, reports the difference.
    const reportedRef = useRef(value);
    const pendingRef = useRef<{ start: number; end: number } | undefined>(undefined);
    // Bumped by every explicit selection, so a focus restore queued before it
    // never overwrites it.
    const selectionGenerationRef = useRef(0);
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
      entries: [{ value, caret: value.length, typed: false }],
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
    const onSelectRef = useRef(onSelect);
    onSelectRef.current = onSelect;
    const reportedSelectionRef = useRef<string | undefined>(undefined);
    const findInlineRef = useRef(inlineChips?.find);
    findInlineRef.current = inlineChips?.find;

    // React re-renders a controlled text field synchronously after each change,
    // so its caller's state is current before the next key arrives; the prompt
    // reports its changes the same way, or an Enter right after typing would
    // send the draft as it was before.
    const report = (root: ComposerInputElement, typed = true) => {
      // Only the person's own edits come through here: typing, paste, cut, undo,
      // and dictation. A value a caller writes does not, and undoing back to one
      // is not typing it. A quote's words are not the person's, so a draft that
      // carries one is never counted as typed, whatever is typed around it.
      if (
        typed &&
        (loadedComposerQuoteTools()?.findComposerQuotes(modelRef.current).length ?? 0) === 0
      ) {
        noteTypedComposerText(scopeRef.current, modelRef.current);
      } else {
        composerTextReplaced(scopeRef.current, modelRef.current);
      }
      flushSync(() => onChangeRef.current?.({ target: root, currentTarget: root }));
    };

    const nextKey = useCallback(() => {
      keyCounterRef.current += 1;
      return `chip-${keyCounterRef.current}`;
    }, []);

    // A text field keeps its own selection while unfocused; the document's
    // selection only describes the prompt while the prompt has focus.
    const readSelection = (root: HTMLElement): { start: number; end: number } | undefined => {
      if (root.ownerDocument.activeElement !== root) return undefined;
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
      setChipHosts(render(root, modelRef.current, keysRef.current, nextKey, findInlineRef.current));
    };

    const rebuildRef = useRef(rebuild);
    rebuildRef.current = rebuild;

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

    const emit = (typed: string, typedCaret: number, options: { readonly typing: boolean }) => {
      const root = rootRef.current;
      if (root === null) return;
      const tools = loadedComposerQuoteTools();
      const { value: next, caret } =
        tools === undefined
          ? { value: typed, caret: typedCaret }
          : tools.separateComposerQuotes(
              typed,
              typedCaret,
              // The quotes it held before the edit, and any the edit brought in.
              [
                ...tools.composerQuoteTextsIn(modelRef.current),
                ...tools.composerQuoteTextsIn(typed),
              ],
            );
      modelRef.current = next;
      pendingRef.current = { start: caret, end: caret };
      lastSelectionRef.current = { start: caret, end: caret };
      remember({ value: next, caret, typed: true }, options.typing);
      reportedRef.current = next;
      report(root);
      tick();
    };

    const replaceSelection = (root: HTMLElement, text: string) => {
      const { start, end } = currentSelection(root);
      const current = modelRef.current;
      emit(`${current.slice(0, start)}${text}${current.slice(end)}`, start + text.length, {
        typing: false,
      });
    };

    // A change made from a chip of the prompt's own (a quote's note, or the
    // quote taken out): one undo step, and not the person's typing.
    const replaceRange = (start: number, end: number, text: string, caretAt?: number) => {
      const root = rootRef.current;
      if (root === null) return;
      const current = modelRef.current;
      const next = `${current.slice(0, start)}${text}${current.slice(end)}`;
      const caret = caretAt ?? start + text.length;
      modelRef.current = next;
      pendingRef.current = { start: caret, end: caret };
      lastSelectionRef.current = { start: caret, end: caret };
      remember({ value: next, caret, typed: false }, false);
      reportedRef.current = next;
      report(root, false);
      tick();
    };

    // Which sent prompt the prompt shows, and its text as recalled: an edit
    // makes the text the person's draft, and the arrows move the caret again.
    const recalledRef = useRef<{ readonly index: number; readonly text: string }>({
      index: -1,
      text: "",
    });

    const plainPasteRef = useRef(0);
    const pastedFilesRef = useRef(0);

    const pasteText = (root: HTMLElement, text: string, plain: boolean) => {
      const { start, end } = currentSelection(root);
      const tooLarge =
        new TextEncoder().encode(text).length >= PASTE_AS_FILE_BYTES ||
        modelRef.current.length - (end - start) + text.length >
          MAX_THREAD_MESSAGE_QUEUE_PROMPT_CHARACTERS;
      if (!plain && tooLarge && onPasteAsFile !== undefined) {
        pastedFilesRef.current += 1;
        const name = `pasted-text-${String(pastedFilesRef.current)}.txt`;
        onPasteAsFile(new File([text], name, { type: "text/plain" }));
        return;
      }
      replaceSelection(root, text);
    };

    const recallStep = (root: HTMLElement, direction: "older" | "newer"): boolean => {
      const sent = recall ?? [];
      const current = modelRef.current;
      const recalled = recalledRef.current;
      const showing = current !== "" && recalled.index >= 0 && current === recalled.text;
      if (current !== "" && !showing) return false;
      const { start, end } = currentSelection(root);
      if (start !== end) return false;
      const index = showing ? recalled.index : -1;
      if (direction === "older") {
        if (current.slice(0, start).includes("\n")) return false;
        const next = sent[index + 1];
        if (next === undefined) return showing;
        recalledRef.current = { index: index + 1, text: next };
        replaceRange(0, current.length, next, 0);
        return true;
      }
      if (!showing || current.slice(end).includes("\n")) return false;
      const next = index > 0 ? (sent[index - 1] ?? "") : "";
      recalledRef.current = { index: index - 1, text: next };
      replaceRange(0, current.length, next);
      return true;
    };

    const restore = (root: ComposerInputElement, direction: -1 | 1) => {
      const history = historyRef.current;
      const index = history.index + direction;
      const snapshot = history.entries[index];
      if (snapshot === undefined) return;
      historyRef.current = { ...history, index, at: 0, typing: false };
      modelRef.current = snapshot.value;
      pendingRef.current = { start: snapshot.caret, end: snapshot.caret };
      reportedRef.current = snapshot.value;
      report(root, snapshot.typed);
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
            rebuildRef.current(root);
            lastSelectionRef.current = {
              start: modelRef.current.length,
              end: modelRef.current.length,
            };
          },
        },
        selectionStart: {
          configurable: true,
          get: () => currentSelection(root).start,
          set: (start: number) => {
            const { end } = currentSelection(root);
            pendingRef.current = undefined;
            selectionGenerationRef.current += 1;
            applySelection(root, start, Math.max(start, end));
          },
        },
        selectionEnd: {
          configurable: true,
          get: () => currentSelection(root).end,
          set: (end: number) => {
            const { start } = currentSelection(root);
            pendingRef.current = undefined;
            selectionGenerationRef.current += 1;
            applySelection(root, Math.min(start, end), end);
          },
        },
        setSelectionRange: {
          configurable: true,
          value: (start: number, end: number) => {
            pendingRef.current = undefined;
            selectionGenerationRef.current += 1;
            applySelection(root, start, end);
          },
        },
      });
      rootRef.current = root;
      rebuildRef.current(root);
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
      reportedRef.current = value;
      if (modelRef.current !== value) {
        const external = pendingRef.current === undefined;
        modelRef.current = value;
        if (external) {
          // A value the caller wrote is not the person's typing: the draft's
          // note stays only when it is the very text the person left there.
          composerTextReplaced(scopeRef.current, value);
          pendingRef.current = { start: value.length, end: value.length };
          // A value the caller writes starts a new undo history, as a text
          // field's does: a send's text is gone, and a picked file or model
          // carries state beside the text (the file joins the send) that
          // undoing the text alone would leave behind.
          historyRef.current = {
            entries: [{ value, caret: value.length, typed: false }],
            index: 0,
            at: 0,
            typing: false,
          };
        }
      }
      if (composingRef.current) return;
      if (!isCanonical(root, modelRef.current, findInlineRef.current)) {
        // Text can become a chip with no edit of its own (the caller chose it
        // after writing it), and rebuilding the DOM would drop the caret.
        pendingRef.current ??= readSelection(root);
        rebuild(root);
      }
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
      // Focusing a text field brings back the selection it held, so a caret
      // set while the prompt was unfocused survives focus. The engine places
      // its own caret as part of focusing (jsdom after the focus event), so
      // the held selection is applied once focusing has finished. A pointer
      // focus keeps the caret where the person clicked.
      let pointerFocus = false;
      const onPointerDown = () => {
        pointerFocus = true;
      };
      const onFocusIn = () => {
        if (pointerFocus) {
          pointerFocus = false;
          return;
        }
        const { start, end } = lastSelectionRef.current;
        const generation = selectionGenerationRef.current;
        queueMicrotask(() => {
          if (generation !== selectionGenerationRef.current) return;
          if (root.ownerDocument.activeElement === root) applySelection(root, start, end);
        });
      };
      // A test (or a caller) that assigns `value` and fires `change`, as it
      // would on a text field, reaches `onChange` here; browsers never fire
      // `change` on an editable element themselves.
      const onNativeChange = () => {
        reportedRef.current = modelRef.current;
        composerTextReplaced(scopeRef.current, modelRef.current);
        remember({ value: modelRef.current, caret: modelRef.current.length, typed: false }, false);
        onChangeRef.current?.({ target: root, currentTarget: root });
        tick();
      };
      // React raises `onSelect` only for elements it knows are editable, so the
      // prompt raises it itself whenever its caret or selection moved.
      const onSelectionMoved = () => {
        const read = readSelection(root);
        if (read === undefined) return;
        const key = `${read.start}:${read.end}`;
        if (key === reportedSelectionRef.current) return;
        reportedSelectionRef.current = key;
        lastSelectionRef.current = read;
        onSelectRef.current?.({ target: root, currentTarget: root });
      };
      const onCompositionStart = () => {
        composingRef.current = true;
      };
      const onCompositionEnd = () => {
        composingRef.current = false;
        tick();
      };
      root.addEventListener("beforeinput", onBeforeInput);
      root.addEventListener("focus", onFocusIn);
      root.addEventListener("pointerdown", onPointerDown);
      root.addEventListener("mousedown", onPointerDown);
      root.addEventListener("change", onNativeChange);
      root.addEventListener("compositionstart", onCompositionStart);
      root.addEventListener("compositionend", onCompositionEnd);
      root.addEventListener("keyup", onSelectionMoved);
      root.addEventListener("mouseup", onSelectionMoved);
      root.ownerDocument.addEventListener("selectionchange", onSelectionMoved);
      return () => {
        root.removeEventListener("keyup", onSelectionMoved);
        root.removeEventListener("mouseup", onSelectionMoved);
        root.ownerDocument.removeEventListener("selectionchange", onSelectionMoved);
        root.removeEventListener("beforeinput", onBeforeInput);
        root.removeEventListener("focus", onFocusIn);
        root.removeEventListener("pointerdown", onPointerDown);
        root.removeEventListener("mousedown", onPointerDown);
        root.removeEventListener("change", onNativeChange);
        root.removeEventListener("compositionstart", onCompositionStart);
        root.removeEventListener("compositionend", onCompositionEnd);
      };
    }, []);

    // A `<label>` names a text field, by `for` or by wrapping it, but not an
    // editable element, so the prompt takes the label's text through
    // `aria-labelledby` instead. A wrapping label also holds the prompt
    // itself, so the name points at the label's own text, not at the label.
    const id = attributes.id;
    const named =
      attributes["aria-label"] !== undefined || attributes["aria-labelledby"] !== undefined;
    const labelId = useId();
    useLayoutEffect(() => {
      const root = rootRef.current;
      if (root === null || named) return;
      const wrapping = root.parentElement?.closest("label");
      const pointing =
        id === undefined
          ? null
          : root.ownerDocument.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(id)}"]`);
      const name =
        wrapping === null || wrapping === undefined
          ? pointing
          : Array.from(wrapping.children).find((child) => child !== root && !child.contains(root));
      if (name === null || name === undefined) return;
      if (name.id === "") name.id = labelId;
      root.setAttribute("aria-labelledby", name.id);
    }, [id, named, labelId]);

    // A label activates its first button when it is clicked, and a chip is the
    // only button a wrapping label holds: clicking the prompt's text opened
    // the chip instead of placing the caret. A click on a chip is its own.
    useEffect(() => {
      const label = rootRef.current?.closest("label");
      if (label === null || label === undefined) return;
      const onLabelClick = (event: Event) => {
        const target = event.target;
        if (target instanceof Element && target.closest(`[${CHIP_ATTRIBUTE}]`) !== null) return;
        event.preventDefault();
      };
      label.addEventListener("click", onLabelClick);
      return () => label.removeEventListener("click", onLabelClick);
    }, []);

    // A prompt that holds a quote's mark (a restored draft, say) loads the quote
    // code, which then says which of them Octant wrote.
    const marked = value.includes(QUOTE_HEADER_TAIL);
    useEffect(() => {
      if (!marked || loadedComposerQuoteTools() !== undefined) return;
      void loadComposerQuoteTools()
        .then(() => tick())
        .catch(() => undefined);
    }, [marked]);

    useEffect(() => {
      if (autoFocus === true) rootRef.current?.focus();
    }, []);

    const editable = disabled !== true && readOnly !== true;
    // React writes `true` on a custom element as an empty attribute, which
    // assistive technology reads as no value; ARIA states are spelled out.
    const ariaAttributes = Object.fromEntries(
      Object.entries(attributes).map(([key, attribute]) => [
        key,
        key.startsWith("aria-") && typeof attribute === "boolean" ? String(attribute) : attribute,
      ]),
    );
    const element = createElement(TAG_NAME, {
      ...ariaAttributes,
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
        if (
          (event.metaKey || event.ctrlKey) &&
          event.shiftKey &&
          !event.altKey &&
          event.key.toLowerCase() === "v"
        ) {
          // Some shells never turn ⌘⇧V into a paste, so the clipboard is read
          // here when no paste follows the key.
          plainPasteRef.current = Date.now() + PLAIN_PASTE_WINDOW_MS;
          window.setTimeout(() => {
            if (plainPasteRef.current === 0) return;
            void navigator.clipboard
              ?.readText()
              .then((text) => {
                if (plainPasteRef.current === 0 || text === "") return;
                plainPasteRef.current = 0;
                pasteText(root, text.replace(/\r\n?/g, "\n"), true);
              })
              .catch(() => undefined);
          }, 50);
          return;
        }
        const plainArrow = !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey;
        if (
          plainArrow &&
          (event.key === "ArrowUp" || event.key === "ArrowDown") &&
          recallStep(root, event.key === "ArrowUp" ? "older" : "newer")
        ) {
          event.preventDefault();
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
      onFocus,
      onBlur,
      onPaste: (event: ClipboardEvent<ComposerInputElement>) => {
        // Any paste answers a ⌘⇧V, even one a caller takes, so the clipboard
        // read that stands in for a shell's missing paste never pastes twice.
        const plain = Date.now() < plainPasteRef.current;
        plainPasteRef.current = 0;
        onPaste?.(event);
        if (event.defaultPrevented || !editable) return;
        const root = rootRef.current;
        if (root === null) return;
        event.preventDefault();
        const text = event.clipboardData.getData("text/plain");
        // A paste with no text (an image the caller did not take) changes nothing.
        if (text === "") return;
        const copied = copiedQuotes(event.clipboardData, text);
        const tools = loadedComposerQuoteTools();
        if (copied.length > 0 && tools === undefined) {
          // Quotes copied in another window: the quote code loads, takes them
          // as Octant's own, and the prompt draws them as chips.
          void loadComposerQuoteTools()
            .then((loaded) => {
              loaded.trustComposerQuotes(copied);
              tick();
            })
            .catch(() => undefined);
        }
        tools?.trustComposerQuotes(copied);
        pasteText(root, text.replace(/\r\n?/g, "\n"), plain);
      },
      onCopy: (event: ClipboardEvent<ComposerInputElement>) => {
        const root = rootRef.current;
        if (root === null) return;
        const { start, end } = currentSelection(root);
        if (start === end) return;
        event.preventDefault();
        copyText(event.clipboardData, modelRef.current.slice(start, end));
      },
      onCut: (event: ClipboardEvent<ComposerInputElement>) => {
        const root = rootRef.current;
        if (root === null) return;
        const { start, end } = currentSelection(root);
        if (start === end) return;
        event.preventDefault();
        copyText(event.clipboardData, modelRef.current.slice(start, end));
        if (editable) replaceSelection(root, "");
      },
      // Through React's own `onInput`, so the caller's state update lands
      // before the next key event, as it does for a text field's `onChange`.
      onInput: (event: FormEvent<ComposerInputElement>) => {
        const root = rootRef.current;
        if (root === null) return;
        const read = serialize(root);
        // Deleting the text after a chip leaves a line break that holds the
        // line open. A deletion adds no line, so it is no part of the prompt.
        const held =
          event.nativeEvent instanceof InputEvent &&
          event.nativeEvent.inputType.startsWith("delete") &&
          read.endsWith("\n") &&
          lineBreaks(read) > lineBreaks(modelRef.current);
        const next = held ? read.slice(0, -1) : read;
        const caret = Math.min(readSelection(root)?.start ?? next.length, next.length);
        if (next === modelRef.current && next === reportedRef.current) return;
        const chipsChanged =
          chipsOf(next, findInlineRef.current).length !==
          chipsOf(modelRef.current, findInlineRef.current).length;
        emit(next, caret, { typing: !chipsChanged });
      },
    });

    return (
      <>
        {element}
        {chipHosts.map((host) => {
          const { chip, node } = host;
          const locate = () => {
            const root = rootRef.current;
            const start = root === null ? chip.start : offsetOf(root, node, 0);
            return { start, end: start + chip.text.length };
          };
          const drawn =
            chip.kind === "model" ? (
              renderModelChip?.(chip.match, locate)
            ) : chip.kind === "quote" ? (
              <LazyQuoteChip
                editable={editable}
                onChange={(next) => {
                  const { start, end } = locate();
                  const tools = loadedComposerQuoteTools();
                  if (tools !== undefined) replaceRange(start, end, tools.composerQuoteText(next));
                }}
                onRemove={() => {
                  const { start, end } = locate();
                  // The line the quote stood on goes with it.
                  const lineAfter = modelRef.current[end] === "\n" ? 1 : 0;
                  replaceRange(start, end + lineAfter, "");
                }}
                quote={chip.quote}
              />
            ) : (
              inlineChips?.render(chip.id, locate)
            );
          return createPortal(
            drawn ?? <span className="composer-chip__label">{chip.text}</span>,
            node,
            host.key,
          );
        })}
      </>
    );
  },
);
