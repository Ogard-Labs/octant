import type { CodeDebugClient } from "@octant/client-runtime/code-debug-client";
import type { CodeCheckoutId, CodeRelativePath, CodeThreadId } from "@octant/contracts/code";
import type {
  CodeDebugSessionId,
  CodeDebugSessionState,
  CodeDebugStackFrame,
  CodeDebugVariable,
} from "@octant/contracts/code-debug";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronDown,
  ChevronRight,
  Pause,
  Play,
  Redo2,
  Square,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton, OctantIconButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import {
  codeDebugThreadKey,
  codeDebugWindowState,
  type CodeDebugThreadState,
  type CodeDebugWindowState,
} from "./codeDebugWindowState";
import {
  useCodeDebugSession,
  type DebugConsoleItem,
  type DebugSessionControls,
  type DebugSessionView as SessionView,
} from "./useCodeDebugSession";
import { useFocusWhenShown } from "./useFocusWhenShown";

/** Nested values open at most this deep, so a value that holds itself stops somewhere. */
const MAX_VARIABLE_DEPTH = 8;

export interface DebugSessionViewProps {
  readonly client: CodeDebugClient;
  readonly threadId: CodeThreadId;
  readonly checkoutId: CodeCheckoutId;
  readonly sessionId: CodeDebugSessionId;
  readonly name: string;
  readonly store?: CodeDebugWindowState;
  /** Shows a checkout file at a line: the ordinary file-open path. */
  readonly onShowLocation: (path: CodeRelativePath, line: number) => void;
  readonly onEnded: (text: string) => void;
  readonly pollMs?: { readonly running?: number; readonly stopped?: number };
}

/**
 * A running session: its toolbar, the stopped program's call stack and
 * variables, and the debug console. Every answer is the host's; this view
 * keeps nothing once the session ends.
 */
export function DebugSessionView(props: DebugSessionViewProps) {
  const store = props.store ?? codeDebugWindowState;
  const key = codeDebugThreadKey(String(props.threadId), String(props.checkoutId));
  const { onShowLocation } = props;
  const [view, controls] = useCodeDebugSession({
    client: props.client,
    threadId: props.threadId,
    checkoutId: props.checkoutId,
    sessionId: props.sessionId,
    onStoppedAt: (frame) => {
      const location = frame?.location;
      if (location?.kind === "checkout") {
        store.setStopped(key, { path: location.path, line: location.line });
        onShowLocation(location.path, location.line);
      } else {
        store.setStopped(key, undefined);
      }
    },
    onEnded: props.onEnded,
    ...(props.pollMs === undefined ? {} : { pollMs: props.pollMs }),
  });
  useBreakpointSync(store, key, controls);
  // With the tool closed nothing follows the program, so a line the editor
  // marked could outlive the stop. Reopening reads the stop and marks it again.
  useEffect(() => () => store.setStopped(key, undefined), [key, store]);
  const stopped = view.state?.status === "stopped";
  const running = view.state?.status === "running";
  const busy = view.pending !== undefined;
  // Start, which this view replaces, had focus; a step keeps it on its own
  // button, which stays focusable while the step is pending.
  const sessionName = useFocusWhenShown<HTMLParagraphElement>();

  return (
    <div className="run-debug__session">
      <div aria-label="Debug session" className="run-debug__controls" role="toolbar">
        <p className="run-debug__session-name" ref={sessionName} tabIndex={-1} title={props.name}>
          {props.name}
        </p>
        <span className="run-debug__state" role="status">
          {stateText(view.state)}
        </span>
        <OctantIconButton
          disabled={!stopped || busy}
          focusableWhenDisabled
          label="Continue"
          onClick={() => controls.step("continue")}
          type="button"
        >
          <Play aria-hidden="true" size={16} />
        </OctantIconButton>
        <OctantIconButton
          disabled={!running || busy}
          focusableWhenDisabled
          label="Pause"
          onClick={() => controls.step("pause")}
          type="button"
        >
          <Pause aria-hidden="true" size={16} />
        </OctantIconButton>
        <OctantIconButton
          disabled={!stopped || busy}
          focusableWhenDisabled
          label="Step over"
          onClick={() => controls.step("next")}
          type="button"
        >
          <Redo2 aria-hidden="true" size={16} />
        </OctantIconButton>
        <OctantIconButton
          disabled={!stopped || busy}
          focusableWhenDisabled
          label="Step into"
          onClick={() => controls.step("step-in")}
          type="button"
        >
          <ArrowDownToLine aria-hidden="true" size={16} />
        </OctantIconButton>
        <OctantIconButton
          disabled={!stopped || busy}
          focusableWhenDisabled
          label="Step out"
          onClick={() => controls.step("step-out")}
          type="button"
        >
          <ArrowUpFromLine aria-hidden="true" size={16} />
        </OctantIconButton>
        <OctantIconButton
          disabled={view.pending === "stop"}
          focusableWhenDisabled
          label="Stop"
          onClick={controls.stop}
          type="button"
        >
          <Square aria-hidden="true" size={14} />
        </OctantIconButton>
      </div>
      {view.state?.status === "stopped" && view.state.description !== undefined ? (
        <p className="run-debug__line">{view.state.description}</p>
      ) : null}
      {view.notice === undefined ? null : (
        <OctantAlert className="run-debug__alert" tone="warning">
          {view.notice}
        </OctantAlert>
      )}
      <div className="run-debug__panes">
        <CallStack
          controls={controls}
          onShowLocation={onShowLocation}
          stopped={stopped}
          view={view}
        />
        <Variables controls={controls} stopped={stopped} view={view} />
        <DebugConsole controls={controls} lines={view.console} />
      </div>
    </div>
  );
}

