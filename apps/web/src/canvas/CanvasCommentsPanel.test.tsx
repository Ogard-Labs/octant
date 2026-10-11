import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
  CanvasCommentCommand,
  CanvasCommentCommandResult,
  CanvasCommentThread,
  CanvasCommentsOutcome,
} from "@octant/contracts/canvas-board";
import { CANVAS_SCHEMA_VERSION, decodeCanvasDefinition } from "@octant/contracts/canvas";
import { settingsScreenExample, stateStoreDecisionExample } from "@octant/domain";
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

  it("names the computer a synced comment or reply was written on", async () => {
    render(
      <CanvasCommentsPanel
        author={author}
        canvasId={canvasId}
        definition={canvasFixture}
        load={async () =>
          ready([
            {
              ...existing,
              comment: {
                ...existing.comment,
                origin: {
                  kind: "replica" as const,
                  instanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                  computerName: "Studio Mac",
                },
              },
              replies: [
                {
                  replyId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as never,
                  commentId,
                  author,
                  origin: {
                    kind: "replica" as const,
                    instanceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
                    computerName: "MacBook Air",
                  },
                  body: "Yes, a queue.",
                  createdAt: "2026-08-01T21:05:00.000Z" as never,
                },
              ],
            },
          ])
        }
        send={vi.fn()}
      />,
    );
    const threads = await screen.findByRole("list", { name: "Comment threads" });
    expect(within(threads).getByText("You · Studio Mac")).toBeInTheDocument();
    expect(within(threads).getByText("You · MacBook Air")).toBeInTheDocument();
  });

  it("anchors a comment to a comparison matrix's option column or criterion row", async () => {
    const definition = decodeCanvasDefinition({
      ...canvasFixture,
      blocks: [stateStoreDecisionExample],
    });
    const onMatrix = (nodeId: string, id: string): CanvasCommentThread => ({
      comment: {
        ...existing.comment,
        commentId: id as never,
        anchor: {
          kind: "node",
          blockId: stateStoreDecisionExample.blockId as never,
          nodeId: nodeId as never,
        },
        body: `About ${nodeId}`,
      },
      replies: [],
    });
    render(
      <CanvasCommentsPanel
        author={author}
        canvasId={canvasId}
        definition={definition}
        load={async () =>
          ready([
            onMatrix("sqlite", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2"),
            onMatrix("operations", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3"),
          ])
        }
        send={vi.fn()}
      />,
    );
    const threads = await screen.findByRole("list", { name: "Comment threads" });
    expect(within(threads).getByText("Option · SQLite")).toBeInTheDocument();
    expect(within(threads).getByText("Criterion · Operational cost")).toBeInTheDocument();
  });

  it("anchors a comment to a mockup's numbered callout", async () => {
    const definition = decodeCanvasDefinition({
      ...canvasFixture,
      blocks: [settingsScreenExample],
    });
    const onCallout: CanvasCommentThread = {
      comment: {
        ...existing.comment,
        commentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4" as never,
        anchor: {
          kind: "node",
          blockId: settingsScreenExample.blockId as never,
          nodeId: "save" as never,
        },
        body: "Should Save stay enabled?",
      },
      replies: [],
    };
    render(
      <CanvasCommentsPanel
        author={author}
        canvasId={canvasId}
        definition={definition}
        load={async () => ready([onCallout])}
        send={vi.fn()}
      />,
    );
    const threads = await screen.findByRole("list", { name: "Comment threads" });
    expect(within(threads).getByText("Callout 2 · Save")).toBeInTheDocument();
  });

  it("names a row comment by its row, keeps one whose row is gone as outdated, and adds to the focused row", async () => {
    const user = userEvent.setup();
    const definition = decodeCanvasDefinition({
      ...canvasFixture,
      blocks: [
        {
          blockId: "vendors",
          schemaVersion: CANVAS_SCHEMA_VERSION,
          kind: "table",
          columns: [
            { id: "vendor", label: "Vendor", type: "text" },
            { id: "price", label: "Price", type: "number" },
          ],
          rows: [
            { id: "acme", cells: ["Acme", 12] },
            { id: "globex", cells: ["Globex", 9] },
            ["Initech", 30],
          ],
        },
      ],
    });
    const onRow = (rowId: string, id: string, body: string): CanvasCommentThread => ({
      comment: {
        ...existing.comment,
        commentId: id as never,
        anchor: { kind: "row", blockId: "vendors" as never, rowId: rowId as never },
        body,
      },
      replies: [],
    });
    const load = vi.fn(async () =>
      ready([
        onRow("acme", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab1", "Is this the list price?"),
        onRow("globex", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab2", "Globex is cheaper"),
        onRow("hooli", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab3", "Hooli dropped out"),
      ]),
    );
    const send = vi.fn<(command: CanvasCommentCommand) => Promise<CanvasCommentCommandResult>>(
      async () => ({ kind: "accepted", canvasId, sequence: 4 }),
    );
    const { rerender } = render(
      <CanvasCommentsPanel
        author={author}
        canvasId={canvasId}
        definition={definition}
        load={load}
        send={send}
      />,
    );
    const threads = await screen.findByRole("list", { name: "Comment threads" });
    expect(within(threads).getByText("Row · Acme")).toBeInTheDocument();
    const gone = within(threads).getByText("Hooli dropped out").closest("li");
    expect(gone).toHaveAttribute("data-outdated", "true");
    expect(within(gone as HTMLElement).getByText("No longer on the canvas")).toBeInTheDocument();
    // A row without an id is not offered as an anchor.
    expect(screen.queryByRole("option", { name: "Row · Initech" })).toBeNull();

    rerender(
      <CanvasCommentsPanel
        author={author}
        canvasId={canvasId}
        definition={definition}
        focusedBlockId="vendors"
        focusedRowId="globex"
        load={load}
        send={send}
      />,
    );
    expect(screen.getByText("On Row · Globex")).toBeInTheDocument();
    expect(screen.getByText("Globex is cheaper")).toBeInTheDocument();
    expect(screen.queryByText("Is this the list price?")).toBeNull();
    await user.type(screen.getByLabelText("New comment"), "Ask for a quote");
    await user.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      kind: "canvas-comment-add",
      anchor: { kind: "row", blockId: "vendors", rowId: "globex" },
    });
  });

  it("withholds the composer when the focused row left the canvas instead of commenting elsewhere", async () => {
    const definition = decodeCanvasDefinition({
      ...canvasFixture,
      blocks: [
        {
          blockId: "vendors",
          schemaVersion: CANVAS_SCHEMA_VERSION,
          kind: "table",
          columns: [{ id: "vendor", label: "Vendor", type: "text" }],
          rows: [{ id: "acme", cells: ["Acme"] }],
        },
      ],
    });
    const { rerender } = render(
      <CanvasCommentsPanel
        author={author}
        canvasId={canvasId}
        definition={definition}
        focusedBlockId="vendors"
        focusedRowId="hooli"
        load={async () => ready()}
        send={vi.fn()}
      />,
    );
    await screen.findByText("No comments yet.");
    expect(screen.getByText("On No longer on the canvas")).toBeInTheDocument();
    expect(screen.queryByLabelText("New comment")).toBeNull();

    rerender(
      <CanvasCommentsPanel
        author={author}
        canvasId={canvasId}
        definition={definition}
        load={async () => ready()}
        send={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("New comment")).toBeInTheDocument();
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
