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
      reportCount: 1,
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
  it("keeps earlier pages open across a rewind and marks only the newest report as read", async () => {
    const client = await projectConversationCodes();
    const { threads } = await client.bootstrap();
    const worker = threads.find((thread) => thread.coordinatorThreadId !== undefined);
    if (worker?.coordinatorThreadId === undefined) throw new Error("Expected a Project worker.");
    const reports = Array.from({ length: 27 }, (_, index) => {
      const sequence = 27 - index;
      return decodeCodeProjectReport({
        workerId: worker.id,
        operationId: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
        sequence,
        title: worker.title,
        state: "completed",
        summary: `Result ${sequence}`,
        updatedAt: worker.updatedAt,
      });
    });
    const newest = reports[0];
    const boundary = reports[24];
    const shifted = reports[25];
    const oldest = reports[26];
    if (!newest || !boundary || !shifted || !oldest) throw new Error("Expected two report pages.");
    let visible = reports;
    const execute = vi.fn<typeof client.execute>(async (command) => {
      if (command.kind !== "read-code-project-report-page")
        throw new Error("Expected a report read.");
      const before = command.before;
      const remaining = visible.filter(
        (row) => before === undefined || row.sequence < before.sequence,
      );
      const page = remaining.slice(0, 25);
      const last = page.at(-1);
      return {
        kind: "project-report-page",
        reports: page,
        ...(remaining.length > page.length && last
          ? { next: { sequence: last.sequence, operationId: last.operationId } }
          : {}),
      };
    });
    const onRead = vi.fn();
    const props = {
      projectId,
      conversationId: worker.coordinatorThreadId,
      client: { ...client, execute },
      reportSequence: newest.sequence,
      reportCount: visible.length,
      onRead,
      onOpen: vi.fn(),
      onOpenBeside: vi.fn(),
      threads: [],
    };
    const view = render(<CodeProjectWork {...props} />);
    expect(await screen.findByText(newest.summary)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Load earlier reports" }));
    expect(await screen.findByText(oldest.summary)).toBeVisible();
    expect(screen.getAllByText(newest.summary)).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Load earlier reports" })).toBeNull();
    expect(execute).toHaveBeenLastCalledWith(
      {
        kind: "read-code-project-report-page",
        projectId,
        before: { sequence: boundary.sequence, operationId: boundary.operationId },
      },
      expect.any(AbortSignal),
    );
    expect(screen.getByText(boundary.summary)).toBeVisible();
    visible = reports.filter((row) => row.operationId !== boundary.operationId);
    view.rerender(<CodeProjectWork {...props} reportCount={visible.length} />);
    await waitFor(() => expect(screen.queryByText(boundary.summary)).toBeNull());
    expect(screen.getByText(newest.summary)).toBeVisible();
    expect(screen.getAllByText(shifted.summary)).toHaveLength(1);
    expect(screen.getByText(oldest.summary)).toBeVisible();
    expect(execute).toHaveBeenLastCalledWith(
      {
        kind: "read-code-project-report-page",
        projectId,
        before: { sequence: shifted.sequence, operationId: shifted.operationId },
      },
      expect.any(AbortSignal),
    );
    expect(onRead.mock.calls).toEqual([[worker.coordinatorThreadId, newest.sequence]]);
  });
});
