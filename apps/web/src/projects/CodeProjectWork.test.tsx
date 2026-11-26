import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
      revision: 1,
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
    view.rerender(<CodeProjectWork {...props} revision={2} threads={[row]} />);
    await waitFor(() => expect(client.execute).toHaveBeenCalledTimes(2));
    expect(screen.getAllByText(summary)).toHaveLength(1);
    expect(screen.getByText(/Needs you \(0\)/)).toBeVisible();
  });
});
