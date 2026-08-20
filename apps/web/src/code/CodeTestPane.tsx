import type { CodeClient } from "@octant/client-runtime/code-client";
import type { CodeCheckoutId, CodeTestRunId, CodeThreadId } from "@octant/contracts/code";
import type { CodeOperationId, CodeOperationResult } from "@octant/contracts/code-operations";
import type {
  CodeRepositoryTestConcern,
  CodeRepositoryTestDefinition,
} from "@octant/contracts/code-test-definitions";
import type { ProviderExecutionPolicy } from "@octant/contracts/providers";
import { decidesCodeEffectsByApproval } from "@octant/domain";
import { useEffect, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantNativeSelect } from "../ui/base/OctantSelect";

type TestResult = Extract<CodeOperationResult, { readonly kind: "repository-test-state" }>;

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
  const [evidence, setEvidence] = useState<string>();
  const [failure, setFailure] = useState<string>();
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
        if (active) setFailure("Repository test evidence is unavailable.");
      });
    return () => void (active = false);
  }, [props.client, props.scope.threadId, result]);

  const run = async () => {
    if (selected === undefined || props.executionPolicy === "plan") return;
    try {
      const operationId = props.createOperationId();
      const command = {
        kind: "run-repository-test",
        operationId,
        testRunId: props.createTestRunId(),
        definition: selected,
        ...props.scope,
      } as const;
      if (
        decidesCodeEffectsByApproval(props.executionPolicy) &&
        (await props.requestApproval?.({ command })) !== true
      )
        return;
      setFailure(undefined);
      const next = await props.client.executeOperation(command);
      if (next.kind === "repository-test-state") setResult(next);
      if (next.kind === "operation-failed") setFailure(next.failure.message);
    } catch {
      setFailure("Repository test command failed. Reconnect and retry.");
    }
  };

  const cancel = async () => {
    if (result?.state !== "running" || props.executionPolicy === "plan") return;
    try {
      const operationId = props.createOperationId();
      const command = {
        kind: "cancel-repository-test",
        operationId,
        testRunId: result.testRunId,
        ...props.scope,
      } as const;
      if (
        decidesCodeEffectsByApproval(props.executionPolicy) &&
        (selected === undefined || (await props.requestApproval?.({ command })) !== true)
      )
        return;
      setFailure(undefined);
      const next = await props.client.executeOperation(command);
      if (next.kind === "repository-test-state") setResult(next);
      if (next.kind === "operation-failed") setFailure(next.failure.message);
    } catch {
      setFailure("Repository test cancellation failed. Reconnect and retry.");
    }
  };

  return (
    <section aria-label="Repository tests" className="code-delivery-pane code-test-pane">
      <header className="code-delivery-pane__toolbar">
        <div>
          <span>Tests</span>
          <h1>Repository tests</h1>
        </div>
        <p>{resultLabel(result)}</p>
      </header>
      {props.definitions.length === 0 ? (
        <p role="status">No structured tests are available.</p>
      ) : null}
      {props.definitions.length > 1 ? (
        <label className="code-delivery-pane__field">
          Test definition
          <OctantNativeSelect
            value={selected?.id ?? ""}
            onChange={(event) => setSelectedId(event.target.value as never)}
          >
            {props.definitions.map((definition) => (
              <option key={definition.id} value={definition.id}>
                {definition.name}
              </option>
            ))}
          </OctantNativeSelect>
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
          ) : result?.state === "running" ? (
            <OctantButton onClick={() => void cancel()} size="sm" type="button" variant="secondary">
              Cancel test
            </OctantButton>
          ) : (
            <OctantButton onClick={() => void run()} size="sm" type="button" variant="secondary">
              Run {selected.name}
            </OctantButton>
          )}
        </div>
      )}
      {result !== undefined && result.concerns.length > 0 ? (
        <p className="code-delivery-pane__warning" role="alert">
          {result.concerns.map(concernLabel).join(" · ")}
        </p>
      ) : null}
      {failure === undefined ? null : <p role="alert">{failure}</p>}
      {evidence === undefined ? null : (
        <pre className="code-delivery-pane__evidence">{evidence}</pre>
      )}
    </section>
  );
}

function resultLabel(result: TestResult | undefined): string {
  if (result === undefined) return "Not run";
  if (result.state === "completed")
    return result.verdict.slice(0, 1).toUpperCase() + result.verdict.slice(1);
  return result.state.slice(0, 1).toUpperCase() + result.state.slice(1);
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
