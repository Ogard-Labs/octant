import type { CodeDebugClient } from "@octant/client-runtime/code-debug-client";
import type { CodeCheckoutId, CodeThreadId } from "@octant/contracts/code";
import type {
  CodeDebugChildId,
  CodeDebugChildSummary,
  CodeDebugOutputEntry,
  CodeDebugScope,
  CodeDebugSessionId,
  CodeDebugSessionRequest,
  CodeDebugSessionResult,
  CodeDebugSessionState,
  CodeDebugStackFrame,
  CodeDebugVariable,
} from "@octant/contracts/code-debug";
import { useCallback, useEffect, useRef, useState } from "react";
import { endReasonText, LOCAL_ONLY_TEXT, refusalText } from "./runDebugPanelModel";
import { CodeDebugClientFailure } from "@octant/client-runtime/code-debug-client";

/** How often the panel asks a session for its state while it runs, and while it is stopped. */
const RUNNING_POLL_MS = 400;
const STOPPED_POLL_MS = 1_000;
/** Console lines the panel keeps; older ones scroll away, as the host's ring does. */
const MAX_CONSOLE_LINES = 1_000;
const UNREACHABLE_TEXT = "The host could not be reached.";

export type DebugConsoleItem =
  | { readonly kind: "output"; readonly entry: CodeDebugOutputEntry }
  | { readonly kind: "input"; readonly expression: string }
  | { readonly kind: "result"; readonly result: CodeDebugVariable }
  | { readonly kind: "notice"; readonly text: string };

export interface DebugConsoleLine {
  readonly id: string;
  readonly item: DebugConsoleItem;
}

export interface DebugScopeView {
  readonly scope: CodeDebugScope;
  /** Undefined until read; an expensive scope is read only when the person opens it. */
  readonly variables?: ReadonlyArray<CodeDebugVariable>;
  readonly truncated?: boolean;
}

export interface DebugSessionView {
  readonly state: CodeDebugSessionState | undefined;
  readonly frames: ReadonlyArray<CodeDebugStackFrame>;
  readonly framesTruncated: boolean;
  readonly selectedFrameId: number | undefined;
  readonly scopes: ReadonlyArray<DebugScopeView>;
  /** Children of expanded variables, by their expansion reference. */
  readonly children: ReadonlyMap<
    number,
    { readonly variables: ReadonlyArray<CodeDebugVariable>; readonly truncated: boolean }
  >;
  readonly console: ReadonlyArray<DebugConsoleLine>;
  /** The last thing a request said that the person should read, if any. */
  readonly notice: string | undefined;
  /** A request the panel sent is waiting for its answer. */
  readonly pending: string | undefined;
  /** The child processes the session debugs now; undefined when its adapter declares none. */
  readonly childProcesses: ReadonlyArray<CodeDebugChildSummary> | undefined;
  /** Children the adapter announced that ran undebugged. */
  readonly undebuggedChildren: number;
}

export interface DebugSessionControls {
  readonly step: (kind: "continue" | "next" | "step-in" | "step-out" | "pause") => void;
  readonly stop: () => void;
  readonly selectFrame: (frameId: number) => void;
  readonly loadScope: (variablesReference: number) => void;
  readonly expand: (variablesReference: number) => void;
  readonly evaluate: (expression: string) => void;
  readonly source: (sourceReference: number) => Promise<string | undefined>;
  readonly ask: (request: CodeDebugSessionRequest) => Promise<CodeDebugSessionResult | undefined>;
}

/**
 * One running session, as this window sees it. The host holds the session
 * and decides every answer; the panel polls its state, reads the stopped
 * program's stack and variables at each new stop, and sends the person's
 * steps and expressions. Nothing read here is kept after the session.
 *
 * With `child` set, every request but the console's output is for that child
 * process; when the child ends, `onChildGone` hands the view back to the
 * program, and the session goes on.
 */
