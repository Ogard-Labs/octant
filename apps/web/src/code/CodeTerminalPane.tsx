import type { CodeClient } from "@octant/client-runtime/code-client";
import type { CodeCheckoutId, CodeTerminalId, CodeThreadId } from "@octant/contracts/code";
import type { CodeOperationId, CodeOperationResult } from "@octant/contracts/code-operations";
import type { ProviderExecutionPolicy } from "@octant/contracts/providers";
import { useEffect, useRef, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { XtermTerminalAdapter, type XtermAdapterRuntime } from "./XtermTerminalAdapter";

type TerminalResult = Extract<CodeOperationResult, { readonly kind: "terminal-state" }>;

export interface CodeTerminalPaneProps {
  readonly client: Pick<CodeClient, "executeOperation" | "operationContent" | "subscribeOperation">;
  readonly createOperationId: () => CodeOperationId;
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly loadRuntime?: () => Promise<XtermAdapterRuntime>;
  readonly restart?: {
    readonly columns: number;
    readonly createTerminalId: () => CodeTerminalId;
    readonly credentialRefs: readonly string[];
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
  const operationQueue = useRef(Promise.resolve());
  const interactive = props.executionPolicy !== "plan" && result.state === "running";
  const replayReady = loadedReplayKey === replayKey;

  useEffect(() => setResult(props.result), [props.result]);

  useEffect(() => {
    let active = true;
    setOutput("");
    if (replayContentId === undefined) {
      setLoadedReplayKey(replayKey);
      return () => void (active = false);
    }
    setLoadedReplayKey(undefined);
    void props.client
      .operationContent(props.scope.threadId, result.operationId, replayContentId)
      .then((bytes) => {
        if (!active) return;
        setOutput(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        setLoadedReplayKey(replayKey);
      })
      .catch(() => {
        if (active) {
          setFailure("Terminal replay is unavailable. Restart from an explicit command.");
          setLoadedReplayKey(replayKey);
        }
      });
    return () => void (active = false);
  }, [props.client, props.scope.threadId, replayContentId, replayKey, result.operationId]);

  useEffect(() => {
    if (!replayReady || result.state !== "running") return;
    const controller = new AbortController();
    let cursor = 0;
    void (async () => {
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
              const bytes = await props.client.operationContent(
                props.scope.threadId,
                result.operationId,
                terminalOutput.content.contentId,
              );
              if (controller.signal.aborted) return;
              const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
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
          await waitForTerminalReplay(controller.signal, idleDelayMs);
          idleDelayMs = Math.min(idleDelayMs * 2, 2_000);
        } else if (received > 0) {
          idleDelayMs = 150;
        }
      }
    })();
    return () => controller.abort();
  }, [
    props.client,
    props.scope.threadId,
    replayReady,
    result.operationId,
    result.state,
    result.terminalId,
  ]);

  const execute = async (kind: "write" | "resize", value: string | readonly [number, number]) => {
    if (!interactive) return;
    try {
      const operationId = props.createOperationId();
      const base = {
        operationId,
        terminalId: result.terminalId,
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
      if (next.kind === "terminal-state" && kind === "write" && next.state !== "running") {
        setResult({ ...next, operationId: result.operationId });
      }
      if (next.kind === "operation-failed") setFailure(next.failure.message);
    } catch {
      setFailure("Terminal command failed. Reconnect and retry.");
    }
  };

  const enqueue = (kind: "write" | "resize", value: string | readonly [number, number]) => {
    operationQueue.current = operationQueue.current.then(
      () => execute(kind, value),
      () => execute(kind, value),
    );
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
      const next = await props.client.executeOperation(command);
      if (next.kind === "terminal-state") setResult(next);
      if (next.kind === "operation-failed") setFailure(next.failure.message);
    } catch {
      setFailure(`Terminal ${action} failed. Reconnect and retry.`);
    }
  };

  return (
    <section aria-label="Terminal pane" className="code-delivery-pane code-terminal-pane">
      <header className="code-delivery-pane__toolbar">
        <div>
          <span>Terminal</span>
          <h1>Repository terminal</h1>
        </div>
        <div className="code-delivery-pane__actions">
          <p>{terminalState(result)}</p>
          {props.executionPolicy !== "plan" && result.state === "running" ? (
            <OctantButton onClick={() => void control("stop")} type="button" variant="secondary">
              Stop terminal
            </OctantButton>
          ) : null}
          {props.executionPolicy !== "plan" &&
          result.state !== "running" &&
          props.restart !== undefined ? (
            <OctantButton onClick={() => void control("restart")} type="button" variant="secondary">
              Restart terminal
            </OctantButton>
          ) : null}
        </div>
      </header>
      {result.transcript?.truncated === true ? (
        <p className="code-delivery-pane__warning" role="alert">
          Terminal output is truncated. Earlier output is no longer available.
        </p>
      ) : null}
      {failure === undefined ? null : <p role="alert">{failure}</p>}
      {props.executionPolicy === "plan" ? (
        <p className="code-delivery-pane__notice">Plan mode keeps terminal replay read-only.</p>
      ) : null}
      {replayReady ? (
        <XtermTerminalAdapter
          ariaLabel="Repository terminal"
          interactive={interactive}
          {...(props.loadRuntime === undefined ? {} : { loadRuntime: props.loadRuntime })}
          onData={(data) => enqueue("write", data)}
          onResize={(columns, rows) => enqueue("resize", [columns, rows])}
          output={output}
        />
      ) : (
        <p role="status">Loading terminal replay…</p>
      )}
    </section>
  );
}

async function waitForTerminalReplay(signal: AbortSignal, delayMs: number): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      globalThis.clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timeout = globalThis.setTimeout(done, delayMs);
    signal.addEventListener("abort", done, { once: true });
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
