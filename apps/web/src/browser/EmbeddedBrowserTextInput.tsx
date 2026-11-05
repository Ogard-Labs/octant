import { useEffect, useRef } from "react";
import type {
  HumanBrowserComposition,
  HumanBrowserEditor,
  HumanBrowserResult,
} from "@octant/contracts/browser-presentation";

interface Transaction {
  readonly editor: HumanBrowserEditor;
  readonly generation: number;
  readonly started: Promise<
    Extract<HumanBrowserResult, { readonly status: "composition-started" }> | undefined
  >;
  tail: Promise<void>;
  terminal: boolean;
}

/** A native input context contains only this person's candidate, never page text. */
export function EmbeddedBrowserTextInput(props: {
  readonly editor: HumanBrowserEditor | undefined;
  readonly group: React.RefObject<HTMLDivElement | null>;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly pointerHeld: () => boolean;
  readonly compose: (composition: HumanBrowserComposition) => Promise<HumanBrowserResult>;
}) {
  const input = useRef<HTMLDivElement>(null);
  const transaction = useRef<Transaction | undefined>(undefined);
  const generation = useRef(0);
  const retirement = useRef<Promise<void>>(Promise.resolve());
  const latest = useRef(props);
  latest.current = props;
  const position = () => {
    const element = input.current,
      editor = latest.current.editor;
    if (element === null || editor === undefined) return;
    const selection = window.getSelection();
    const range =
      selection !== null && selection.rangeCount > 0 && element.contains(selection.anchorNode)
        ? selection.getRangeAt(0).cloneRange()
        : undefined;
    range?.collapse(false);
    const local = range?.getBoundingClientRect(),
      bounds = element.getBoundingClientRect();
    const dx = local !== undefined && local.height > 0 ? local.left - bounds.left : 0;
    const dy = local !== undefined && local.height > 0 ? local.top - bounds.top : 0;
    element.style.left = `${editor.caret.x * latest.current.scaleX - dx}px`;
    element.style.top = `${editor.caret.y * latest.current.scaleY - dy}px`;
  };
  const retire = (clear = true) => {
    generation.current++;
    const owned = transaction.current;
    transaction.current = undefined;
    if (owned !== undefined) {
      owned.terminal = true;
      // A queued commit is not a settled commit. Even a pending acquisition
      // must receive its exact-ID cleanup before a successor can begin.
      retirement.current = owned.tail
        .then(async () => {
          const started = await owned.started;
          if (started !== undefined)
            await latest.current.compose({ phase: "cancel", compositionId: started.compositionId });
        })
        .catch(() => {});
    }
    const element = input.current;
    if (clear && element !== null) element.replaceChildren();
  };
  useEffect(() => {
    retire();
    const element = input.current,
      group = props.group.current;
    if (element === null || group === null) return;
    if (props.editor === undefined) {
      if (document.activeElement === element) group.focus({ preventScroll: true });
    } else if (document.hasFocus() && document.activeElement === group && !props.pointerHeld()) {
      element.focus({ preventScroll: true });
      position();
    }
    return () => retire();
  }, [props.editor?.id]);
  useEffect(() => {
    const element = input.current,
      group = props.group.current;
    if (
      element !== null &&
      group !== null &&
      props.editor !== undefined &&
      document.hasFocus() &&
      document.activeElement === group &&
      !props.pointerHeld()
    )
      element.focus({ preventScroll: true });
    position();
  }, [props.editor, props.scaleX, props.scaleY]);

  const send = (terminal: boolean, text: string, start = 0, end = 0) => {
    const owned = transaction.current;
    if (owned === undefined || owned.terminal || owned.generation !== generation.current) return;
    if (
      !text.isWellFormed() ||
      text.length > 256 ||
      start < 0 ||
      end < start ||
      end > text.length
    ) {
      retire();
      return;
    }
    if (terminal) owned.terminal = true;
    owned.tail = owned.tail
      .then(async () => {
        const started = await owned.started;
        if (started === undefined || owned.generation !== generation.current) return;
        const result = await latest.current.compose(
          terminal
            ? { phase: "commit", compositionId: started.compositionId, text }
            : {
                phase: "update",
                compositionId: started.compositionId,
                text,
                selectionStart: start,
                selectionEnd: end,
              },
        );
        if (result.status !== "accepted" && owned.generation === generation.current) retire();
      })
      .catch(() => {
        if (owned.generation === generation.current) retire();
      });
  };
  return (
    <div
      ref={input}
      role="textbox"
      aria-label="Browser text input"
      tabIndex={-1}
      contentEditable={props.editor !== undefined}
      suppressContentEditableWarning
      spellCheck={false}
      style={{
        display: props.editor === undefined ? "none" : "block",
        position: "absolute",
        left: 0,
        top: 0,
        minWidth: 1,
        height: Math.max(1, (props.editor?.caret.height ?? 24) * props.scaleY),
        fontSize: Math.min(64, Math.max(8, (props.editor?.caret.height ?? 24) * props.scaleY)),
        lineHeight: "1",
        whiteSpace: "pre",
        color: "transparent",
        caretColor: "transparent",
        outline: "none",
        pointerEvents: "none",
        opacity: 0.01,
      }}
      onCompositionStart={() => {
        retire(false);
        const editor = latest.current.editor;
        if (editor === undefined) return;
        const started = retirement.current
          .then(() => latest.current.compose({ phase: "begin", editorId: editor.id }))
          .then((result) => (result.status === "composition-started" ? result : undefined))
          .catch(() => undefined);
        transaction.current = {
          editor,
          generation: generation.current,
          started,
          tail: Promise.resolve(),
          terminal: false,
        };
      }}
      onInput={(event) => {
        const owned = transaction.current;
        if (owned === undefined || owned.terminal || !event.nativeEvent.isComposing) return;
        // These nodes belong to the local native candidate. Page contents are
        // never mirrored into this input context.
        const text = event.currentTarget.textContent ?? "";
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(event.currentTarget);
        let end = text.length;
        if (
          selection?.focusNode !== null &&
          selection?.focusNode !== undefined &&
          event.currentTarget.contains(selection.focusNode)
        ) {
          range.setEnd(selection.focusNode, selection.focusOffset);
          end = range.toString().length;
        }
        send(false, text, end, end);
        position();
      }}
      onCompositionEnd={(event) => {
        // Electron can report trusted=false even for a real native compositionend.
        // The owning main's focus and native lease checks remain authoritative.
        send(true, event.data);
        position();
        const owned = transaction.current;
        requestAnimationFrame(() => {
          if (transaction.current === owned && owned?.terminal) input.current?.replaceChildren();
        });
      }}
      onBlur={() => retire()}
    />
  );
}
