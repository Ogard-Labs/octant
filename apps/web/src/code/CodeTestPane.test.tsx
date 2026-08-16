import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CodeTestPane } from "./CodeTestPane";
import { codeClient, evidence, ids, scope, testDefinition } from "./CodeDeliveryPane.test-fixtures";

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
    expect(screen.getByText(/Passed/i)).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(/truncated.*cleanup/i);
    expect(await screen.findByText("15 tests passed")).toBeVisible();
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

  it("prompts before an approval-gated structured test run", async () => {
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

  it("cancels the exact running test through codeClient", async () => {
    const client = codeClient();
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
            state: "running",
            concerns: [],
          } as never
        }
        scope={scope}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel test" }));
    await waitFor(() =>
      expect(client.executeOperation).toHaveBeenCalledWith({
        kind: "cancel-repository-test",
        operationId: ids.operation,
        testRunId: ids.testRun,
        ...scope,
      }),
    );
  });
});
