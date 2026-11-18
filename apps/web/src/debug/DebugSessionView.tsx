import type { CodeDebugClient } from "@octant/client-runtime/code-debug-client";
import type { CodeCheckoutId, CodeRelativePath, CodeThreadId } from "@octant/contracts/code";
import type {
  CodeDebugChildId,
  CodeDebugChildSummary,
  CodeDebugSessionEndReason,
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
} from "../ui/icons";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton, OctantIconButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import {
  codeDebugThreadKey,
  activeBreakpoints,
  type CodeDebugThreadState,
  type CodeDebugWindowState,
} from "./codeDebugWindowState";
import { useCodeDebugWindowStore } from "./CodeDebugWindowProvider";
import {
  useCodeDebugSession,
  type DebugConsoleItem,
  type DebugSessionControls,
  type DebugSessionView as SessionView,
} from "./useCodeDebugSession";
import { useFocusWhenShown } from "./useFocusWhenShown";
import { visibleVariableRows, type VariableTreeRow } from "./variableTree";

export interface DebugSessionViewProps {
  readonly client: CodeDebugClient;
  readonly threadId: CodeThreadId;
  readonly checkoutId: CodeCheckoutId;
  readonly sessionId: CodeDebugSessionId;
  readonly name: string;
  readonly store?: CodeDebugWindowState;
  /** Shows a checkout file at a line: the ordinary file-open path. */
  readonly onShowLocation: (path: CodeRelativePath, line: number) => void;
  readonly onEnded: (text: string, reason?: CodeDebugSessionEndReason) => void;
  readonly pollMs?: { readonly running?: number; readonly stopped?: number };
}

/**
 * A running session: its toolbar, the stopped program's call stack and
 * variables, and the debug console. Every answer is the host's; this view
 * keeps nothing once the session ends.
 */