export function useCodeDebugSession(input: {
  readonly client: CodeDebugClient;
  readonly threadId: CodeThreadId;
  readonly checkoutId: CodeCheckoutId;
  readonly sessionId: CodeDebugSessionId;
  /** The child process the view shows; undefined for the program the session started. */
  readonly child?: CodeDebugChildId;
  /** The child the view shows has ended. */
  readonly onChildGone?: () => void;
  /** The session reached the program and stopped in a checkout file, or left it. */
  readonly onStoppedAt: (frame: CodeDebugStackFrame | undefined) => void;
  /** The session is over; the words say why. */
  readonly onEnded: (text: string) => void;
  readonly pollMs?: { readonly running?: number; readonly stopped?: number };
}): readonly [DebugSessionView, DebugSessionControls] {
  const { client, threadId, checkoutId, sessionId, child } = input;
  const [state, setState] = useState<CodeDebugSessionState>();
  const [frames, setFrames] = useState<ReadonlyArray<CodeDebugStackFrame>>([]);
  const [framesTruncated, setFramesTruncated] = useState(false);
  const [selectedFrameId, setSelectedFrameId] = useState<number>();
  const [scopes, setScopes] = useState<ReadonlyArray<DebugScopeView>>([]);
  const [children, setChildren] = useState<DebugSessionView["children"]>(new Map());
  const [consoleLines, setConsoleLines] = useState<ReadonlyArray<DebugConsoleLine>>([]);
  const [notice, setNotice] = useState<string>();
  const [pending, setPending] = useState<string>();
  const [childProcesses, setChildProcesses] = useState<ReadonlyArray<CodeDebugChildSummary>>();
  const [undebuggedChildren, setUndebuggedChildren] = useState(0);
  const mounted = useRef(true);
  const ended = useRef(false);
  const afterOutput = useRef(0);
  const loadedRevision = useRef<number>(undefined);
  const lineId = useRef(0);
  /**
   * Moves when another process is selected. A read sent for the last one
   * that answers after the switch is dropped, so its stack, scopes, or
   * stopped line never overwrite the new process's.
   */
  const target = useRef(0);
  const callbacks = useRef({
    onStoppedAt: input.onStoppedAt,
    onEnded: input.onEnded,
    onChildGone: input.onChildGone,
  });
  callbacks.current = {
    onStoppedAt: input.onStoppedAt,
    onEnded: input.onEnded,
    onChildGone: input.onChildGone,
  };
  const runningPoll = input.pollMs?.running ?? RUNNING_POLL_MS;
  const stoppedPoll = input.pollMs?.stopped ?? STOPPED_POLL_MS;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const appendConsole = useCallback((items: ReadonlyArray<DebugConsoleItem>) => {
    if (items.length === 0) return;
    setConsoleLines((current) =>
      [...current, ...items.map((item) => ({ id: String((lineId.current += 1)), item }))].slice(
        -MAX_CONSOLE_LINES,
      ),
    );
  }, []);

  const end = useCallback((text: string) => {
    if (ended.current) return;
    ended.current = true;
    callbacks.current.onStoppedAt(undefined);
    callbacks.current.onEnded(text);
  }, []);

  // A child's end is not the session's: the view goes back to the program.
  const endTarget = useCallback(
    (text: string) => {
      if (child === undefined) end(text);
      else callbacks.current.onChildGone?.();
    },
    [child, end],
  );

  // Another process selected: what the last one's stop showed no longer holds.
  useEffect(() => {
    target.current += 1;
    loadedRevision.current = undefined;
    setState(undefined);
    setFrames([]);
    setScopes([]);
    setChildren(new Map());
    setSelectedFrameId(undefined);
    callbacks.current.onStoppedAt(undefined);
  }, [child]);

  /**
   * Sends one request. An answer that says the session is over ends it here
   * too; a refusal or an adapter that did not answer becomes the notice.
   */
  const ask = useCallback(
    async (
      request: CodeDebugSessionRequest,
      /** The caller says what went wrong itself, as the console does for an expression. */
      quiet = false,
    ): Promise<CodeDebugSessionResult | undefined> => {
      if (ended.current) return undefined;
      let answer: CodeDebugSessionResult;
      try {
        answer = await client.session({
          threadId,
          checkoutId,
          sessionId,
          ...(child === undefined ? {} : { child }),
          request,
        });
      } catch (error) {
        if (!mounted.current) return undefined;
        if (error instanceof CodeDebugClientFailure && error.kind === "local-only") {
          end(LOCAL_ONLY_TEXT);
        } else {
          setNotice(UNREACHABLE_TEXT);
        }
        return undefined;
      }
      if (!mounted.current) return undefined;
      // The host answered, so a notice that it could not be reached is stale.
      setNotice((current) => (current === UNREACHABLE_TEXT ? undefined : current));
      switch (answer.status) {
        case "ended":
          endTarget(endReasonText(answer.endReason));
          return answer;
        case "refused":
          if (answer.reason === "no-session") endTarget(refusalText(answer.reason));
          else setNotice(refusalText(answer.reason));
          return answer;
        case "unavailable":
          if (answer.reason === "ended" || quiet) {
            // The next state read says why it ended.
            return answer;
          }
          setNotice(
            answer.reason === "timed-out"
              ? "The debug adapter did not answer in time."
              : (answer.message ?? "The debug adapter could not do that."),
          );
          return answer;
        default:
          return answer;
      }
    },
    [checkoutId, child, client, end, endTarget, sessionId, threadId],
  );

  const loadVariables = useCallback(
    async (variablesReference: number) => {
      const answer = await ask({ kind: "variables", variablesReference });
      return answer?.status === "variables" ? answer : undefined;
    },
    [ask],
  );

  const loadFrame = useCallback(
    async (frameId: number) => {
      const at = target.current;
      setSelectedFrameId(frameId);
      setChildren(new Map());
      const answer = await ask({ kind: "scopes", frameId });
      if (at !== target.current) return;
      if (answer?.status !== "scopes") {
        setScopes([]);
        return;
      }
      const views: DebugScopeView[] = answer.scopes.map((scope) => ({ scope }));
      setScopes(views);
      // The first scope that is cheap to read opens on its own, as the
      // variables a stop is usually about.
      const first = answer.scopes.find((scope) => !scope.expensive && scope.variablesReference > 0);
      if (first === undefined) return;
      const variables = await loadVariables(first.variablesReference);
      if (variables === undefined || !mounted.current || at !== target.current) return;
      setScopes((current) =>
        current.map((view) =>
          view.scope.variablesReference === first.variablesReference
            ? { ...view, variables: variables.variables, truncated: variables.truncated }
            : view,
        ),
      );
    },
    [ask, loadVariables],
  );

  const loadStop = useCallback(
    async (programThreadId: number) => {
      const at = target.current;
      const answer = await ask({ kind: "stack-trace", programThreadId });
      // A Stop that landed while the stack was read has already cleared the
      // editor's stopped line; marking it again would outlive the session.
      if (
        answer?.status !== "stack" ||
        !mounted.current ||
        ended.current ||
        at !== target.current
      ) {
        return;
      }
      setFrames(answer.frames);
      setFramesTruncated(answer.truncated);
      const top = answer.frames[0];
      callbacks.current.onStoppedAt(top);
      if (top !== undefined) await loadFrame(top.id);
      else {
        setSelectedFrameId(undefined);
        setScopes([]);
      }
    },
    [ask, loadFrame],
  );

  // The poll: one state read at a time, quicker while the program runs.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const answer = await ask({ kind: "state", afterOutput: afterOutput.current });
      if (stopped || !mounted.current) return;
      let wait = runningPoll;
      if (answer?.status === "state") {
        setChildProcesses(answer.children);
        setUndebuggedChildren(answer.undebuggedChildren ?? 0);
        if (answer.state.status === "ended" && child !== undefined) {
          callbacks.current.onChildGone?.();
          return;
        }
        setState(answer.state);
        const lastOutput = answer.output.at(-1);
        if (lastOutput !== undefined) afterOutput.current = lastOutput.sequence;
        const dropped: ReadonlyArray<DebugConsoleItem> = answer.outputDropped
          ? [{ kind: "notice", text: "Some output was not kept and is not shown." }]
          : [];
        appendConsole([
          ...dropped,
          ...answer.output.map((entry): DebugConsoleItem => ({ kind: "output", entry })),
        ]);
        if (answer.state.status === "ended") {
          end(endReasonText(answer.state.endReason, answer.state.exitCode));
          return;
        }
        if (answer.state.status === "stopped") {
          wait = stoppedPoll;
          if (loadedRevision.current !== answer.revision) {
            loadedRevision.current = answer.revision;
            await loadStop(answer.state.programThreadId);
          }
        } else if (loadedRevision.current !== undefined) {
          // Running again: what the last stop showed no longer holds.
          loadedRevision.current = undefined;
          setFrames([]);
          setScopes([]);
          setChildren(new Map());
          setSelectedFrameId(undefined);
          callbacks.current.onStoppedAt(undefined);
        }
      }
      if (ended.current || stopped) return;
      timer = setTimeout(() => void poll(), wait);
    };
    void poll();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [appendConsole, ask, child, end, loadStop, runningPoll, stoppedPoll]);

  const act = useCallback(
    async (label: string, request: CodeDebugSessionRequest, quiet = false) => {
      setPending(label);
      setNotice(undefined);
      try {
        return await ask(request, quiet);
      } finally {
        if (mounted.current) setPending(undefined);
      }
    },
    [ask],
  );

  const controls: DebugSessionControls = {
    step: (kind) => {
      void (async () => {
        let programThreadId = state?.status === "stopped" ? state.programThreadId : undefined;
        if (programThreadId === undefined) {
          // Pausing a running program names one of its threads.
          const threads = await ask({ kind: "threads" });
          programThreadId = threads?.status === "threads" ? threads.threads[0]?.id : undefined;
        }
        if (programThreadId === undefined) {
          setNotice("The program has no thread to do that on.");
          return;
        }
        await act(kind, { kind, programThreadId });
      })();
    },
    stop: () => {
      void act("stop", { kind: "stop" });
    },
    selectFrame: (frameId) => {
      void loadFrame(frameId);
    },
    loadScope: (variablesReference) => {
      const at = target.current;
      void loadVariables(variablesReference).then((variables) => {
        if (variables === undefined || !mounted.current || at !== target.current) return;
        setScopes((current) =>
          current.map((view) =>
            view.scope.variablesReference === variablesReference
              ? { ...view, variables: variables.variables, truncated: variables.truncated }
              : view,
          ),
        );
      });
    },
    expand: (variablesReference) => {
      const at = target.current;
      void loadVariables(variablesReference).then((variables) => {
        if (variables === undefined || !mounted.current || at !== target.current) return;
        setChildren((current) =>
          new Map(current).set(variablesReference, {
            variables: variables.variables,
            truncated: variables.truncated,
          }),
        );
      });
    },
    evaluate: (expression) => {
      appendConsole([{ kind: "input", expression }]);
      void act(
        "evaluate",
        {
          kind: "evaluate",
          expression,
          context: "repl",
          ...(selectedFrameId === undefined ? {} : { frameId: selectedFrameId }),
        },
        true,
      ).then((answer) => {
        if (answer?.status === "evaluated") {
          appendConsole([{ kind: "result", result: answer.result }]);
        } else if (answer?.status === "unavailable" && answer.reason !== "ended") {
          appendConsole([
            {
              kind: "notice",
              text:
                answer.reason === "timed-out"
                  ? "The debug adapter did not answer in time."
                  : (answer.message ?? "The expression could not be evaluated."),
            },
          ]);
        }
      });
    },
    source: async (sourceReference) => {
      const answer = await ask({ kind: "source", sourceReference });
      return answer?.status === "source"
        ? answer.text + (answer.truncated ? "\n…" : "")
        : undefined;
    },
    ask,
  };

  return [
    {
      state,
      frames,
      framesTruncated,
      selectedFrameId,
      scopes,
      children,
      console: consoleLines,
      notice,
      pending,
      childProcesses,
      undebuggedChildren,
    },
    controls,
  ] as const;
}
