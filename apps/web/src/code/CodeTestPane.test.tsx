import type { CodeOperationResult } from "@octant/contracts/code-operations";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CodeTestPane } from "./CodeTestPane";
import { codeClient, evidence, ids, scope, testDefinition } from "./CodeDeliveryPane.test-fixtures";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("CodeTestPane", () => {
  it("renders exact definition, verdict, concerns, artifacts, and evidence", async () => {
    const client = codeClient({ evidence: "15 tests passed" });
    render(
      <CodeTestPane
        client={client}
        createOperationId={() => ids.operation as never}
        createTestRunId={() => ids.testRun as never}
        definitions={[testDefinition]}
        executionPolicy="full-access"
        result={
          {
            kind: "repository-test-state",
            operationId: ids.operation,
            testRunId: ids.testRun,
            state: "completed",
            verdict: "passed",
            evidence: evidence(true),
            concerns: ["output-truncated", "cleanup-uncertain"],
          } as never
        }
        scope={scope}
      />,
    );

    expect(screen.getByText("bun run test")).toBeVisible();
    expect(screen.getByText("coverage/index.html")).toBeVisible();
    expect(screen.getByText("Passed")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(/truncated.*cleanup/i);
    expect(await screen.findByText("15 tests passed")).toBeVisible();
  });

  it("shows a running state immediately after approval, before the host answers", async () => {
    const client = codeClient();
    const pending = deferred<CodeOperationResult>();
    const createTestRunId = vi.fn(() => ids.testRun as never);
    vi.mocked(client.executeOperation).mockReturnValue(pending.promise);
    render(
      <CodeTestPane
        client={client}
        createOperationId={() => ids.operation as never}
        createTestRunId={createTestRunId}
        definitions={[testDefinition]}
        executionPolicy="full-access"
        scope={scope}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Run Web tests" }));

    expect(screen.getByText(/Running Web tests/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Run Web tests" })).not.toBeInTheDocument();
    expect(createTestRunId).toHaveBeenCalledOnce();
    expect(vi.mocked(client.executeOperation)).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "run-repository-test", testRunId: ids.testRun }),
    );

    pending.resolve({
      kind: "repository-test-state",
      operationId: ids.operation,
      testRunId: ids.testRun,
      state: "completed",
      verdict: "passed",
      concerns: [],
    } as unknown as CodeOperationResult);

    expect(await screen.findByText(/All tests passed/)).toBeVisible();
  });

  it("refuses a second submission while the first run is pending", async () => {
    const client = codeClient();
    const pending = deferred<CodeOperationResult>();
    vi.mocked(client.executeOperation).mockReturnValue(pending.promise);
    render(
      <CodeTestPane
        client={client}
        createOperationId={() => ids.operation as never}
        createTestRunId={() => ids.testRun as never}
        definitions={[testDefinition]}
        executionPolicy="full-access"
        scope={scope}
      />,
    );

    // Two clicks inside one act run before React re-renders, so the second
    // reaches the same Run handler while the first run is still pending: the
    // guard, not the disabled button, is what refuses it.
    const run = screen.getByRole("button", { name: "Run Web tests" });
    act(() => {
      run.click();
      run.click();
    });

    expect(vi.mocked(client.executeOperation)).toHaveBeenCalledOnce();
    expect(vi.mocked(client.executeOperation)).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "run-repository-test" }),
    );
    expect(screen.queryByRole("button", { name: "Run Web tests" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel test" })).toBeVisible();
  });

  it("runs only the selected structured definition and hides mutation in Plan", async () => {
    const client = codeClient();
    const { rerender } = render(
      <CodeTestPane
        client={client}
        createOperationId={() => ids.operation as never}
        createTestRunId={() => ids.testRun as never}
        definitions={[testDefinition]}
        executionPolicy="plan"
        scope={scope}
      />,
    );
    expect(screen.queryByRole("button", { name: "Run Web tests" })).not.toBeInTheDocument();
    expect(screen.getByText("Plan mode is read-only.")).toBeVisible();

    rerender(
      <CodeTestPane
        client={client}
        createOperationId={() => ids.operation as never}
        createTestRunId={() => ids.testRun as never}
        definitions={[testDefinition]}
        executionPolicy="full-access"
        scope={scope}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Run Web tests" }));
    await waitFor(() =>
      expect(client.executeOperation).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "run-repository-test", definition: testDefinition }),
      ),
    );
  });

  it("says so and offers nothing to run when the checkout has no definitions", () => {
    const client = codeClient();
    render(
      <CodeTestPane
        client={client}
        createOperationId={() => ids.operation as never}
        createTestRunId={() => ids.testRun as never}
        definitions={[]}
        executionPolicy="full-access"
        scope={scope}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("No structured tests are available.");
    expect(screen.queryByRole("button", { name: /Run/ })).not.toBeInTheDocument();
  });

  it("prompts before an approval-gated run and stays idle when approval is refused", async () => {
    const client = codeClient();
    const requestApproval = vi.fn(async () => false);
    render(
      <CodeTestPane
        client={client}
        createOperationId={() => ids.operation as never}
        createTestRunId={() => ids.testRun as never}
        definitions={[testDefinition]}
        executionPolicy="approval-gated"
        requestApproval={requestApproval}
        scope={scope}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Run Web tests" }));
    await waitFor(() =>
      expect(requestApproval).toHaveBeenCalledWith({
        command: expect.objectContaining({
          kind: "run-repository-test",
          definition: testDefinition,
          operationId: ids.operation,
        }),
      }),
    );
    expect(client.executeOperation).not.toHaveBeenCalled();
    // A refused approval leaves the pane idle: Run is back and no run is named.
    expect(await screen.findByRole("button", { name: "Run Web tests" })).toBeVisible();
    expect(screen.queryByText(/Running Web tests/)).not.toBeInTheDocument();
  });

  it("renders an actionable test command failure", async () => {
    const client = codeClient();
    (client.executeOperation as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("offline"));
    render(
      <CodeTestPane
        client={client}
        createOperationId={() => ids.operation as never}
        createTestRunId={() => ids.testRun as never}
        definitions={[testDefinition]}
        executionPolicy="full-access"
        scope={scope}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Run Web tests" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/test command failed/i);
  });

  it("cancels the exact active test run, naming its test-run, thread, and checkout ids", async () => {
    const client = codeClient();
    const pending = deferred<CodeOperationResult>();
    const createOperationId = vi
      .fn()
      .mockReturnValueOnce(ids.operation as never)
      .mockReturnValueOnce("c0000000-0000-4000-8000-000000000001" as never);
    vi.mocked(client.executeOperation).mockImplementation((command) => {
      if (command.kind === "cancel-repository-test") {
        return Promise.resolve({
          kind: "repository-test-state",
          operationId: "c0000000-0000-4000-8000-000000000001",
          testRunId: ids.testRun,
          state: "interrupted",
          concerns: [],
        } as unknown as CodeOperationResult);
      }
      return pending.promise;
    });
    render(
      <CodeTestPane
        client={client}
        createOperationId={createOperationId}
        createTestRunId={() => ids.testRun as never}
        definitions={[testDefinition]}
        executionPolicy="full-access"
        scope={scope}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Run Web tests" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel test" }));

    await waitFor(() =>
      expect(client.executeOperation).toHaveBeenCalledWith({
        kind: "cancel-repository-test",
        operationId: "c0000000-0000-4000-8000-000000000001",
        testRunId: ids.testRun,
        ...scope,
      }),
    );

    // A delivered cancellation keeps the pane in the cancelling phase until the
    // run's own call settles, rather than offering a second Cancel for a run
    // that is already stopping.
    expect(screen.getByText(/Cancelling Web tests/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Cancel test" })).not.toBeInTheDocument();

    pending.resolve({
      kind: "repository-test-state",
      operationId: ids.operation,
      testRunId: ids.testRun,
      state: "interrupted",
      concerns: [],
    } as unknown as CodeOperationResult);
    expect(await screen.findByText("Interrupted")).toBeVisible();
  });

  it("keeps the run cancellable when the cancel approval is refused", async () => {
    const client = codeClient();
    const pending = deferred<CodeOperationResult>();
    vi.mocked(client.executeOperation).mockReturnValue(pending.promise);
    const requestApproval = vi.fn(async () => true);
    render(
      <CodeTestPane
        client={client}
        createOperationId={() => ids.operation as never}
        createTestRunId={() => ids.testRun as never}
        definitions={[testDefinition]}
        executionPolicy="approval-gated"
        requestApproval={requestApproval}
        scope={scope}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Run Web tests" }));
    const cancelButton = await screen.findByRole("button", { name: "Cancel test" });
    requestApproval.mockResolvedValue(false);
    fireEvent.click(cancelButton);

    await waitFor(() => expect(requestApproval).toHaveBeenCalledTimes(2));
    // The refused cancel approval never reached the host; the run is still
    // cancellable and the pane did not claim it stopped.
    expect(vi.mocked(client.executeOperation)).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Cancel test" })).toBeVisible();
  });

  it("returns Cancel and reports the host's reason when a cancellation fails", async () => {
    const client = codeClient();
    const pending = deferred<CodeOperationResult>();
    vi.mocked(client.executeOperation).mockImplementation((command) =>
      command.kind === "cancel-repository-test"
        ? Promise.resolve({
            kind: "operation-failed",
            operationId: command.operationId,
            failure: { category: "unavailable", message: "Repository test is unavailable." },
          } as unknown as CodeOperationResult)
        : pending.promise,
    );
    render(
      <CodeTestPane
        client={client}
        createOperationId={() => ids.operation as never}
        createTestRunId={() => ids.testRun as never}
        definitions={[testDefinition]}
        executionPolicy="full-access"
        scope={scope}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Run Web tests" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel test" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/Repository test is unavailable/);
    // The run never stopped, so Cancel is offered again.
    expect(screen.getByRole("button", { name: "Cancel test" })).toBeVisible();
  });

  it("shows an interrupted restored result and makes the next step clear", () => {
    render(
      <CodeTestPane
        client={codeClient()}
        createOperationId={() => ids.operation as never}
        createTestRunId={() => ids.testRun as never}
        definitions={[testDefinition]}
        executionPolicy="full-access"
        result={
          {
            kind: "repository-test-state",
            operationId: ids.operation,
            testRunId: ids.testRun,
            state: "interrupted",
            concerns: ["timeout"],
          } as never
        }
        scope={scope}
      />,
    );

    expect(screen.getByText("Interrupted")).toBeVisible();
    expect(screen.getByText(/Run it again to get a verdict/)).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("Timed out");
  });

  it("reports unavailable evidence actionably instead of leaving the pane blank", async () => {
    const client = codeClient();
    (client.operationContent as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("gone"));
    render(
      <CodeTestPane
        client={client}
        createOperationId={() => ids.operation as never}
        createTestRunId={() => ids.testRun as never}
        definitions={[testDefinition]}
        executionPolicy="full-access"
        result={
          {
            kind: "repository-test-state",
            operationId: ids.operation,
            testRunId: ids.testRun,
            state: "completed",
            verdict: "failed",
            evidence: evidence(false),
            concerns: [],
          } as never
        }
        scope={scope}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(/evidence is unavailable/i);
  });
});