function stateText(state: CodeDebugSessionState | undefined): string {
  switch (state?.status) {
    case undefined:
    case "starting":
      return "Starting…";
    case "running":
      return "Running";
    case "stopped":
      return `Paused · ${state.reason}`;
    case "ended":
      return "Ended";
  }
}

/**
 * While a session runs, a breakpoint the person sets or clears in the editor
 * goes to the adapter at once, one file at a time. The breakpoints held when
 * the session started went with Start.
 */
function useBreakpointSync(
  store: CodeDebugWindowState,
  key: string,
  controls: DebugSessionControls,
): void {
  const sent = useRef<CodeDebugThreadState["breakpoints"]>(store.read(key).breakpoints);
  const ask = useRef(controls.ask);
  ask.current = controls.ask;
  useEffect(
    () =>
      store.subscribe(() => {
        const next = store.read(key).breakpoints;
        const previous = sent.current;
        if (next === previous) return;
        sent.current = next;
        const paths = new Set([...previous.keys(), ...next.keys()]);
        for (const path of paths) {
          const lines = next.get(path) ?? [];
          if (sameLines(previous.get(path) ?? [], lines)) continue;
          void ask.current({
            kind: "set-breakpoints",
            file: { path, breakpoints: lines.map((line) => ({ line })) },
          });
        }
      }),
    [key, store],
  );
}

function sameLines(left: ReadonlyArray<number>, right: ReadonlyArray<number>): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

function CallStack(props: {
  readonly view: SessionView;
  readonly controls: DebugSessionControls;
  readonly stopped: boolean;
  readonly onShowLocation: (path: CodeRelativePath, line: number) => void;
}) {
  const headingId = useId();
  const [source, setSource] = useState<{ readonly title: string; readonly text: string }>();
  const { frames } = props.view;
  return (
    <section aria-labelledby={headingId} className="run-debug__section">
      <h3 className="run-debug__heading" id={headingId}>
        Call stack
      </h3>
      {!props.stopped || frames.length === 0 ? (
        <p className="run-debug__empty">
          {props.stopped ? "The adapter named no frames." : "Shown when the program pauses."}
        </p>
      ) : (
        <ol className="run-debug__frames">
          {frames.map((frame) => (
            <li key={frame.id}>
              <OctantButton
                aria-current={frame.id === props.view.selectedFrameId ? "true" : undefined}
                className="run-debug__frame"
                onClick={() => {
                  props.controls.selectFrame(frame.id);
                  const location = frame.location;
                  if (location.kind === "checkout") {
                    props.onShowLocation(location.path, location.line);
                  } else if (
                    location.kind === "outside-checkout" &&
                    location.sourceReference !== undefined
                  ) {
                    void props.controls.source(location.sourceReference).then((text) => {
                      if (text !== undefined) setSource({ title: frame.name, text });
                    });
                  }
                }}
                type="button"
                variant="bare"
              >
                <span className="run-debug__frame-name">{frame.name}</span>
                <span className="run-debug__frame-place">{framePlace(frame)}</span>
              </OctantButton>
            </li>
          ))}
        </ol>
      )}
      {props.view.framesTruncated ? (
        <p className="run-debug__empty">More frames are not shown.</p>
      ) : null}
      {source === undefined ? null : (
        <div className="run-debug__source">
          <div className="run-debug__source-head">
            <span>{source.title} · read-only source from the adapter</span>
            <OctantButton
              onClick={() => setSource(undefined)}
              size="xs"
              type="button"
              variant="ghost"
            >
              Close
            </OctantButton>
          </div>
          <pre>{source.text}</pre>
        </div>
      )}
    </section>
  );
}

function framePlace(frame: CodeDebugStackFrame): string {
  const location = frame.location;
  switch (location.kind) {
    case "checkout":
      return `${location.path}:${location.line}`;
    case "outside-checkout":
      return location.label === "adapter-source" ? "Adapter source" : "Outside the checkout";
    case "none":
      return "No source";
  }
}

