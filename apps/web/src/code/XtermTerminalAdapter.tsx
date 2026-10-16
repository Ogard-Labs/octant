import { describeChord, matchTerminalKeybinding, type OctantKeybindings } from "@octant/domain";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { TerminalTypographyProjection } from "@octant/theme/typography";
import { useKeybindings } from "../keybindings/useKeybindings";
import { isApplePlatform } from "../platform";
import { useTypographyProjection } from "../theme/TypographyProvider";
import { OctantAlert } from "../ui/base/OctantAlert";

export interface XtermAdapterSession {
  readonly dispose: () => void;
  readonly focus: () => void;
  /** The text the user has selected in the terminal, empty when none is. */
  readonly readSelection?: () => string;
  readonly setInteractive: (interactive: boolean) => void;
  readonly setOutput: (output: string) => void;
  readonly setTypography?: (typography: TerminalTypographyProjection) => void;
}

export interface XtermAdapterRuntime {
  readonly mount: (
    element: HTMLElement,
    options: {
      /** The id of the element that tells a keyboard user how to leave. */
      readonly describedBy?: string;
      readonly interactive: boolean;
      /**
       * Offered every key event before the terminal engine sees it. `true`
       * claims the event: the engine then sends nothing to the shell for it.
       */
      readonly interceptKey?: (event: KeyboardEvent) => boolean;
      readonly onData: (data: string) => void;
      readonly onResize: (columns: number, rows: number) => void;
      readonly output: string;
      readonly typography?: TerminalTypographyProjection;
    },
  ) => XtermAdapterSession;
}

export interface XtermTerminalAdapterProps {
  readonly ariaLabel: string;
  readonly interactive: boolean;
  readonly loadRuntime?: () => Promise<XtermAdapterRuntime>;
  readonly onData: (data: string) => void;
  readonly onResize: (columns: number, rows: number) => void;
  /**
   * Hands the caller a way to read the terminal's current selection, and
   * `undefined` once the session is gone. The selection lives in the terminal
   * engine, so nothing above this adapter can observe it without being given a
   * reader.
   */
  readonly onSelectionReader?: (read: (() => string) | undefined) => void;
  readonly output: string;
  readonly typography?: TerminalTypographyProjection;
}

export function XtermTerminalAdapter(props: XtermTerminalAdapterProps) {
  const contextualTypography = useTypographyProjection("terminal");
  const typography = props.typography ?? contextualTypography;
  const [runtimeUnavailable, setRuntimeUnavailable] = useState(false);
  const element = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const [focused, setFocused] = useState(false);
  const { keybindings } = useKeybindings();
  const latestKeybindings = useRef(keybindings);
  const latestProps = useRef(props);
  const latestTypography = useRef(typography);
  const session = useRef<XtermAdapterSession | undefined>(undefined);
  const loader = props.loadRuntime ?? loadXtermRuntime;

  useLayoutEffect(() => {
    latestProps.current = props;
  }, [props]);

  useLayoutEffect(() => {
    latestTypography.current = typography;
  }, [typography]);

  useLayoutEffect(() => {
    latestKeybindings.current = keybindings;
  }, [keybindings]);

  useEffect(() => {
    let disposed = false;
    setRuntimeUnavailable(false);
    void loader()
      .then((runtime) => {
        if (disposed || element.current === null) return;
        const mounted = runtime.mount(element.current, {
          describedBy: hintId,
          interactive: latestProps.current.interactive,
          interceptKey: (event) => {
            const action = matchTerminalKeybinding(
              latestKeybindings.current,
              event,
              isApplePlatform(),
            );
            if (action === undefined) return false;
            // Only the press moves focus; the matching keyup and keypress are
            // claimed too so the shell never sees half of the chord.
            if (event.type === "keydown" && element.current !== null) {
              event.preventDefault();
              moveFocusOut(element.current, action === "terminal-focus-next" ? "next" : "previous");
            }
            return true;
          },
          onData: (data) => latestProps.current.onData(data),
          onResize: (columns, rows) => latestProps.current.onResize(columns, rows),
          output: latestProps.current.output,
          typography: latestTypography.current,
        });
        if (disposed) {
          mounted.dispose();
          return;
        }
        session.current = mounted;
        const read = mounted.readSelection;
        latestProps.current.onSelectionReader?.(read === undefined ? undefined : () => read());
      })
      .catch(() => {
        if (!disposed) setRuntimeUnavailable(true);
      });
    return () => {
      disposed = true;
      session.current?.dispose();
      session.current = undefined;
      latestProps.current.onSelectionReader?.(undefined);
    };
  }, [loader, hintId]);

  useEffect(() => session.current?.setOutput(props.output), [props.output]);
  useEffect(() => session.current?.setInteractive(props.interactive), [props.interactive]);
  useEffect(() => session.current?.setTypography?.(typography), [typography]);

  return (
    <>
      <section
        aria-describedby={hintId}
        aria-label={props.ariaLabel}
        data-read-only={!props.interactive}
        onBlur={() => setFocused(false)}
        onFocus={() => {
          setFocused(true);
          session.current?.focus();
        }}
        ref={element}
        tabIndex={0}
      />
      <p className="terminal-leave-hint" data-visible={focused} id={hintId}>
        {leaveHint(keybindings)}
      </p>
      {runtimeUnavailable ? (
        <OctantAlert tone="warning">
          The Code terminal engine is unavailable. Retry this tab.
        </OctantAlert>
      ) : null}
    </>
  );
}

