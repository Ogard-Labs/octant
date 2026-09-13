import type { CodeClient } from "@octant/client-runtime/code-client";
import type { CodeCheckoutId, CodeTestRunId, CodeThreadId } from "@octant/contracts/code";
import type { CodeOperationId, CodeOperationResult } from "@octant/contracts/code-operations";
import type {
  CodeRepositoryTestConcern,
  CodeRepositoryTestDefinition,
} from "@octant/contracts/code-test-definitions";
import type { ProviderExecutionPolicy } from "@octant/contracts/providers";
import { decidesCodeEffectsByApproval } from "@octant/domain";
import { useEffect, useRef, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantSelectField } from "../ui/base/OctantSelect";

type TestResult = Extract<CodeOperationResult, { readonly kind: "repository-test-state" }>;

/**
 * The run this pane started and has not yet seen settle.
 *
 * `approval` is the phase before the command is submitted: the ids are already
 * the run's, but a refused approval returns the pane to idle without a run.
 * `running` is the submitted run the host is executing. `cancelling` is a
 * cancellation the pane is waiting on; the run itself still owns the verdict,
 * so the pane keeps the run's identity until its own call settles.
 */
type ActiveTestRun = {
  readonly operationId: CodeOperationId;
  readonly testRunId: CodeTestRunId;
  readonly definitionName: string;
  readonly state: "approval" | "running" | "cancelling";
};

export interface CodeTestPaneProps {
  readonly client: Pick<CodeClient, "executeOperation" | "operationContent">;
  readonly createOperationId: () => CodeOperationId;
  readonly createTestRunId: () => CodeTestRunId;
  readonly definitions: ReadonlyArray<CodeRepositoryTestDefinition>;
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly requestApproval?: (input: {
    readonly command: Parameters<CodeClient["executeOperation"]>[0];
  }) => Promise<boolean>;
  readonly result?: TestResult;
  readonly scope: { readonly checkoutId: CodeCheckoutId; readonly threadId: CodeThreadId };
}

