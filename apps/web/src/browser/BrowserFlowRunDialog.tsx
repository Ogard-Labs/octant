import type { BrowserAutomationClient } from "@octant/client-runtime/browser-automation-client";
import type {
  BrowserFlowSummary,
  BrowserFlowTask,
  BrowserFlowRun,
  BrowserFlowsCommand,
  BrowserFlowsResult,
  BrowserFlowStep,
} from "@octant/contracts/browser-flows";
import { useEffect, useId, useRef, useState } from "react";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { OctantField, OctantFieldLabel } from "../ui/base/OctantField";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";

export function BrowserFlowRunDialog(props: {
  readonly client: Pick<BrowserAutomationClient, "manageFlows">;
  readonly flow: BrowserFlowSummary;
  readonly onClose: () => void;
}) {
  const { client, flow } = props;
  const manage = client.manageFlows;
  const fieldPrefix = useId();
  const [tasks, setTasks] = useState<ReadonlyArray<BrowserFlowTask>>([]);
  const [taskId, setTaskId] = useState("");
  const [run, setRun] = useState<BrowserFlowRun>();
  const [values, setValues] = useState<Readonly<Record<number, string>>>({});
  const [titles, setTitles] = useState<Readonly<Record<number, string>>>({});
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState("Loading available tasks…");
  const current = useRef<BrowserFlowRun | undefined>(undefined);
  const lifetime = useRef<AbortController | undefined>(undefined);
  current.current = run;

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    current.current = undefined;
    setRun(undefined);
    setValues({});
    setTitles({});
    setTaskId("");
    setTasks([]);
    setUncertain(false);
    setPending(false);
    setMessage("Loading available tasks…");
    void manage
      ?.call(client, { kind: "run-tasks", projectId: flow.projectId }, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.kind === "browser-flow-tasks") {
          setTasks(result.tasks);
          setMessage(
            result.tasks.length === 0
              ? "Open this Project and choose an active, idle Work or Code task first."
              : "Choose the existing task whose Browser and permissions this run will use.",
          );
        } else
          setMessage(
            result.kind === "browser-flows-refused" ? result.message : "Tasks are unavailable.",
          );
      })
      .catch(() => {
        if (!controller.signal.aborted) setMessage("Tasks are unavailable.");
      });
    return () => {
      controller.abort();
      const latest = current.current;
      if (latest !== undefined && ["review", "running", "paused"].includes(latest.state))
        void manage?.call(client, { kind: "cancel-run", runId: latest.id }).catch(() => undefined);
    };
  }, [client, manage, flow.projectId]);

  useEffect(() => {
    if (
      run === undefined ||
      (run.state !== "running" && run.state !== "paused") ||
      manage === undefined
    )
      return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const result = await manage.call(
          client,
          { kind: "inspect-run", runId: run.id },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (result.kind === "browser-flow-run") {
          setRun(result.run);
          setMessage(result.run.message ?? "");
        } else if (result.kind === "browser-flows-refused") setMessage(result.message);
      } catch {
        if (!controller.signal.aborted)
          setMessage(
            "Connection lost. Check this run before starting another; an uncertain step is never retried.",
          );
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 750);
    };
    timer = setTimeout(() => void poll(), 750);
    return () => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [client, manage, run?.id, run?.state]);

  const task = tasks.find((candidate) => `${candidate.mode}:${candidate.threadId}` === taskId);
  async function request(command: BrowserFlowsCommand): Promise<BrowserFlowsResult | undefined> {
    if (manage === undefined) return undefined;
    const operationLifetime = lifetime.current;
    setPending(true);
    try {
      const result = await manage.call(client, command);
      if (operationLifetime?.signal.aborted) return undefined;
      if (result.kind === "browser-flow-run") {
        current.current = result.run;
        setRun(result.run);
        setUncertain(false);
        setMessage(result.run.message ?? "Review the fixed steps and values before running.");
      } else if (result.kind === "browser-flows-refused") setMessage(result.message);
      return result;
    } catch {
      if (!operationLifetime?.signal.aborted) {
        setUncertain(current.current !== undefined);
        setMessage("The request could not be confirmed. Check the run before trying again.");
      }
      return undefined;
    } finally {
      if (!operationLifetime?.signal.aborted) setPending(false);
    }
  }
  async function confirm(): Promise<void> {
    if (uncertain && run !== undefined) {
      await request({ kind: "inspect-run", runId: run.id });
      return;
    }
    if (run === undefined) {
      if (task !== undefined)
        await request({
          kind: "review-run",
          projectId: flow.projectId,
          name: flow.name,
          threadId: task.threadId,
          mode: task.mode,
        });
    } else if (run.state === "review") {
      await request({
        kind: "start-run",
        runId: run.id,
        values: [...new Set([...Object.keys(values), ...Object.keys(titles)])].map((step) => ({
          step: Number(step),
          ...(values[Number(step)] === undefined ? {} : { text: values[Number(step)] }),
          ...(titles[Number(step)] === undefined ? {} : { expectedTitle: titles[Number(step)] }),
        })),
      });
    } else if (run.state === "paused") await request({ kind: "resume-run", runId: run.id });
    else props.onClose();
  }
  async function cancel(): Promise<void> {
    if (run !== undefined && ["review", "running", "paused"].includes(run.state)) {
      const result = await request({ kind: "cancel-run", runId: run.id });
      if (result === undefined) return;
    }
    props.onClose();
  }
  const chosen = run?.task ?? task;
  return (
    <OctantConfirmDialog
      title={`Run “${flow.name}”`}
      confirmLabel={
        uncertain
          ? "Check run"
          : run === undefined
            ? "Review run"
            : run.state === "review"
              ? "Run fixed steps"
              : run.state === "paused"
                ? "Resume"
                : run.state === "running"
                  ? "Running…"
                  : "Done"
      }
      confirmDisabled={
        uncertain ? false : run === undefined ? task === undefined : run.state === "running"
      }
      cancelLabel={run?.state === "running" || run?.state === "paused" ? "Stop run" : "Close"}
      pending={pending}
      onConfirm={() => void confirm()}
      onCancel={() => void cancel()}
      details={
        <div className="grid min-w-0 gap-2">
          {run === undefined ? (
            <OctantSelectField
              aria-label="Task to run this flow"
              value={taskId}
              onValueChange={setTaskId}
              placeholder="Choose a task"
              options={tasks.map((candidate) => ({
                id: `${candidate.mode}:${candidate.threadId}`,
                label: `${candidate.title} · ${candidate.mode === "code" ? "Code" : "Work"}`,
              }))}
            />
          ) : null}
          {chosen === undefined ? null : (
            <p>
              {chosen.title} · {chosen.modelId} · {chosen.accessLabel} · {chosen.profileLabel} ·
              this host
            </p>
          )}
          <p role="status">{message}</p>
          {run === undefined ? null : (
            <>
              <p>
                {run.completed} of {run.flow.steps.length} steps completed.
              </p>
              <ol className="grid min-w-0 gap-2">
                {run.flow.steps.map((step, index) => (
                  <li key={index} className="grid min-w-0 gap-1">
                    <span>
                      {index + 1}.{" "}
                      {step.operation === "navigate"
                        ? "Open page"
                        : step.operation === "type"
                          ? "Enter text"
                          : step.operation.replaceAll("-", " ")}
                    </span>
                    <FlowStepReview step={step} />
                    {step.operation === "type" &&
                    typeof step.input.text === "string" &&
                    run.state === "review" ? (
                      <OctantField>
                        <OctantFieldLabel htmlFor={`${fieldPrefix}-text-${index}`}>
                          Text for this run
                        </OctantFieldLabel>
                        <OctantInput
                          id={`${fieldPrefix}-text-${index}`}
                          aria-label={`Text for step ${index + 1}`}
                          autoComplete="off"
                          maxLength={8192}
                          value={values[index] ?? step.input.text}
                          onChange={(event) =>
                            setValues((previous) => ({ ...previous, [index]: event.target.value }))
                          }
                        />
                      </OctantField>
                    ) : null}
                    {run.state === "review" && step.expect.title !== undefined ? (
                      <OctantField>
                        <OctantFieldLabel htmlFor={`${fieldPrefix}-title-${index}`}>
                          Expected title
                        </OctantFieldLabel>
                        <OctantInput
                          id={`${fieldPrefix}-title-${index}`}
                          aria-label={`Expected title for step ${index + 1}`}
                          maxLength={1024}
                          value={titles[index] ?? step.expect.title}
                          onChange={(event) =>
                            setTitles((previous) => ({ ...previous, [index]: event.target.value }))
                          }
                        />
                      </OctantField>
                    ) : null}
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      }
    >
      Uses an existing task’s current model and permissions. Review the fixed steps before starting.
      Edited text and expected titles apply only to this run. Closing an active run stops it; a step
      already dispatched may have acted.
    </OctantConfirmDialog>
  );
}

function FlowStepReview({ step }: { readonly step: BrowserFlowStep }) {
  const targets = Object.values(step.targets ?? {});
  const values = Object.entries(step.input).filter(
    ([key]) => !["operation", "ref", "toRef"].includes(key),
  );
  return (
    <div className="grid min-w-0 gap-1 text-sm">
      {targets.map((target, index) => (
        <span key={index}>
          {target.role === "textbox" ? "Field" : target.role === "button" ? "Button" : target.role}:{" "}
          {target.name}
        </span>
      ))}
      {values.map(([key, value]) => (
        <span className="break-all whitespace-pre-wrap" key={key}>
          {key === "url"
            ? "Address"
            : key === "text"
              ? "Recorded text"
              : key === "key"
                ? "Key"
                : key.replace(/([A-Z])/g, " $1")}
          : {reviewedValue(value)}
        </span>
      ))}
      {step.expect.path === "" ? null : (
        <span className="break-all">
          Recorded page: {step.expect.path}
          {step.expect.title === undefined ? "" : ` · ${step.expect.title}`}
        </span>
      )}
    </div>
  );
}

function reviewedValue(value: unknown, depth = 0): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (value === null || value === undefined) return "Not specified";
  if (depth >= 2) return "Nested value";
  if (Array.isArray(value)) return value.map((entry) => reviewedValue(entry, depth + 1)).join("; ");
  if (typeof value === "object")
    return Object.entries(value)
      .filter(([key]) => key !== "ref")
      .map(
        ([key, entry]) => `${key.replace(/([A-Z])/g, " $1")}: ${reviewedValue(entry, depth + 1)}`,
      )
      .join(", ");
  return "Not specified";
}