/**
 * The terminal sends Tab, Shift+Tab, Escape and function keys to its shell, so
 * a keyboard user has no other way out of it. This line names the chord that
 * leaves; it stays in the layout, and is only drawn while the terminal holds
 * the keyboard, so focusing the terminal never moves the output.
 */
function leaveHint(keybindings: OctantKeybindings): string {
  const apple = isApplePlatform();
  const next = keybindings.bindings.get("terminal-focus-next");
  const previous = keybindings.bindings.get("terminal-focus-previous");
  const parts = [
    next === undefined ? undefined : `${describeChord(next, apple)} leaves the terminal`,
    previous === undefined ? undefined : `${describeChord(previous, apple)} goes back`,
  ].filter((part): part is string => part !== undefined);
  return parts.join(" · ");
}

const TABBABLE =
  'a[href], button, input:not([type="hidden"]), select, textarea, summary, [contenteditable=""], [contenteditable="true"], [tabindex]';

function tabbable(candidate: HTMLElement): boolean {
  if (candidate.tabIndex < 0) return false;
  if (candidate.matches(":disabled")) return false;
  if (candidate.closest("[inert], [hidden]") !== null) return false;
  return typeof candidate.checkVisibility === "function" ? candidate.checkVisibility() : true;
}

/**
 * Moves keyboard focus to the control after (or before) the terminal in
 * document order, wrapping at the ends.
 *
 * The terminal's own helper textarea and section are skipped, or "next" would
 * land back inside the terminal that was just left. With no other control on
 * the page, focus is released rather than kept: leaving was the request.
 */
function moveFocusOut(terminal: HTMLElement, direction: "next" | "previous"): void {
  const others = [...terminal.ownerDocument.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (candidate) => !terminal.contains(candidate) && tabbable(candidate),
  );
  const following = others.filter(
    (candidate) => terminal.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
  const preceding = others.filter(
    (candidate) => terminal.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_PRECEDING,
  );
  const target =
    direction === "next"
      ? (following[0] ?? preceding[0])
      : (preceding[preceding.length - 1] ?? following[following.length - 1]);
  if (target === undefined) {
    const active = terminal.ownerDocument.activeElement;
    if (active instanceof HTMLElement) active.blur();
    return;
  }
  target.focus();
}

async function loadXtermRuntime(): Promise<XtermAdapterRuntime> {
  return import("./xtermRuntime");
}
