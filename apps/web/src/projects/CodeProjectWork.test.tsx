import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { decodeCodeProjectReport } from "@octant/contracts/code";
import { projectConversationCodes, projectId } from "../App.test-fixtures";
import { CodeProjectWork } from "./CodeProjectWork";

describe("the Project report", () => {
  it("keeps a decision outstanding after reading and shows the same result once after the answer", async () => {
    const client = await projectConversationCodes();
    const { threads } = await client.bootstrap();
    const worker = threads.find((thread) => thread.coordinatorThreadId !== undefined);
    if (worker?.coordinatorThreadId === undefined) throw new Error("Expected a Project worker.");
    const onRead = vi.fn();
    const row = {
      threadId: worker.id,
      projectId,
      title: worker.title,
      lifecycle: worker.lifecycle,
      providerInstanceId: worker.providerInstanceId,
      executionPolicy: worker.executionPolicy,
      coordinatorThreadId: worker.coordinatorThreadId,
    };
    const props = {
      projectId,
      conversationId: worker.coordinatorThreadId,
      client,
      reportSequence: 2,
      onRead,
      onOpen: vi.fn(),
      onOpenBeside: vi.fn(),
    };
    const view = render(<CodeProjectWork {...props} threads={[{ ...row, awaitingInput: true }]} />);
    const summary = "Retry coverage now includes interrupted downloads.";
    expect(await screen.findByText(summary)).toBeVisible();
    await waitFor(() => expect(onRead).toHaveBeenCalledWith(worker.coordinatorThreadId, 2));
    expect(screen.getByText(/Needs you \(1\)/)).toBeVisible();
    view.rerender(<CodeProjectWork {...props} threads={[row]} />);
    expect(client.execute).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText(summary)).toHaveLength(1);
    expect(screen.getByText(/Needs you \(0\)/)).toBeVisible();
  });
  it("adds an earlier page once and marks only the newest report as read", async () => {
    const client = await projectConversationCodes();
    const { threads } = await client.bootstrap();
    const worker = threads.find((thread) => thread.coordinatorThreadId !== undefined);
    if (worker?.coordinatorThreadId === undefined) throw new Error("Expected a Project worker.");
    const newest = decodeCodeProjectReport({
      workerId: worker.id,
      operationId: "00000000-0000-4000-8000-000000000892",
      sequence: 4,
      title: worker.title,
      state: "completed",
      summary: "Newest result",
      updatedAt: worker.updatedAt,
    });
    const older = decodeCodeProjectReport({
      ...newest,
      operationId: "00000000-0000-4000-8000-000000000893",
      sequence: 2,
      summary: "Earlier result",
    });
    const next = { sequence: newest.sequence, operationId: newest.operationId };
    const execute = vi.fn<typeof client.execute>(async (command) => ({
      kind: "project-report-page",
      ...(command.kind === "read-code-project-report-page" && command.before !== undefined
        ? { reports: [older] }
        : { reports: [newest], next }),
    }));
    const onRead = vi.fn();
    render(
      <CodeProjectWork
        projectId={projectId}
        conversationId={worker.coordinatorThreadId}
        client={{ ...client, execute }}
        reportSequence={newest.sequence}
        onRead={onRead}
        onOpen={vi.fn()}
        onOpenBeside={vi.fn()}
        threads={[]}
      />,
    );
    expect(await screen.findByText(newest.summary)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Load earlier reports" }));
    expect(await screen.findByText(older.summary)).toBeVisible();
    expect(screen.getAllByText(newest.summary)).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Load earlier reports" })).toBeNull();
    expect(execute).toHaveBeenLastCalledWith(
      { kind: "read-code-project-report-page", projectId, before: next },
      expect.any(AbortSignal),
    );
    expect(onRead.mock.calls).toEqual([[worker.coordinatorThreadId, newest.sequence]]);
  });
});