export function DebugSessionView(props: DebugSessionViewProps) {
  const windowStore = useCodeDebugWindowStore();
  const store = props.store ?? windowStore;
  const key = codeDebugThreadKey(String(props.threadId), String(props.checkoutId));
  const { onShowLocation } = props;
  const [child, setChild] = useState<CodeDebugChildId>();
  const [view, controls] = useCodeDebugSession({
    client: props.client,
    threadId: props.threadId,
    checkoutId: props.checkoutId,
    sessionId: props.sessionId,
    ...(child === undefined ? {} : { child }),
    onChildGone: () => setChild(undefined),
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
          label={child === undefined ? "Stop" : "Stop child process"}
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
        {view.childProcesses === undefined ? null : (
          <Processes
            programName={props.name}
            selected={child}
            onSelect={setChild}
            processes={view.childProcesses}
            undebugged={view.undebuggedChildren}
          />
        )}
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

/**
 * The program and each child process the session debugs, listed under the
 * session; the one selected is the one the toolbar, stack, and variables are
 * for. Present only when the adapter declares children.
 */
function Processes(props: {
  readonly programName: string;
  readonly processes: ReadonlyArray<CodeDebugChildSummary>;
  readonly selected: CodeDebugChildId | undefined;
  readonly onSelect: (child: CodeDebugChildId | undefined) => void;
  readonly undebugged: number;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="run-debug__section run-debug__processes">
      <h3 className="run-debug__heading" id={headingId}>
        Processes
      </h3>
      <ol className="run-debug__frames">
        <li>
          <OctantButton
            aria-current={props.selected === undefined ? "true" : undefined}
            className="run-debug__frame"
            onClick={() => props.onSelect(undefined)}
            type="button"
            variant="bare"
          >
            <span className="run-debug__frame-name">{props.programName}</span>
            <span className="run-debug__frame-place">Program</span>
          </OctantButton>
        </li>
        {props.processes.map((entry) => (
          <li key={entry.child}>
            <OctantButton
              aria-current={entry.child === props.selected ? "true" : undefined}
              className="run-debug__frame"
              onClick={() => props.onSelect(entry.child)}
              type="button"
              variant="bare"
            >
              <span className="run-debug__frame-name">{entry.name}</span>
              <span className="run-debug__frame-place">{childStatusText(entry.status)}</span>
            </OctantButton>
          </li>
        ))}
      </ol>
      {props.undebugged === 0 ? null : (
        <p className="run-debug__empty">
          {props.undebugged === 1
            ? "One child process ran undebugged."
            : `${String(props.undebugged)} child processes ran undebugged.`}
        </p>
      )}
    </section>
  );
}

function childStatusText(status: CodeDebugChildSummary["status"]): string {
  switch (status) {
    case "starting":
      return "Attaching…";
    case "running":
      return "Child · running";
    case "stopped":
      return "Child · paused";
  }
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
  const sent = useRef<CodeDebugThreadState["breakpoints"]>(activeBreakpoints(store.read(key)));
  const ask = useRef(controls.ask);
  ask.current = controls.ask;
  useEffect(
    () =>
      store.subscribe(() => {
        const next = activeBreakpoints(store.read(key));
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

const FRAME_VIRTUALIZATION_THRESHOLD = 40;
const FRAME_ROW_ESTIMATE = 28;

/**
 * The host asks the adapter for up to 200 frames, and a deep recursion fills
 * them all; past the threshold only the rows in view are mounted. The selected
 * frame stays mounted so its `aria-current` and focus survive scrolling, and
 * each row states its place so assistive technology still hears the length.
 */
function FrameList(props: {
  readonly frames: ReadonlyArray<CodeDebugStackFrame>;
  readonly selectedFrameId: number | undefined;
  readonly renderFrame: (frame: CodeDebugStackFrame) => ReactNode;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const virtualized = props.frames.length > FRAME_VIRTUALIZATION_THRESHOLD;
  const virtualizer = useVirtualizer({
    count: virtualized ? props.frames.length : 0,
    estimateSize: () => FRAME_ROW_ESTIMATE,
    getItemKey: (index) => String(props.frames[index]?.id ?? index),
    getScrollElement: () => listRef.current,
    overscan: 8,
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range);
      const selected = props.frames.findIndex((frame) => frame.id === props.selectedFrameId);
      return selected < 0 || indexes.includes(selected)
        ? indexes
        : [...indexes, selected].sort((left, right) => left - right);
    },
  });
  if (!virtualized) {
    return (
      <ol className="run-debug__frames">
        {props.frames.map((frame) => (
          <li key={frame.id}>{props.renderFrame(frame)}</li>
        ))}
      </ol>
    );
  }
  return (
    <div className="run-debug__frames-scroll" ref={listRef}>
      <ol
        className="run-debug__frames"
        style={{ height: virtualizer.getTotalSize(), position: "relative" }}
      >
        {virtualizer.getVirtualItems().map((item) => {
          const frame = props.frames[item.index];
          if (frame === undefined) return null;
          return (
            <li
              aria-posinset={item.index + 1}
              aria-setsize={props.frames.length}
              data-index={item.index}
              key={item.key}
              ref={virtualizer.measureElement}
              style={{
                left: 0,
                position: "absolute",
                top: 0,
                transform: `translateY(${String(item.start)}px)`,
                width: "100%",
              }}
            >
              {props.renderFrame(frame)}
            </li>
          );
        })}
      </ol>
    </div>
  );
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
        <FrameList
          frames={frames}
          renderFrame={(frame) => (
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
          )}
          selectedFrameId={props.view.selectedFrameId}
        />
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

/** Past this many visible rows the tree draws only the rows near its viewport. */
const VARIABLE_VIRTUALIZATION_THRESHOLD = 100;
const VARIABLE_ROW_ESTIMATE = 24;

function Variables(props: {
  readonly view: SessionView;
  readonly controls: DebugSessionControls;
  readonly stopped: boolean;
}) {
  const headingId = useId();
  const [closed, setClosed] = useState<ReadonlySet<number>>(new Set());
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  // The row that takes Tab into the tree (roving tabindex), and the row a key
  // press moved focus to, which takes it once it is mounted.
  const [activeKey, setActiveKey] = useState<string | undefined>(undefined);
  const pendingFocus = useRef<string | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<HTMLUListElement>(null);
  const rows = visibleVariableRows(props.view, closed, opened);
  const items = rows.filter((row) => row.kind !== "more");
  const active = items.find((row) => row.key === activeKey) ?? items[0];
  const activeIndex = active === undefined ? -1 : rows.indexOf(active);
  const virtualized = rows.length > VARIABLE_VIRTUALIZATION_THRESHOLD;
  const virtualizer = useVirtualizer({
    count: virtualized ? rows.length : 0,
    estimateSize: () => VARIABLE_ROW_ESTIMATE,
    getItemKey: (index) => rows[index]?.key ?? String(index),
    getScrollElement: () => scrollRef.current,
    overscan: 10,
    rangeExtractor: (range) => {
      // The focusable row stays mounted, so Tab and focus never land on a row
      // that scrolled away and unmounted.
      const indexes = defaultRangeExtractor(range);
      return activeIndex < 0 || activeIndex >= range.count || indexes.includes(activeIndex)
        ? indexes
        : [...indexes, activeIndex].sort((left, right) => left - right);
    },
  });

  useEffect(() => {
    if (pendingFocus.current === undefined || pendingFocus.current !== active?.key) return;
    pendingFocus.current = undefined;
    const rowElements = treeRef.current?.querySelectorAll<HTMLElement>("[data-row-key]") ?? [];
    for (const row of rowElements) if (row.dataset.rowKey === active.key) row.focus();
  });

  const toggle = (row: VariableTreeRow) => {
    if (row.kind === "scope") {
      if (!row.loaded) props.controls.loadScope(row.reference);
      setClosed((current) => {
        const next = new Set(current);
        if (row.expanded) next.add(row.reference);
        else next.delete(row.reference);
        return next;
      });
    } else if (row.kind === "variable" && row.expandable) {
      if (!row.expanded && !row.loaded) props.controls.expand(row.variable.variablesReference);
      setOpened((current) => {
        const next = new Set(current);
        if (row.expanded) next.delete(row.key);
        else next.add(row.key);
        return next;
      });
    }
  };
  const moveTo = (row: VariableTreeRow | undefined) => {
    if (row === undefined) return;
    pendingFocus.current = row.key;
    setActiveKey(row.key);
    if (virtualized) virtualizer.scrollToIndex(rows.indexOf(row));
  };
  const onKeyDown = (
    event: KeyboardEvent<HTMLElement>,
    row: Exclude<VariableTreeRow, { readonly kind: "more" }>,
  ) => {
    const at = items.indexOf(row);
    const canToggle = row.kind === "scope" || (row.kind === "variable" && row.expandable);
    switch (event.key) {
      case "ArrowDown":
        moveTo(items[at + 1]);
        break;
      case "ArrowUp":
        moveTo(items[at - 1]);
        break;
      case "Home":
        moveTo(items[0]);
        break;
      case "End":
        moveTo(items.at(-1));
        break;
      case "ArrowRight":
        if (canToggle && !row.expanded) toggle(row);
        else if (row.expanded && (items[at + 1]?.level ?? 0) > row.level) moveTo(items[at + 1]);
        break;
      case "ArrowLeft":
        if (canToggle && row.expanded) toggle(row);
        else moveTo(items.slice(0, at).findLast((item) => item.level === row.level - 1));
        break;
      case "Enter":
      case " ":
        toggle(row);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const renderRow = (row: VariableTreeRow, style?: CSSProperties, index?: number) => {
    const depth = { "--run-debug-depth": String(row.level - 1) } as CSSProperties;
    const measured =
      index === undefined ? {} : { "data-index": index, ref: virtualizer.measureElement };
    if (row.kind === "more") {
      return (
        <li
          className="run-debug__empty run-debug__tree-row"
          key={row.key}
          role="none"
          style={{ ...depth, ...style }}
          {...measured}
        >
          More values are not shown.
        </li>
      );
    }
    const canToggle = row.kind === "scope" || row.expandable;
    const chevron = row.expanded ? (
      <ChevronDown aria-hidden="true" size={14} />
    ) : (
      <ChevronRight aria-hidden="true" size={14} />
    );
    return (
      <li
        aria-expanded={canToggle ? row.expanded : undefined}
        aria-level={row.level}
        aria-posinset={row.posInSet}
        aria-setsize={row.setSize}
        className="run-debug__tree-row"
        data-row-key={row.key}
        key={row.key}
        onClick={() => {
          setActiveKey(row.key);
          toggle(row);
        }}
        onKeyDown={(event) => onKeyDown(event, row)}
        role="treeitem"
        style={{ ...depth, ...style }}
        tabIndex={row === active ? 0 : -1}
        {...measured}
      >
        {row.kind === "scope" ? (
          <span className="run-debug__toggle">
            {chevron}
            <span className="run-debug__scope-name">{row.name}</span>
          </span>
        ) : row.expandable ? (
          <span className="run-debug__toggle">
            {chevron}
            <VariableValue variable={row.variable} />
          </span>
        ) : (
          <div className="run-debug__leaf">
            <VariableValue variable={row.variable} />
          </div>
        )}
      </li>
    );
  };

  const empty = !props.stopped || props.view.scopes.length === 0;
  return (
    <section aria-labelledby={headingId} className="run-debug__section">
      <h3 className="run-debug__heading" id={headingId}>
        Variables
      </h3>
      {empty ? (
        <p className="run-debug__empty">
          {props.stopped ? "This frame has no variables." : "Shown when the program pauses."}
        </p>
      ) : !virtualized ? (
        <ul aria-labelledby={headingId} className="run-debug__tree" ref={treeRef} role="tree">
          {rows.map((row) => renderRow(row))}
        </ul>
      ) : (
        <div className="run-debug__tree-scroll" ref={scrollRef}>
          <ul
            aria-labelledby={headingId}
            className="run-debug__tree"
            ref={treeRef}
            role="tree"
            style={{ height: virtualizer.getTotalSize(), position: "relative" }}
          >
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index];
              if (row === undefined) return null;
              return renderRow(
                row,
                {
                  left: 0,
                  position: "absolute",
                  top: 0,
                  transform: `translateY(${String(item.start)}px)`,
                  width: "100%",
                },
                item.index,
              );
            })}
          </ul>
        </div>
      )}
    </section>
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
