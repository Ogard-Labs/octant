import type { ProjectTerminalClient } from "@octant/client-runtime/project-terminal-client";
import type { CodeTerminalId } from "@octant/contracts/code";
import type { ProjectId } from "@octant/contracts/projects";
import type {
  ProjectTerminalCommand,
  ProjectTerminalResult,
  ProjectTerminalView,
} from "@octant/contracts/project-terminals";
import { MoreHorizontal } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { XtermTerminalAdapter, type XtermAdapterRuntime } from "../code/XtermTerminalAdapter";
import { OctantMenu } from "../ui/base/OctantMenu";

export interface ZenProjectTerminalCardProps {
  readonly client: ProjectTerminalClient;
  readonly projectId: ProjectId;
  readonly terminalId: CodeTerminalId;
  /**
   * Whether this card holds one of the space's live slots. Out of a slot it
   * stops reading the shell and catches up from where it left off on return.
   */
  readonly live: boolean;
  readonly loadRuntime?: () => Promise<XtermAdapterRuntime>;
}

/**
 * A pinned window onto a terminal a Code Project owns without a thread.
 *
 * It attaches to a shell this window already opened and never starts one.
 * Everything it sends names the Project and the shell, and the host decides
 * whether this window may still reach them; a refusal is shown as the host's
 * sentence, so a card whose Project was archived says so instead of going
 * quiet. It offers nothing that hands the shell's output to a thread.
 */
export function ZenProjectTerminalCard(props: ZenProjectTerminalCardProps) {
  const { client, projectId, terminalId, live } = props;
  const [terminal, setTerminal] = useState<ProjectTerminalView>();
  const [output, setOutput] = useState("");
  const [failure, setFailure] = useState<string>();
  // The shell's own exit code after a stop is the signal it was sent, not
  // something it chose; the person pressed Stop, so the card says so.
  const [stopped, setStopped] = useState(false);
  const cursor = useRef(0);
  const wakeReader = useRef<(() => void) | undefined>(undefined);
  const writes = useRef(Promise.resolve());
  const pending = useRef("");

  const send = useCallback(
    (command: ProjectTerminalCommand, signal?: AbortSignal): Promise<ProjectTerminalResult> =>
      client.execute(command, signal),
    [client],
  );

  useEffect(() => {
    if (!live) return;
    const controller = new AbortController();
    void (async () => {
      let idleDelayMs = 150;
      let first = true;
      while (!controller.signal.aborted) {
        let result: ProjectTerminalResult;
        try {
          result = first
            ? await send({ kind: "attach", projectId, terminalId }, controller.signal)
            : await send(
                { kind: "read-output", projectId, terminalId, afterCharacters: cursor.current },
                controller.signal,
              );
        } catch {
          if (controller.signal.aborted) return;
          setFailure("This terminal is unavailable. Reconnecting…");
          await wait(controller.signal, 2_000);
          continue;
        }
        if (controller.signal.aborted) return;
        if (result.kind === "project-terminal-refused") {
          setFailure(result.message);
          return;
        }
        const read = result.output;
        if (first) {
          setOutput(read?.text ?? "");
          first = false;
        } else if (read !== undefined && read.text.length > 0) {
          setOutput((current) => (read.replace ? read.text : `${current}${read.text}`));
        }
        if (read !== undefined) cursor.current = read.characters;
        setTerminal(result.terminal);
        setFailure(undefined);
        if (result.terminal.state !== "running") return;
        if (read !== undefined && read.text.length > 0) {
          idleDelayMs = 150;
          continue;
        }
        const wake = new AbortController();
        wakeReader.current = () => wake.abort();
        await wait(controller.signal, idleDelayMs, wake.signal);
        wakeReader.current = undefined;
        // A keystroke wakes the reader; the echo it expects must not wait
        // behind an idle back-off that had grown to two seconds.
        idleDelayMs = wake.signal.aborted ? 150 : Math.min(idleDelayMs * 2, 2_000);
      }
    })();
    return () => controller.abort();
  }, [live, projectId, send, terminalId]);

  const write = (data: string) => {
    if (data === "") return;
    pending.current += data;
    const flush = async () => {
      const buffered = pending.current;
      if (buffered === "") return;
      pending.current = "";
      try {
        const result = await send({ kind: "write", projectId, terminalId, data: buffered });
        if (result.kind === "project-terminal-refused") setFailure(result.message);
        wakeReader.current?.();
      } catch {
        setFailure("Terminal input failed. Reconnect and retry.");
      }
    };
    writes.current = writes.current.then(flush, flush);
  };

  const resize = (columns: number, rows: number) => {
    void send({ kind: "resize", projectId, terminalId, columns, rows }).catch(() => undefined);
  };

  const stop = async () => {
    try {
      const result = await send({ kind: "stop", projectId, terminalId });
      if (result.kind === "project-terminal-refused") setFailure(result.message);
      else {
        setStopped(true);
        setTerminal(result.terminal);
      }
    } catch {
      setFailure("The terminal could not be stopped. Reconnect and retry.");
    }
  };

  if (failure !== undefined && terminal === undefined) {
    return (
      <p className="zen-terminal-card__notice" role="status">
        {failure}
      </p>
    );
  }
  if (!live) {
    return (
      <p className="zen-terminal-card__notice" role="status">
        Paused while this card is out of view. It picks the shell back up when you return to it.
      </p>
    );
  }
  if (terminal === undefined) {
    return (
      <p className="zen-terminal-card__notice" role="status">
        Opening this terminal…
      </p>
    );
  }
  const running = terminal.state === "running" && failure === undefined;
  return (
    <section aria-label="Project terminal" className="code-delivery-pane code-terminal-pane">
      {failure === undefined ? null : <p role="alert">{failure}</p>}
      {terminal.state === "running" ? (
        <div className="code-terminal-pane__actions-menu">
          <OctantMenu
            items={[{ value: "stop", label: "Stop terminal" }]}
            onValueChange={(value) => {
              if (value === "stop") void stop();
            }}
            selectionMode="action"
            trigger={<MoreHorizontal aria-hidden="true" size={16} strokeWidth={1.7} />}
            triggerClassName="code-terminal-pane__actions-trigger"
            triggerLabel="More terminal actions"
            value="stop"
          />
        </div>
      ) : (
        <p className="code-delivery-pane__notice" role="status">
          {stopped
            ? "Stopped"
            : terminal.state === "exited"
              ? terminal.exitCode === undefined
                ? "Exited without a reported code"
                : `Exited with code ${terminal.exitCode}`
              : "Stopped"}
        </p>
      )}
      <XtermTerminalAdapter
        ariaLabel="Project terminal"
        interactive={running}
        {...(props.loadRuntime === undefined ? {} : { loadRuntime: props.loadRuntime })}
        onData={write}
        onResize={resize}
        output={output}
      />
    </section>
  );
}

async function wait(signal: AbortSignal, delayMs: number, wake?: AbortSignal): Promise<void> {
  if (signal.aborted || wake?.aborted === true) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      globalThis.clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      wake?.removeEventListener("abort", done);
      resolve();
    };
    const timeout = globalThis.setTimeout(done, delayMs);
    signal.addEventListener("abort", done, { once: true });
    wake?.addEventListener("abort", done, { once: true });
  });
}
