import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
  CanvasCommentCommand,
  CanvasCommentCommandResult,
  CanvasCommentThread,
  CanvasCommentsOutcome,
} from "@octant/contracts/canvas-board";
import { CanvasCommentsPanel } from "./CanvasCommentsPanel";
import { canvasFixture } from "./test-fixtures";

const canvasId = "11111111-1111-4111-8111-111111111111" as never;
const author = {
  kind: "local-user" as const,
  actorId: "88888888-8888-4888-8888-888888888888" as never,
};
const commentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1" as never;

function ready(
  threads: ReadonlyArray<CanvasCommentThread> = [],
  sequence = threads.length,
): CanvasCommentsOutcome {
  return { kind: "ready", canvasId, sequence, threads };
}

const existing: CanvasCommentThread = {
  comment: {
    commentId,
    anchor: { kind: "node" as const, blockId: "diagram-1" as never, nodeId: "b" as never },
    author,
    origin: { kind: "remote-device" as const, deviceId: "phone-1" },
    body: "Should Report be a queue?",
    createdAt: "2026-08-01T21:00:00.000Z" as never,
  },
  replies: [],
};

describe("CanvasCommentsPanel", () => {
  it("shows each comment with what it is on and where it came from", async () => {
    render(
      <CanvasCommentsPanel
        author={author}
        canvasId={canvasId}
        definition={canvasFixture}
        load={async () => ready([existing])}
        send={vi.fn()}
      />,
    );
    const threads = await screen.findByRole("list", { name: "Comment threads" });
    expect(within(threads).getByText("Should Report be a queue?")).toBeInTheDocument();
    expect(within(threads).getByText("Board · Report")).toBeInTheDocument();
    expect(within(threads).getByText("You · paired device")).toBeInTheDocument();
  });

  it("adds a comment on the chosen anchor against the sequence it saw, then reloads", async () => {
    const user = userEvent.setup();
    const load = vi.fn(async () => ready());
    const send = vi.fn<(command: CanvasCommentCommand) => Promise<CanvasCommentCommandResult>>(
      async () => ({ kind: "accepted", canvasId, sequence: 1 }),
    );
    render(
      <CanvasCommentsPanel
        author={author}
        canvasId={canvasId}
        definition={canvasFixture}
        load={load}
        send={send}
      />,
    );
    await screen.findByText("No comments yet.");
    await user.type(screen.getByLabelText("New comment"), "Tighten the title");
    await user.click(screen.getByRole("button", { name: "Comment" }));

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      kind: "canvas-comment-add",
      canvasId,
      author,
      body: "Tighten the title",
      expectedSequence: 0,
      anchor: { kind: "block", blockId: canvasFixture.blocks[0]?.blockId },
    });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("New comment")).toHaveValue("");
  });

  it("explains a comment that lost the race and reloads instead of pretending it landed", async () => {
    const user = userEvent.setup();
    const load = vi.fn(async () => ready([existing], 1));
    const send = vi.fn<(command: CanvasCommentCommand) => Promise<CanvasCommentCommandResult>>(
      async () => ({
        kind: "denied",
        denialCode: "stale-version",
        message: "Canvas comments changed on the host; reload and try again.",
      }),
    );
    render(
      <CanvasCommentsPanel
        author={author}
        canvasId={canvasId}
        definition={canvasFixture}
        load={load}
        send={send}
      />,
    );
    await screen.findByRole("list", { name: "Comment threads" });
    await user.click(screen.getByRole("button", { name: "Resolve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/changed on the host/);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      kind: "canvas-comment-resolve",
      commentId,
      expectedSequence: 1,
    });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });

  it("shows nothing at all to a workspace the host does not authorize", async () => {
    const load = vi.fn(
      async (): Promise<CanvasCommentsOutcome> => ({ kind: "unauthorized", canvasId }),
    );
    const { container } = render(
      <CanvasCommentsPanel
        author={author}
        canvasId={canvasId}
        definition={canvasFixture}
        load={load}
        send={vi.fn()}
      />,
    );
    await waitFor(() => expect(load).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