function Variables(props: {
  readonly view: SessionView;
  readonly controls: DebugSessionControls;
  readonly stopped: boolean;
}) {
  const headingId = useId();
  const [closed, setClosed] = useState<ReadonlySet<number>>(new Set());
  const { scopes } = props.view;
  return (
    <section aria-labelledby={headingId} className="run-debug__section">
      <h3 className="run-debug__heading" id={headingId}>
        Variables
      </h3>
      {!props.stopped || scopes.length === 0 ? (
        <p className="run-debug__empty">
          {props.stopped ? "This frame has no variables." : "Shown when the program pauses."}
        </p>
      ) : (
        <ul className="run-debug__tree">
          {scopes.map((view) => {
            const reference = view.scope.variablesReference;
            const open = view.variables !== undefined && !closed.has(reference);
            return (
              <li key={`${view.scope.name}-${reference}`}>
                <OctantButton
                  aria-expanded={open}
                  className="run-debug__toggle"
                  onClick={() => {
                    if (view.variables === undefined) props.controls.loadScope(reference);
                    setClosed((current) => {
                      const next = new Set(current);
                      if (open) next.add(reference);
                      else next.delete(reference);
                      return next;
                    });
                  }}
                  type="button"
                  variant="bare"
                >
                  {open ? (
                    <ChevronDown aria-hidden="true" size={14} />
                  ) : (
                    <ChevronRight aria-hidden="true" size={14} />
                  )}
                  <span className="run-debug__scope-name">{view.scope.name}</span>
                </OctantButton>
                {open && view.variables !== undefined ? (
                  <VariableList
                    controls={props.controls}
                    depth={1}
                    truncated={view.truncated === true}
                    variables={view.variables}
                    view={props.view}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function VariableList(props: {
  readonly variables: ReadonlyArray<CodeDebugVariable>;
  readonly truncated: boolean;
  readonly depth: number;
  readonly view: SessionView;
  readonly controls: DebugSessionControls;
}) {
  return (
    <ul className="run-debug__tree">
      {props.variables.map((variable, index) => (
        <VariableRow
          controls={props.controls}
          depth={props.depth}
          key={`${variable.name}-${index}`}
          variable={variable}
          view={props.view}
        />
      ))}
      {props.truncated ? <li className="run-debug__empty">More values are not shown.</li> : null}
    </ul>
  );
}

function VariableRow(props: {
  readonly variable: CodeDebugVariable;
  readonly depth: number;
  readonly view: SessionView;
  readonly controls: DebugSessionControls;
}) {
  const { variable } = props;
  const [open, setOpen] = useState(false);
  const expandable = variable.variablesReference > 0 && props.depth < MAX_VARIABLE_DEPTH;
  const children = props.view.children.get(variable.variablesReference);
  const value = <VariableValue variable={variable} />;
  return (
    <li>
      {expandable ? (
        <OctantButton
          aria-expanded={open}
          className="run-debug__toggle"
          onClick={() => {
            if (!open && children === undefined) {
              props.controls.expand(variable.variablesReference);
            }
            setOpen(!open);
          }}
          type="button"
          variant="bare"
        >
          {open ? (
            <ChevronDown aria-hidden="true" size={14} />
          ) : (
            <ChevronRight aria-hidden="true" size={14} />
          )}
          {value}
        </OctantButton>
      ) : (
        <div className="run-debug__leaf">{value}</div>
      )}
      {open && children !== undefined ? (
        <VariableList
          controls={props.controls}
          depth={props.depth + 1}
          truncated={children.truncated}
          variables={children.variables}
          view={props.view}
        />
      ) : null}
    </li>
  );
}

function VariableValue(props: { readonly variable: CodeDebugVariable }) {
  const { variable } = props;
  return (
    <span className="run-debug__variable">
      <span className="run-debug__variable-name">{variable.name}</span>
      <span className="run-debug__variable-value" title={variable.type}>
        {variable.value}
        {variable.truncated ? " … (cut at 4 KiB)" : ""}
      </span>
    </span>
  );
}

function DebugConsole(props: {
  readonly lines: SessionView["console"];
  readonly controls: DebugSessionControls;
}) {
  const headingId = useId();
  const inputId = useId();
  const [expression, setExpression] = useState("");
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const element = list.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  }, [props.lines]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const typed = expression.trim();
    if (typed.length === 0) return;
    props.controls.evaluate(typed);
    setExpression("");
  };
  return (
    <section aria-labelledby={headingId} className="run-debug__section run-debug__console">
      <h3 className="run-debug__heading" id={headingId}>
        Debug console
      </h3>
      <ol aria-live="polite" className="run-debug__console-lines" ref={list}>
        {props.lines.map((line) => (
          <li data-kind={consoleKind(line.item)} key={line.id}>
            {consoleText(line.item)}
          </li>
        ))}
      </ol>
      <form className="run-debug__evaluate" noValidate onSubmit={submit}>
        <label className="sr-only" htmlFor={inputId}>
          Evaluate an expression
        </label>
        <OctantInput
          autoComplete="off"
          id={inputId}
          onChange={(event) => setExpression(event.currentTarget.value)}
          placeholder="Evaluate an expression"
          spellCheck={false}
          value={expression}
        />
      </form>
    </section>
  );
}

function consoleKind(item: DebugConsoleItem): string {
  return item.kind === "output" ? item.entry.category : item.kind;
}

function consoleText(item: DebugConsoleItem): string {
  switch (item.kind) {
    case "output":
      return item.entry.text;
    case "input":
      return `› ${item.expression}`;
    case "result":
      return item.result.value + (item.result.truncated ? " … (cut at 4 KiB)" : "");
    case "notice":
      return item.text;
  }
}
