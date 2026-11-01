import type { CodeClient } from "@octant/client-runtime/code-client";
import { CodeClientFailure } from "@octant/client-runtime/code-client";
import type { CodeCheckoutId, CodeTerminalId, CodeThreadId } from "@octant/contracts/code";
import type { CodeOperationId, CodeOperationResult } from "@octant/contracts/code-operations";
import type { ProviderExecutionPolicy } from "@octant/contracts/providers";
import type {
  TerminalBrowserGrantOutcome,
  TerminalBrowserGrantRefusalReason,
} from "@octant/contracts/terminal-browser-grants";
import { MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { OctantContextMenu } from "../ui/base/OctantContextMenu";
import { OctantMenu } from "../ui/base/OctantMenu";
import { XtermTerminalAdapter, type XtermAdapterRuntime } from "./XtermTerminalAdapter";
import { ShellState } from "../shell/ShellState";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { waitForReconnect } from "../lib/waitForReconnect";

type TerminalResult = Extract<CodeOperationResult, { readonly kind: "terminal-state" }>;

export interface CodeTerminalPaneProps {
  /**
   * `watchTerminal` is the live path. A client without it reads the journal,
   * which is also what a host that refuses or lacks the stream falls back to.
   */
  readonly client: Pick<
    CodeClient,
    "executeOperation" | "operationContent" | "subscribeOperation" | "watchTerminal"
  >;
  readonly createOperationId: () => CodeOperationId;
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly loadRuntime?: () => Promise<XtermAdapterRuntime>;
  /**
   * Puts the text selected in this terminal into the thread's composer. Absent
   * when no composer is reachable, which hides the affordance rather than
   * offering a button that would drop what the user selected.
   */
  readonly onAddSelectionToChat?: (selection: string) => void;
  /**
   * Offers to restart this Code thread terminal with its Browser grant on.
   * Only a thread terminal this window can restart offers it; the host still
   * decides, and refuses anyone but the person at a local window.
   */
  readonly offerBrowserGrant?: boolean;
  /** Opens a second terminal for this thread. Absent when tabs cannot open. */
  readonly onOpenAnotherTerminal?: () => void;
  /**
   * Pins this terminal to the focus zone. Absent on a card that is already a
   * pinned window onto the shell, which has nothing to pin.
   */
  readonly onPinTerminal?: () => void;
  readonly restart?: {
    readonly columns: number;
    readonly createTerminalId: () => CodeTerminalId;
    readonly credentialRefs: readonly string[];
    /**
     * The Project's extra folders, by absolute path. Each is offered as a
     * place to restart this terminal; the host accepts only a folder the
     * Project still lists.
     */
    readonly folders?: ReadonlyArray<string>;
    readonly rows: number;
  };
  readonly result: TerminalResult;
  readonly scope: { readonly checkoutId: CodeCheckoutId; readonly threadId: CodeThreadId };
}

export function CodeTerminalPane(props: CodeTerminalPaneProps) {
  const [result, setResult] = useState(props.result);
  const [output, setOutput] = useState("");
  const replayKey = terminalReplayKey(result);
  const replayContentId = result.transcript?.contentId;
  const [loadedReplayKey, setLoadedReplayKey] = useState<string | undefined>(() =>
    props.result.transcript === undefined ? terminalReplayKey(props.result) : undefined,
  );
  const [failure, setFailure] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [confirmingBrowser, setConfirmingBrowser] = useState(false);
  const [browserPending, setBrowserPending] = useState(false);
  const [browserRefusal, setBrowserRefusal] = useState<string>();
  const readSelection = useRef<(() => string) | undefined>(undefined);
  const operationQueue = useRef(Promise.resolve());
  const pendingWrite = useRef<{ terminalId: CodeTerminalId; data: string } | undefined>(undefined);
  const queuedWrites = useRef(0);
  const coalesceScheduled = useRef(false);
  const wakeReplay = useRef<(() => void) | undefined>(undefined);
  /** The transcript the journal handed this pane, which the journal path resumes from. */
  const replayText = useRef("");
  /**
   * Where that transcript ends in the terminal's own offsets, so the live stream
   * continues it instead of replacing it. Unknown once the host truncated it:
   * the offset of its first character is then not the pane's to know.
   */
  const replayOffset = useRef<number | undefined>(0);
  const replayTruncated = result.transcript?.truncated === true;
  const interactive = props.executionPolicy !== "plan" && result.state === "running";
  const replayReady = loadedReplayKey === replayKey;
  // Read from the host's last answer about this shell, never from having asked:
  // an attach reports a live grant, and a shell that stopped took its grant
  // with it.
  const browserOn = result.state === "running" && result.browserGrant?.status === "granted";
  const canOfferBrowser =
    props.offerBrowserGrant === true &&
    props.restart !== undefined &&
    props.executionPolicy !== "plan" &&
    !browserOn;

  useEffect(() => setResult(props.result), [props.result]);

  useEffect(() => {
    let active = true;
    setOutput("");
    replayText.current = "";
    replayOffset.current = replayTruncated ? undefined : 0;
    if (replayContentId === undefined) {
      setLoadedReplayKey(replayKey);
      return () => void (active = false);
    }
    setLoadedReplayKey(undefined);
    void props.client
      .operationContent(props.scope.threadId, result.operationId, replayContentId)
      .then((bytes) => {
        if (!active) return;
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        replayText.current = text;
        replayOffset.current = replayTruncated ? undefined : text.length;
        setOutput(text);
        setLoadedReplayKey(replayKey);
      })
      .catch(() => {
        if (active) {
          setFailure("Terminal replay is unavailable. Restart from an explicit command.");
          setLoadedReplayKey(replayKey);
        }
      });
    return () => void (active = false);
  }, [
    props.client,
    props.scope.threadId,
    replayContentId,
    replayKey,
    replayTruncated,
    result.operationId,
  ]);

  useEffect(() => {
    if (!replayReady || result.state !== "running") return;
    const controller = new AbortController();
    let cursor = 0;
    const watchTerminal = props.client.watchTerminal?.bind(props.client);
    /**
     * Output as the shell prints it, from the host's live stream. It resumes a
     * dropped stream from the offset of the last frame, so nothing is skipped
     * or shown twice. Returns "settled" when the shell ended and "unavailable"
     * when the host will not stream, which sends the pane to the journal.
     */
    const followLive = async (
      watch: NonNullable<typeof watchTerminal>,
    ): Promise<"settled" | "unavailable"> => {
      let offset = replayOffset.current;
      let reconnecting = false;
      let barren = 0;
      while (!controller.signal.aborted) {
        let received = 0;
        try {
          for await (const frame of watch(
            {
              threadId: props.scope.threadId,
              checkoutId: props.scope.checkoutId,
              terminalId: result.terminalId,
              operationId: result.operationId,
              ...(offset === undefined ? {} : { afterCharacters: offset }),
            },
            controller.signal,
          )) {
            received += 1;
            offset = frame.characters;
            setOutput((current) => (frame.replace ? frame.text : `${current}${frame.text}`));
            if (reconnecting) {
              reconnecting = false;
              setFailure(undefined);
            }
            if (frame.state !== "running") {
              setResult((current) =>
                frame.state === "exited"
                  ? { ...current, state: "exited", exitCode: frame.exitCode ?? null }
                  : { ...current, state: frame.state },
              );
              return "settled";
            }
          }
        } catch (error) {
          if (controller.signal.aborted) return "settled";
          // A refusal asked again is the same refusal; the journal still holds
          // the output, so that is where the pane goes.
          if (
            received === 0 &&
            error instanceof CodeClientFailure &&
            error.category !== "disconnected"
          ) {
            return "unavailable";
          }
        }
        barren = received === 0 ? barren + 1 : 0;
        if (barren >= 3) return "unavailable";
        if (!controller.signal.aborted && received === 0) {
          reconnecting = true;
          setFailure("Live terminal output is temporarily unavailable. Reconnecting…");
        }
        await waitForReconnect(controller.signal, received === 0 ? 500 * barren : 50);
      }
      return "settled";
    };
    void (async () => {
      if (watchTerminal !== undefined) {
        if ((await followLive(watchTerminal)) === "settled") return;
        if (controller.signal.aborted) return;
        // Whatever the stream delivered is rebuilt from the journal's own
        // record, so the two paths never both contribute the same bytes.
        setOutput(replayText.current);
        setFailure(undefined);
      }
      let idleDelayMs = 150;
      while (!controller.signal.aborted) {
        let received = 0;
        try {
          for await (const frame of props.client.subscribeOperation(
            props.scope.threadId,
            result.operationId,
            cursor,
            controller.signal,
          )) {
            if (
              frame.event.kind === "terminal-output" &&
              frame.event.terminalId === result.terminalId
            ) {
              const terminalOutput = frame.event;
              let text = frame.displayText;
              if (text === undefined) {
                const bytes = await props.client.operationContent(
                  props.scope.threadId,
                  result.operationId,
                  terminalOutput.content.contentId,
                );
                if (controller.signal.aborted) return;
                text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
              }
              setOutput((current) => (terminalOutput.replace ? text : `${current}${text}`));
              setFailure(undefined);
            }
            if (
              frame.event.kind === "terminal-state-changed" &&
              frame.event.terminalId === result.terminalId
            ) {
              const terminalEvent = frame.event;
              setResult((current) =>
                terminalEvent.state === "exited"
                  ? {
                      ...current,
                      state: "exited",
                      exitCode: terminalEvent.exitCode ?? null,
                    }
                  : { ...current, state: terminalEvent.state },
              );
              if (terminalEvent.state !== "running") controller.abort();
            }
            cursor = Number(frame.cursor);
            received += 1;
          }
        } catch {
          if (!controller.signal.aborted) {
            setFailure("Live terminal output is temporarily unavailable. Reconnecting…");
          }
        }
        if (!controller.signal.aborted && received === 0) {
          const wake = new AbortController();
          wakeReplay.current = () => wake.abort();
          await waitForTerminalReplay(controller.signal, idleDelayMs, wake.signal);
          wakeReplay.current = undefined;
          // Keystrokes wake the wait; the echo they expect must not sit
          // behind an idle back-off that had grown to two seconds.
          idleDelayMs = wake.signal.aborted ? 150 : Math.min(idleDelayMs * 2, 2_000);
        } else if (received > 0) {
          idleDelayMs = 150;
        }
      }
    })();
    return () => controller.abort();
  }, [
    props.client,
    props.scope.checkoutId,
    props.scope.threadId,
    replayReady,
    result.operationId,
    result.state,
    result.terminalId,
  ]);

  const execute = async (
    terminalId: CodeTerminalId,
    kind: "write" | "resize",
    value: string | readonly [number, number],
  ) => {
    if (!interactive) return;
    try {
      const operationId = props.createOperationId();
      const base = {
        operationId,
        terminalId,
        ...props.scope,
      } as const;
      const command =
        kind === "write"
          ? ({ kind: "write-terminal", ...base, data: value as string } as const)
          : ({
              kind: "resize-terminal",
              ...base,
              columns: (value as readonly [number, number])[0],
              rows: (value as readonly [number, number])[1],
            } as const);
      const next = await props.client.executeOperation(command);
      if (kind === "write") wakeReplay.current?.();
      if (next.kind === "terminal-state" && kind === "write" && next.state !== "running") {
        setResult({ ...next, operationId: result.operationId });
      }
      if (next.kind === "operation-failed") setFailure(next.failure.message);
    } catch (error) {
      // A dropped keystroke is otherwise invisible except as missing
      // characters (observed `HEAD` -> `HED` on the Linux ADE host), and the
      // transport category tells whether it was disconnected vs unauthorized.
      setFailure(
        error instanceof CodeClientFailure
          ? `Terminal input was not delivered: ${error.message}${kind === "write" ? " Retype the last keystroke." : ""}`
          : "Terminal command failed. Reconnect and retry.",
      );
    }
  };

  const enqueueOperation = (
    terminalId: CodeTerminalId,
    kind: "write" | "resize",
    value: string | readonly [number, number],
  ) => {
    if (kind === "write") queuedWrites.current += 1;
    const run = async () => {
      try {
        await execute(terminalId, kind, value);
      } finally {
        if (kind === "write") {
          queuedWrites.current -= 1;
          const buffered = pendingWrite.current;
          if (queuedWrites.current === 0 && buffered !== undefined && buffered.data !== "") {
            pendingWrite.current = undefined;
            enqueueOperation(buffered.terminalId, "write", buffered.data);
          }
        }
      }
    };
    operationQueue.current = operationQueue.current.then(run, run);
  };

  const flushPendingWrite = () => {
    const buffered = pendingWrite.current;
    if (buffered === undefined || buffered.data === "") return;
    pendingWrite.current = undefined;
    enqueueOperation(buffered.terminalId, "write", buffered.data);
  };

  const scheduleCoalesceFlush = () => {
    if (coalesceScheduled.current || queuedWrites.current > 0) return;
    coalesceScheduled.current = true;
    queueMicrotask(() => {
      coalesceScheduled.current = false;
      if (queuedWrites.current > 0) return;
      flushPendingWrite();
    });
  };

  const enqueueWrite = (data: string) => {
    if (data === "") return;
    const terminalId = props.result.terminalId;
    if (isCoalescableTerminalWrite(data)) {
      const buffered = pendingWrite.current;
      if (buffered !== undefined && String(buffered.terminalId) !== String(terminalId)) {
        flushPendingWrite();
      }
      pendingWrite.current = {
        terminalId,
        data:
          buffered !== undefined && String(buffered.terminalId) === String(terminalId)
            ? buffered.data + data
            : data,
      };
      scheduleCoalesceFlush();
      return;
    }
    flushPendingWrite();
    enqueueOperation(terminalId, "write", data);
  };

  const enqueueResize = (columns: number, rows: number) => {
    flushPendingWrite();
    enqueueOperation(props.result.terminalId, "resize", [columns, rows]);
  };

  const control = async (action: "restart" | "stop") => {
    if (props.executionPolicy === "plan" || (action === "restart" && props.restart === undefined))
      return;
    try {
      const operationId = props.createOperationId();
      const command =
        action === "stop"
          ? ({
              kind: "stop-terminal",
              operationId,
              terminalId: result.terminalId,
              ...props.scope,
            } as const)
          : ({
              kind: "start-terminal",
              operationId,
              terminalId: props.restart!.createTerminalId(),
              columns: props.restart!.columns,
              rows: props.restart!.rows,
              credentialRefs: props.restart!.credentialRefs,
              ...props.scope,
            } as const);
      // The person at the window restarting their own terminal is the
      // approval; the host authorizes it as a user-initiated operation.
      setFailure(undefined);
      setBrowserRefusal(undefined);
      const next = await props.client.executeOperation(command);
      if (next.kind === "terminal-state") setResult(next);
      if (next.kind === "operation-failed") setFailure(next.failure.message);
    } catch {
      setFailure(`Terminal ${action} failed. Reconnect and retry.`);
    }
  };

  const restartInFolder = async (folder: string) => {
    const restart = props.restart;
    if (restart === undefined || props.executionPolicy === "plan") return;
    setFailure(undefined);
    setNotice(undefined);
    try {
      // A running shell cannot change its starting folder, so the pick comes
      // with a fresh shell; the person chose the folder to get it.
      if (result.state === "running") {
        const stopped = await props.client.executeOperation({
          kind: "stop-terminal",
          operationId: props.createOperationId(),
          terminalId: result.terminalId,
          ...props.scope,
        });
        if (stopped.kind === "operation-failed") {
          setFailure(stopped.failure.message);
          return;
        }
      }
      const next = await props.client.executeOperation({
        kind: "start-terminal",
        operationId: props.createOperationId(),
        terminalId: restart.createTerminalId(),
        columns: restart.columns,
        rows: restart.rows,
        credentialRefs: restart.credentialRefs,
        folder,
        ...props.scope,
      });
      if (next.kind === "terminal-state") setResult(next);
      else if (next.kind === "operation-failed") setFailure(next.failure.message);
    } catch {
      setFailure("Octant could not restart the terminal in that folder. Reconnect and retry.");
    }
  };

  const switchBrowserOn = async () => {
    const restart = props.restart;
    if (restart === undefined || props.executionPolicy === "plan") return;
    setBrowserPending(true);
    setBrowserRefusal(undefined);
    setFailure(undefined);
    setNotice(undefined);
    try {
      // A running shell cannot be handed the grant's variables, so the grant
      // comes with a fresh shell. The person agreed to the restart first.
      if (result.state === "running") {
        const stopped = await props.client.executeOperation({
          kind: "stop-terminal",
          operationId: props.createOperationId(),
          terminalId: result.terminalId,
          ...props.scope,
        });
        if (stopped.kind === "operation-failed") {
          setFailure(stopped.failure.message);
          return;
        }
      }
      const next = await props.client.executeOperation({
        kind: "start-terminal",
        operationId: props.createOperationId(),
        terminalId: restart.createTerminalId(),
        columns: restart.columns,
        rows: restart.rows,
        credentialRefs: restart.credentialRefs,
        browserGrant: "on",
        ...props.scope,
      });
      if (next.kind === "terminal-state") {
        setResult(next);
        const refusal = browserGrantRefusal(next.browserGrant);
        if (refusal !== undefined) setBrowserRefusal(refusal);
      } else if (next.kind === "operation-failed") {
        setFailure(next.failure.message);
      }
    } catch {
      setFailure("Octant could not restart the terminal with the Browser. Reconnect and retry.");
    } finally {
      setBrowserPending(false);
      setConfirmingBrowser(false);
    }
  };

  const switchBrowserOff = async () => {
    setBrowserPending(true);
    setBrowserRefusal(undefined);
    setFailure(undefined);
    try {
      const next = await props.client.executeOperation({
        kind: "revoke-terminal-browser-grant",
        operationId: props.createOperationId(),
        terminalId: result.terminalId,
        ...props.scope,
      });
      if (next.kind === "operation-failed") {
        setFailure(next.failure.message);
        return;
      }
      if (next.kind !== "terminal-state") return;
      const grant = next.browserGrant;
      if (grant?.status === "refused" && grant.reason !== "no-live-grant") {
        setBrowserRefusal(REFUSALS[grant.reason]);
        return;
      }
      // Only the grant changes: the shell keeps running, and its output stays
      // on the operation that started it.
      setResult(withoutBrowserGrant);
      setNotice(
        "Browser off for this terminal. A CLI that used it stops at its next Browser call; to use it again, switch it back on and start the CLI again.",
      );
    } catch {
      setFailure("Octant could not switch the Browser off. Reconnect and retry.");
    } finally {
      setBrowserPending(false);
    }
  };

  const addSelectionToChat = () => {
    const selected = readSelection.current?.() ?? "";
    if (selected.trim() === "") {
      setNotice("Select terminal output first, then add it to the chat.");
      return;
    }
    setNotice(undefined);
    props.onAddSelectionToChat?.(selected);
  };

  const actions = [
    ...(props.onAddSelectionToChat === undefined
      ? []
      : [{ value: "add-selection", label: "Add selection to chat" }]),
    ...(props.onPinTerminal === undefined ? [] : [{ value: "pin", label: "Pin to focus zone" }]),
    ...(props.onOpenAnotherTerminal === undefined ? [] : [{ value: "new", label: "New terminal" }]),
    ...(canOfferBrowser
      ? [{ value: "browser-on", label: "Let this terminal use the Browser…" }]
      : []),
    ...(browserOn ? [{ value: "browser-off", label: "Switch the Browser off" }] : []),
    ...(props.executionPolicy === "plan"
      ? []
      : result.state === "running"
        ? [{ value: "stop", label: "Stop terminal" }]
        : props.restart === undefined
          ? []
          : [{ value: "restart", label: "Restart terminal" }]),
    ...(props.executionPolicy === "plan"
      ? []
      : (props.restart?.folders ?? []).map((folder) => ({
          value: `folder:${folder}`,
          label: `Restart in ${folder.slice(folder.lastIndexOf("/") + 1)}`,
        }))),
  ];
  const selectAction = (value: string) => {
    if (value === "add-selection") addSelectionToChat();
    else if (value === "pin") props.onPinTerminal?.();
    else if (value === "new") props.onOpenAnotherTerminal?.();
    else if (value === "browser-on") setConfirmingBrowser(true);
    else if (value === "browser-off") void switchBrowserOff();
    else if (value === "stop" || value === "restart") void control(value);
    else if (value.startsWith("folder:")) void restartInFolder(value.slice("folder:".length));
  };

  const pane = (
    <section aria-label="Terminal pane" className="code-delivery-pane code-terminal-pane">
      {actions.length === 0 ? null : (
        <div className="code-terminal-pane__actions-menu">
          <OctantMenu
            items={actions}
            onValueChange={selectAction}
            selectionMode="action"
            trigger={<MoreHorizontal aria-hidden="true" size={16} strokeWidth={1.7} />}
            triggerClassName="code-terminal-pane__actions-trigger"
            triggerLabel="More terminal actions"
            value={actions[0]?.value ?? ""}
          />
        </div>
      )}
      {result.state === "running" ? (
        <span className="sr-only" role="status">
          {terminalState(result)}
        </span>
      ) : (
        <p className="code-delivery-pane__notice" role="status">
          {terminalState(result)}
        </p>
      )}
      {result.transcript?.truncated === true ? (
        <OctantAlert className="code-delivery-pane__warning" tone="warning">
          Terminal output is truncated. Earlier output is no longer available.
        </OctantAlert>
      ) : null}
      {browserOn ? (
        <OctantAlert
          action={
            <OctantButton
              disabled={browserPending}
              onClick={() => void switchBrowserOff()}
              size="sm"
              type="button"
              variant="outline"
            >
              Switch off
            </OctantButton>
          }
          className="code-terminal-pane__browser"
          title="Browser on"
        >
          A CLI started here with octant mcp can use this thread's Browser. If this window changes
          Project, start the CLI again.
        </OctantAlert>
      ) : null}
      {browserRefusal === undefined ? null : (
        <OctantAlert className="code-terminal-pane__browser" tone="warning">
          {browserRefusal}
        </OctantAlert>
      )}
      {failure === undefined ? null : <OctantAlert tone="warning">{failure}</OctantAlert>}
      {notice === undefined ? null : <p role="status">{notice}</p>}
      {props.executionPolicy === "plan" ? (
        <p className="code-delivery-pane__notice">Plan mode keeps terminal replay read-only.</p>
      ) : null}
      {replayReady ? (
        <XtermTerminalAdapter
          ariaLabel="Repository terminal"
          interactive={interactive}
          {...(props.loadRuntime === undefined ? {} : { loadRuntime: props.loadRuntime })}
          onData={(data) => enqueueWrite(data)}
          onResize={(columns, rows) => enqueueResize(columns, rows)}
          onSelectionReader={(read) => {
            readSelection.current = read;
          }}
          output={output}
        />
      ) : (
        <ShellState state="loading" title="Loading terminal" />
      )}
    </section>
  );
  return (
    <>
      <OctantContextMenu
        items={actions}
        onValueChange={selectAction}
        triggerClassName="code-terminal-pane__context-menu"
      >
        {pane}
      </OctantContextMenu>
      {confirmingBrowser ? (
        <OctantConfirmDialog
          confirmLabel="Restart with the Browser"
          details={
            <p>
              The CLI reaches it through the octant mcp command. The Octant app for macOS adds
              octant to this terminal's PATH; with a headless install, use the install's own.
            </p>
          }
          onCancel={() => setConfirmingBrowser(false)}
          onConfirm={() => void switchBrowserOn()}
          pending={browserPending}
          title="Let this terminal use the Browser?"
        >
          The terminal restarts, so anything running in it stops. A CLI you then start in it can use
          this thread's Browser, and the first visit to each new site asks you in the thread.
        </OctantConfirmDialog>
      ) : null}
    </>
  );
}

function withoutBrowserGrant(result: TerminalResult): TerminalResult {
  const { browserGrant: _ended, ...rest } = result;
  return rest;
}

/** What the person reads when the host would not let this terminal use the Browser. */
function browserGrantRefusal(grant: TerminalBrowserGrantOutcome | undefined): string | undefined {
  if (grant === undefined || grant.status === "granted") return undefined;
  if (grant.status === "revoked") {
    return grant.reason === "terminal-not-started"
      ? "The terminal stopped before it could use the Browser. Restart it from its menu."
      : undefined;
  }
  return `${REFUSALS[grant.reason]} Restart the terminal from its menu to go on without it.`;
}

const REFUSALS: Readonly<Record<TerminalBrowserGrantRefusalReason, string>> = {
  "not-local-window": "Only the person at a window on the host can let a terminal use the Browser.",
  "not-a-code-thread": "Only a Code thread's terminal can use the Browser.",
  "thread-not-active":
    "This thread is archived or put away, so its terminal cannot use the Browser.",
  "window-cannot-open-thread": "This window cannot open this thread's Project.",
  "browser-unavailable": "This thread has no Browser to lend.",
  "terminal-already-granted": "This terminal can already use the Browser.",
  "no-live-grant": "This terminal was not using the Browser.",
  "grant-unavailable": "Octant could not set up the Browser for this terminal.",
};

async function waitForTerminalReplay(
  signal: AbortSignal,
  delayMs: number,
  wake: AbortSignal,
): Promise<void> {
  if (signal.aborted || wake.aborted) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      globalThis.clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      wake.removeEventListener("abort", done);
      resolve();
    };
    const timeout = globalThis.setTimeout(done, delayMs);
    signal.addEventListener("abort", done, { once: true });
    wake.addEventListener("abort", done, { once: true });
  });
}

function terminalState(result: TerminalResult): string {
  switch (result.state) {
    case "running":
      return "Running";
    case "exited":
      return result.exitCode === null
        ? "Exited without a reported code"
        : `Exited with code ${result.exitCode}`;
    case "interrupted":
      return "Interrupted · explicit restart required";
    case "unavailable":
      return "Unavailable";
    case "failed":
      return "Failed";
  }
}

function terminalReplayKey(result: TerminalResult): string {
  return `${result.operationId}:${result.terminalId}:${result.transcript?.contentId ?? "empty"}`;
}

function isCoalescableTerminalWrite(data: string): boolean {
  // A paste, IME commit, or escape sequence arrives as one onData payload.
  // Only single printable keystrokes may share a write with their neighbors.
  if (data.length !== 1) return false;
  const code = data.charCodeAt(0);
  return code >= 0x20 && code !== 0x7f && (code < 0x80 || code > 0x9f);
}
