import { UtcTimestamp, type ProjectId, type WindowId } from "@octant/contracts";
import { Schema } from "effect";
import {
  decodeBrowserFlow,
  BrowserFlowRunId,
  MAX_BROWSER_FLOW_BYTES,
  type BrowserFlow,
  type BrowserFlowsResult,
  type BrowserFlowRun,
  type BrowserFlowRunValue,
  type BrowserFlowTask,
} from "@octant/contracts/browser-flows";
import type { BrowserFlowRefs } from "./browserFlows";
import { replayBrowserFlow } from "./browserFlows";
import type { BrowserToolAnswer, BrowserToolStep } from "./browserToolOperations";

export interface BrowserFlowTaskBinding {
  /** Host-owned task/model/authority/profile/site-grant identity, read again before each effect. */
  readonly fingerprint: string;
  readonly resumeFingerprint?: string;
  readonly refs: () => BrowserFlowRefs;
  readonly execute: (step: BrowserToolStep, signal: AbortSignal) => Promise<BrowserToolAnswer>;
  /** Exclusive Browser custody, including paused runs. A person can still take over. */
  readonly claim: (current: () => boolean) => { readonly release: () => void } | undefined;
}

export interface BrowserFlowRunsOptions {
  readonly readFlow: (projectId: ProjectId, name: string) => BrowserFlow | undefined;
  readonly tasks: (windowId: WindowId, projectId: ProjectId) => ReadonlyArray<BrowserFlowTask>;
  readonly bindTask: (
    windowId: WindowId,
    projectId: ProjectId,
    task: BrowserFlowTask,
  ) => BrowserFlowTaskBinding | undefined;
  readonly uuid: () => string;
  readonly now: () => number;
}

interface OwnedRun {
  readonly windowId: WindowId;
  readonly fingerprint: string;
  readonly flowIdentity: string;
  readonly abort: AbortController;
  readonly expiresAt: number;
  view: BrowserFlowRun;
  execution: BrowserFlow;
  binding: BrowserFlowTaskBinding | undefined;
  release: (() => void) | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  resumeFingerprint: string | undefined;
}
const lifetime = 15 * 60_000;
const maxRuns = 20;
const active = (run: OwnedRun) => run.view.state === "running" || run.view.state === "paused";
const refused = (
  reason: "not-found" | "task-unavailable" | "run-stale" | "run-busy" | "invalid-values",
  message: string,
): BrowserFlowsResult => ({ kind: "browser-flows-refused", reason, message });

/** Fixed replay under one reviewed task. Values live only in this finite host-memory run. */
export class BrowserFlowRuns {
  readonly #options: BrowserFlowRunsOptions;
  readonly #runs = new Map<string, OwnedRun>();

  constructor(options: BrowserFlowRunsOptions) {
    this.#options = options;
  }

  tasks(windowId: WindowId, projectId: ProjectId): BrowserFlowsResult {
    return {
      kind: "browser-flow-tasks",
      tasks: this.#options.tasks(windowId, projectId).slice(0, 256),
    };
  }