export function CodeTestPane(props: CodeTestPaneProps) {
  const [selectedId, setSelectedId] = useState<CodeRepositoryTestDefinition["id"]>();
  const [result, setResult] = useState<TestResult | undefined>(props.result);
  const [activeRun, setActiveRun] = useState<ActiveTestRun>();
  const [evidence, setEvidence] = useState<string>();
  const [failure, setFailure] = useState<string>();
  // The ref rejects a second submission that arrives before React re-renders
  // the disabled button, which is what makes a double click unable to start two
  // runs. The state drives the disabled button the user sees.
  const activeRunRef = useRef<ActiveTestRun | undefined>(undefined);
  const selected =
    props.definitions.find((definition) => definition.id === selectedId) ?? props.definitions[0];

  useEffect(() => setResult(props.result), [props.result]);
  useEffect(() => {
    let active = true;
    setEvidence(undefined);
    if (result?.evidence === undefined) return () => void (active = false);
    void props.client
      .operationContent(props.scope.threadId, result.operationId, result.evidence.contentId)
      .then((bytes) => {
        if (active) setEvidence(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      })
      .catch(() => {
        if (active)
          setFailure("Repository test evidence is unavailable. Rerun the test for output.");
      });
    return () => void (active = false);
  }, [props.client, props.scope.threadId, result]);

  const beginRun = (run: ActiveTestRun): void => {
    activeRunRef.current = run;
    setActiveRun(run);
  };
  const endRun = (): void => {
    activeRunRef.current = undefined;
    setActiveRun(undefined);
  };

  const run = async () => {
    if (selected === undefined || props.executionPolicy === "plan") return;
    if (activeRunRef.current !== undefined) return;
    const operationId = props.createOperationId();
    const testRunId = props.createTestRunId();
    const command = {
      kind: "run-repository-test",
      operationId,
      testRunId,
      definition: selected,
      ...props.scope,
    } as const;
    setFailure(undefined);
    if (decidesCodeEffectsByApproval(props.executionPolicy)) {
      beginRun({ operationId, testRunId, definitionName: selected.name, state: "approval" });
      let approved = false;
      try {
        approved = (await props.requestApproval?.({ command })) === true;
      } catch {
        endRun();
        setFailure("Repository test approval failed. Retry when the host is reachable.");
        return;
      }
      if (!approved) {
        endRun();
        return;
      }
    }
    beginRun({ operationId, testRunId, definitionName: selected.name, state: "running" });
    try {
      const next = await props.client.executeOperation(command);
      if (next.kind === "repository-test-state") setResult(next);
      if (next.kind === "operation-failed") setFailure(next.failure.message);
    } catch {
      setFailure("Repository test command failed. Reconnect and retry.");
    } finally {
      endRun();
    }
  };

  const cancel = async () => {
    const current = activeRunRef.current;
    if (current === undefined || current.state !== "running" || props.executionPolicy === "plan") {
      return;
    }
    const operationId = props.createOperationId();
    const command = {
      kind: "cancel-repository-test",
      operationId,
      testRunId: current.testRunId,
      ...props.scope,
    } as const;
    setFailure(undefined);
    // Entering the cancelling phase before the approval prompt keeps a second
    // click from raising a second cancellation; a refusal puts the run back.
    beginRun({ ...current, state: "cancelling" });
    const resumeRunning = () => {
      const after = activeRunRef.current;
      if (after !== undefined && after.state === "cancelling") {
        beginRun({ ...after, state: "running" });
      }
    };
    if (decidesCodeEffectsByApproval(props.executionPolicy)) {
      let approved = false;
      try {
        approved = (await props.requestApproval?.({ command })) === true;
      } catch {
        resumeRunning();
        setFailure("Repository test cancellation failed. Reconnect and retry.");
        return;
      }
      if (!approved) {
        resumeRunning();
        return;
      }
    }
    // The run may have settled while the approval was open; a cancellation for
    // a run that already finished would only report it as unavailable.
    if (activeRunRef.current?.state !== "cancelling") return;
    try {
      const next = await props.client.executeOperation(command);
      if (next.kind === "operation-failed") setFailure(next.failure.message);
    } catch {
      setFailure("Repository test cancellation failed. Reconnect and retry.");
    } finally {
      // The run's own call settles the pane's result. A cancel that returns
      // without the run having stopped leaves the run active so Cancel stays
      // available; the run clearing the ref is what ends the phase.
      const after = activeRunRef.current;
      if (after !== undefined && after.state === "cancelling") {
        beginRun({ ...after, state: "running" });
      }
    }
  };

  return (
    <section aria-label="Repository tests" className="code-delivery-pane code-test-pane">
      <header className="code-delivery-pane__toolbar">
        <div>
          <h1>Repository tests</h1>
        </div>
        <p>{activeRunLabel(activeRun) ?? resultLabel(result)}</p>
      </header>
      {props.definitions.length === 0 ? (
        <p role="status">No structured tests are available.</p>
      ) : null}
      {props.definitions.length > 1 ? (
        <label className="code-delivery-pane__field">
          Test definition
          <OctantSelectField
            onValueChange={(value) => setSelectedId(value as never)}
            options={props.definitions.map((definition) => ({
              id: definition.id,
              label: definition.name,
            }))}
            value={selected?.id ?? ""}
          />
        </label>
      ) : null}
      {selected === undefined ? null : (
        <div className="code-test-pane__definition">
          <strong>{selected.name}</strong>
          <code>{selected.argv.join(" ")}</code>
          <span>Working directory: {selected.cwd}</span>
          {selected.artifactPaths.map((path) => (
            <span key={path}>
              Artifact: <code>{path}</code>
            </span>
          ))}
          {props.executionPolicy === "plan" ? (
            <p>Plan mode is read-only.</p>
          ) : activeRun?.state === "approval" ? (
            <OctantButton disabled size="sm" type="button" variant="secondary">
              Starting…
            </OctantButton>
          ) : activeRun === undefined ? (
            <OctantButton onClick={() => void run()} size="sm" type="button" variant="secondary">
              Run {selected.name}
            </OctantButton>
          ) : (
            <OctantButton
              disabled={activeRun.state === "cancelling"}
              onClick={() => void cancel()}
              size="sm"
              type="button"
              variant="secondary"
            >
              {activeRun.state === "cancelling" ? "Cancelling…" : "Cancel test"}
            </OctantButton>
          )}
        </div>
      )}
      {activeRun === undefined ? null : (
        <p role="status">
          {activeRun.state === "approval"
            ? `Waiting for approval to run ${activeRun.definitionName}…`
            : `${activeRun.state === "cancelling" ? "Cancelling" : "Running"} ${activeRun.definitionName}…`}
        </p>
      )}
      {activeRun === undefined && result !== undefined ? (
        <p className="code-delivery-pane__status">{outcomeCopy(result)}</p>
      ) : null}
      {activeRun === undefined && result !== undefined && result.concerns.length > 0 ? (
        <p className="code-delivery-pane__warning" role="alert">
          {result.concerns.map(concernLabel).join(" · ")}
        </p>
      ) : null}
      {failure === undefined ? null : <p role="alert">{failure}</p>}
      {activeRun !== undefined || evidence === undefined ? null : (
        <pre className="code-delivery-pane__evidence">{evidence}</pre>
      )}
    </section>
  );
}

function activeRunLabel(activeRun: ActiveTestRun | undefined): string | undefined {
  if (activeRun === undefined) return undefined;
  if (activeRun.state === "approval") return "Waiting for approval";
  if (activeRun.state === "cancelling") return "Cancelling";
  return "Running";
}

function resultLabel(result: TestResult | undefined): string {
  if (result === undefined) return "Not run";
  if (result.state === "completed")
    return result.verdict.slice(0, 1).toUpperCase() + result.verdict.slice(1);
  return result.state.slice(0, 1).toUpperCase() + result.state.slice(1);
}

/**
 * What the pane tells the user to do next about a settled run. Completion alone
 * is not actionable — a passing suite, a failing suite, a cancelled run, and an
 * inconclusive one all need different words to be distinguishable.
 */
function outcomeCopy(result: TestResult): string {
  switch (result.state) {
    case "completed":
      switch (result.verdict) {
        case "passed":
          return "All tests passed.";
        case "failed":
          return "Tests failed. Review the output, fix the failures, and run again.";
        case "cancelled":
          return "The test run was cancelled before it finished.";
        case "inconclusive":
          return "The run finished without a verdict. Review the output and run again.";
        case "unavailable":
          return "The test runner could not report a verdict. Check the checkout and run again.";
      }
    case "interrupted":
      return "The test run was interrupted. Run it again to get a verdict.";
    case "unavailable":
      return "The test could not run in this checkout. Check the definition and run again.";
    case "failed":
      return "The test command failed before a verdict. Reconnect and run again.";
    case "running":
      return "This run is still in progress.";
  }
}

function concernLabel(concern: CodeRepositoryTestConcern): string {
  const labels: Record<CodeRepositoryTestConcern, string> = {
    "output-truncated": "Output truncated",
    "artifact-truncated": "Artifact truncated",
    "missing-artifact": "Artifact missing",
    "artifact-read-unavailable": "Artifact unavailable",
    timeout: "Timed out",
    "parser-failed": "Result parser failed",
    "cleanup-uncertain": "Cleanup uncertain",
  };
  return labels[concern];
}
