import type { ProjectTerminalClient } from "@octant/client-runtime/project-terminal-client";
import {
  decodeCodeTerminalId,
  type ProjectTerminalCommand,
  type ProjectTerminalResult,
} from "@octant/contracts";
import { useEffect, useRef, useState } from "react";
import { OctantDialog } from "../ui/base/OctantDialog";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantAlert } from "../ui/base/OctantAlert";

export type ProjectActionTarget = Omit<
  Extract<ProjectTerminalCommand, { kind: "preview-action" }>,
  "kind"
>;
type Preview = Extract<ProjectTerminalResult, { kind: "project-action-preview" }>;
type Run = Extract<ProjectTerminalResult, { kind: "project-terminal" }>;

export function ProjectActionRunDialog(props: {
  readonly client: ProjectTerminalClient;
  readonly target: ProjectActionTarget;
  readonly storageKey: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onOpenTerminal?: (id: ReturnType<typeof decodeCodeTerminalId>) => void;
}) {
  const [preview, setPreview] = useState<Preview>();
  const [run, setRun] = useState<Run>();
  const [terminalId, setTerminalId] = useState(() => {
    try {
      const value = sessionStorage.getItem(props.storageKey);
      return value === null ? undefined : decodeCodeTerminalId(value);
    } catch {
      return undefined;
    }
  });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const submitted = useRef(terminalId !== undefined);
  const cursor = useRef(0);
  const [output, setOutput] = useState("");
  useEffect(() => {
    if (!props.open || terminalId !== undefined) return;
    let current = true;
    setBusy(true);
    void props.client
      .execute({ kind: "preview-action", ...props.target })
      .then((result) => {
        if (!current) return;
        if (result.kind === "project-action-preview") {
          setPreview(result);
          setFailure(undefined);
        } else
          setFailure(
            result.kind === "project-terminal-refused"
              ? result.message
              : "This action is unavailable.",
          );
      })
      .catch(() => {
        if (current) setFailure("The action could not be checked. Close and review it again.");
      })
      .finally(() => {
        if (current) setBusy(false);
      });
    return () => {
      current = false;
    };
  }, [props.client, props.target, props.open, terminalId]);
  useEffect(() => {
    if (!props.open || terminalId === undefined) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const result = await props.client.execute(
          {
            kind: "read-output",
            projectId: props.target.projectId,
            terminalId,
            afterCharacters: cursor.current,
          },
          abort.signal,
        );
        if (abort.signal.aborted) return;
        if (result.kind !== "project-terminal") {
          setFailure(
            (current) =>
              current ??
              (result.kind === "project-terminal-refused"
                ? result.message
                : "Run status is unavailable. Nothing was retried."),
          );
          return;
        }
        setRun(result);
        setFailure(undefined);
        if (result.output !== undefined) {
          const delta = result.output;
          setOutput((current) => (delta.replace ? delta.text : `${current}${delta.text}`));
          cursor.current = delta.characters;
        }
        if (result.terminal.state === "running") timer = setTimeout(() => void read(), 1000);
      } catch {
        if (!abort.signal.aborted)
          setFailure(
            "Run status is unknown. Check the terminal before starting another run. Nothing was retried.",
          );
      }
    };
    void read();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [props.client, props.target.projectId, props.open, terminalId]);
  const start = async () => {
    if (preview === undefined || submitted.current) return;
    const id = decodeCodeTerminalId(crypto.randomUUID());
    try {
      sessionStorage.setItem(props.storageKey, id);
    } catch {
      setFailure("The run could not be retained in this window. Nothing started.");
      return;
    }
    submitted.current = true;
    setBusy(true);
    try {
      const result = await props.client.execute({
        kind: "start-action",
        ...props.target,
        thread: preview.action.thread,
        projectVersion: preview.projectVersion,
        terminalId: id,
        columns: 100,
        rows: 30,
      });
      setTerminalId(id);
      if (result.kind === "project-terminal") {
        setRun(result);
        setFailure(undefined);
      } else
        setFailure(
          result.kind === "project-terminal-refused"
            ? result.message
            : "The run outcome is unknown. Nothing was retried.",
        );
    } catch {
      setTerminalId(id);
      setFailure(
        "The action may or may not have started. Nothing was retried; check its terminal.",
      );
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    if (terminalId === undefined) return;
    setBusy(true);
    try {
      const result = await props.client.execute({
        kind: "stop",
        projectId: props.target.projectId,
        terminalId,
      });
      if (result.kind === "project-terminal") setRun(result);
      else setFailure("Stopping the action was not confirmed. Check its terminal.");
    } catch {
      setFailure("Stopping the action was not confirmed. Check its terminal.");
    } finally {
      setBusy(false);
    }
  };
  const action = run?.terminal.action ?? preview?.action;
  return (
    <OctantDialog
      className="project-dialog project-action-run"
      label="Project action"
      open={props.open}
      onClose={props.onClose}
    >
      <h1>{action?.name ?? "Project action"}</h1>
      {busy ? <p role="status">Checking action…</p> : null}
      {action === undefined ? null : (
        <>
          <p>
            Folder: <code>{action.folder}</code>
          </p>
          <p>Branch: {action.branch ?? "Project folder"}</p>
        </>
      )}
      {failure === undefined ? null : <OctantAlert tone="danger">{failure}</OctantAlert>}
      {run === undefined ? null : (
        <>
          <p role="status">
            {run.terminal.state === "running"
              ? "Running"
              : run.terminal.state === "interrupted"
                ? "Interrupted"
                : `Exited${run.terminal.exitCode === undefined ? "" : ` with code ${run.terminal.exitCode}`}`}
          </p>
          <pre className="project-action-run__output">{output || "No output yet"}</pre>
        </>
      )}
      <div className="project-dialog__actions">
        <OctantButton onClick={props.onClose} type="button">
          Close
        </OctantButton>
        {terminalId === undefined ? (
          <OctantButton
            disabled={busy || preview === undefined || submitted.current}
            onClick={() => void start()}
            type="button"
          >
            Run action
          </OctantButton>
        ) : (
          <>
            {props.onOpenTerminal === undefined ? null : (
              <OctantButton onClick={() => props.onOpenTerminal?.(terminalId)} type="button">
                Open terminal
              </OctantButton>
            )}
            <OctantButton
              disabled={busy || run?.terminal.state !== "running"}
              onClick={() => void stop()}
              type="button"
            >
              Stop action
            </OctantButton>
            {run?.terminal.state === "exited" ||
            run?.terminal.state === "interrupted" ||
            failure !== undefined ? (
              <OctantButton
                onClick={() => {
                  sessionStorage.removeItem(props.storageKey);
                  submitted.current = false;
                  cursor.current = 0;
                  setRun(undefined);
                  setOutput("");
                  setTerminalId(undefined);
                }}
                type="button"
              >
                Prepare another run
              </OctantButton>
            ) : null}
          </>
        )}
      </div>
    </OctantDialog>
  );
}