  review(
    windowId: WindowId,
    projectId: ProjectId,
    name: string,
    task: Pick<BrowserFlowTask, "threadId" | "mode">,
  ): BrowserFlowsResult {
    this.#expire();
    const selected = this.#options
      .tasks(windowId, projectId)
      .find(
        (candidate) =>
          String(candidate.threadId) === String(task.threadId) && candidate.mode === task.mode,
      );
    const bound =
      selected === undefined ? undefined : this.#options.bindTask(windowId, projectId, selected);
    const saved = this.#options.readFlow(projectId, name);
    if (bound === undefined || selected === undefined)
      return refused("task-unavailable", "Choose an available Work or Code task in this Project.");
    if (saved === undefined) return refused("not-found", "That flow no longer exists.");
    if (this.#runs.size >= maxRuns) {
      const oldest = [...this.#runs].find(([, run]) => !active(run));
      if (oldest === undefined)
        return refused("run-busy", "Finish or cancel an existing Browser flow run first.");
      this.#finish(oldest[1], "cancelled");
      this.#runs.delete(oldest[0]);
    }
    const flow = decodeBrowserFlow(structuredClone(saved));
    const expiresAt = this.#options.now() + lifetime;
    const run: OwnedRun = {
      windowId,
      fingerprint: bound.fingerprint,
      flowIdentity: JSON.stringify(flow),
      abort: new AbortController(),
      expiresAt,
      release: undefined,
      execution: flow,
      timer: undefined,
      resumeFingerprint: undefined,
      binding: undefined,
      view: {
        id: Schema.decodeUnknownSync(BrowserFlowRunId)(this.#options.uuid()),
        projectId,
        task: selected,
        flow,
        state: "review",
        completed: 0,
        expiresAt: Schema.decodeUnknownSync(UtcTimestamp)(new Date(expiresAt).toISOString()),
      },
    };
    run.timer = setTimeout(() => {
      run.abort.abort();
      this.#finish(run, "expired", "This flow review expired. Review it again before running.");
    }, lifetime);
    run.timer.unref();
    this.#runs.set(run.view.id, run);
    return this.#view(run);
  }

  inspect(windowId: WindowId, runId: string): BrowserFlowsResult {
    const run = this.#owned(windowId, runId);
    return run === undefined
      ? refused("not-found", "This Browser flow run is no longer available.")
      : this.#view(run);
  }

  async start(
    windowId: WindowId,
    runId: string,
    values: ReadonlyArray<BrowserFlowRunValue>,
  ): Promise<BrowserFlowsResult> {
    const run = this.#owned(windowId, runId);
    if (run === undefined)
      return refused("not-found", "This Browser flow run is no longer available.");
    if (run.view.state !== "review")
      return refused("run-stale", "Review this flow again before starting.");
    const edited = new Set<number>();
    const steps = [...run.view.flow.steps];
    for (const value of values) {
      const step = steps[value.step];
      if (
        edited.has(value.step) ||
        step === undefined ||
        (value.text === undefined && value.expectedTitle === undefined) ||
        (value.text !== undefined &&
          (step.operation !== "type" ||
            typeof step.input.text !== "string" ||
            value.text.length > 8192)) ||
        (value.expectedTitle !== undefined &&
          (step.expect.title === undefined || value.expectedTitle.length > 1024))
      )
        return refused(
          "invalid-values",
          "Only recorded type text and expected titles can receive reviewed run-specific values.",
        );
      edited.add(value.step);
      steps[value.step] = {
        ...step,
        input: value.text === undefined ? step.input : { ...step.input, text: value.text },
        expect:
          value.expectedTitle === undefined
            ? step.expect
            : { ...step.expect, title: value.expectedTitle },
      };
    }
    const execution = { ...run.view.flow, steps };
    if (Buffer.byteLength(JSON.stringify(execution), "utf8") > MAX_BROWSER_FLOW_BYTES)
      return refused("invalid-values", "These values exceed the flow's size limit.");
    run.execution = execution;
    return this.#launch(run);
  }

  async resume(windowId: WindowId, runId: string): Promise<BrowserFlowsResult> {
    const run = this.#owned(windowId, runId);
    if (run === undefined || run.view.state !== "paused")
      return refused("run-stale", "Only a paused, unchanged flow can resume.");
    if (this.#current(run)?.resumeFingerprint !== run.resumeFingerprint) {
      this.#finish(run, "failed", "Site approval changed while paused. Review this flow again.");
      return refused("run-stale", "Site approval changed while paused. Review this flow again.");
    }
    return this.#launch(run);
  }

  cancel(windowId: WindowId, runId: string): BrowserFlowsResult {
    const run = this.#owned(windowId, runId);
    if (run === undefined)
      return refused("not-found", "This Browser flow run is no longer available.");
    if (run.view.state === "review" || active(run)) {
      run.abort.abort();
      this.#finish(
        run,
        "cancelled",
        "Stopped. An operation already dispatched may have acted; it will not be retried.",
      );
    }
    return this.#view(run);
  }

  revokeWindow(windowId: WindowId): void {
    for (const run of this.#runs.values())
      if (run.windowId === windowId && (run.view.state === "review" || active(run))) {
        run.abort.abort();
        this.#finish(run, "cancelled", "The reviewing window lost authority.");
      }
  }

  close(): void {
    for (const run of this.#runs.values()) {
      run.abort.abort();
      this.#finish(run, "cancelled");
    }
    this.#runs.clear();
  }

  #owned(windowId: WindowId, runId: string): OwnedRun | undefined {
    this.#expire();
    const run = this.#runs.get(runId);
    return run?.windowId === windowId ? run : undefined;
  }

  #current(run: OwnedRun): BrowserFlowTaskBinding | undefined {
    if (run.abort.signal.aborted || this.#options.now() >= run.expiresAt) return undefined;
    if (
      JSON.stringify(this.#options.readFlow(run.view.projectId, run.view.flow.name)) !==
      run.flowIdentity
    )
      return undefined;
    const binding = this.#options.bindTask(run.windowId, run.view.projectId, run.view.task);
    return binding?.fingerprint === run.fingerprint ? binding : undefined;
  }

  #launch(run: OwnedRun): BrowserFlowsResult {
    const binding = this.#current(run);
    if (binding === undefined) {
      this.#finish(
        run,
        "failed",
        "The flow, task authority, model, profile or site approval changed. Review it again.",
      );
      return refused("run-stale", run.view.message ?? "Review this flow again.");
    }
    if (run.release === undefined) {
      const custody = binding.claim(() => this.#current(run) !== undefined);
      if (custody === undefined)
        return refused(
          "run-busy",
          "This task's Browser is busy. Try again after the current operation ends.",
        );
      run.release = custody.release;
      run.binding = binding;
    }
    run.view = { ...run.view, state: "running", message: "Running the reviewed fixed steps." };
    void this.#execute(run, run.binding ?? binding);
    return this.#view(run);
  }

  async #execute(run: OwnedRun, binding: BrowserFlowTaskBinding): Promise<void> {
    try {
      const answer = await replayBrowserFlow(run.execution, {
        startAt: run.view.completed,
        refs: binding.refs,
        onStep: (index) => {
          run.view = { ...run.view, completed: index + 1 };
        },
        run: (step) =>
          this.#current(run) === undefined
            ? Promise.resolve({ isError: true, result: { error: "run-authority-changed" } })
            : binding.execute(step, run.abort.signal),
      });
      if (run.view.state !== "running") return;
      if (answer.isError) {
        if (this.#current(run) !== undefined && heldBeforeEffect(answer.result)) {
          run.resumeFingerprint = this.#current(run)?.resumeFingerprint;
          run.view = {
            ...run.view,
            state: "paused",
            message: "The person holds this page. Hand it back, then choose Resume.",
          };
          return;
        }
        this.#finish(
          run,
          "failed",
          `Stopped at step ${run.view.completed + 1}. Review the page before starting another run; an uncertain operation is never retried.`,
        );
      } else this.#finish(run, "completed", "All reviewed steps completed.");
    } catch {
      if (run.view.state === "running")
        this.#finish(
          run,
          "failed",
          "The run could not finish. An operation may have acted; it will not be retried.",
        );
    }
  }

  #expire(): void {
    for (const run of this.#runs.values()) {
      if (this.#options.now() >= run.expiresAt && (run.view.state === "review" || active(run))) {
        run.abort.abort();
        this.#finish(run, "expired", "This flow review expired. Review it again before running.");
      }
    }
  }

  #finish(run: OwnedRun, state: BrowserFlowRun["state"], message?: string): void {
    run.view = { ...run.view, state, ...(message === undefined ? {} : { message }) };
    if (run.timer !== undefined) clearTimeout(run.timer);
    run.timer = undefined;
    run.release?.();
    run.release = undefined;
    run.execution = run.view.flow;
    run.binding = undefined;
  }

  #view(run: OwnedRun): BrowserFlowsResult {
    return { kind: "browser-flow-run", run: structuredClone(run.view) };
  }
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
function heldBeforeEffect(value: unknown): boolean {
  const failure = record(record(value)?.failedStep);
  const error = record(failure?.answer)?.error;
  return error === "browser-waiting-for-person" || error === "browser-person-took-over";
}
