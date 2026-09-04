import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DockDocumentTool } from "./DockDocumentTool";

const threadId = "10000000-0000-4000-8000-000000000001" as never;
const checkoutId = "20000000-0000-4000-8000-000000000002" as never;

function client(text: string) {
  return {
    openFile: vi.fn(async () => ({
      status: "editable" as const,
      fileId: "30000000-0000-4000-8000-000000000003",
      metadata: {
        identity: { device: "1", inode: "2" },
        byteLength: text.length,
        modifiedNanoseconds: "1",
        digest: "a".repeat(64),
      },
      content: {
        contentId: "40000000-0000-4000-8000-000000000004",
        digest: "a".repeat(64),
        byteLength: text.length,
      },
    })),
    content: vi.fn(async () => new TextEncoder().encode(text)),
  };
}

describe("the dock Document tool", () => {
  it("reads a Markdown document the thread wrote through the host-authorized file open", async () => {
    const codeClient = client("# Handoff\n\nWhat was **done**.\n");
    render(
      <DockDocumentTool
        checkoutId={checkoutId}
        client={codeClient as never}
        path="docs/handoff.md"
        threadId={threadId}
      />,
    );
    expect(await screen.findByRole("heading", { name: "Handoff" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "docs/handoff.md" })).toBeInTheDocument();
    expect(codeClient.openFile).toHaveBeenCalledWith(threadId, checkoutId, "docs/handoff.md");
  });

  it("shows plain text as text and says why a document cannot be shown", async () => {
    render(
      <DockDocumentTool
        checkoutId={checkoutId}
        client={client("plain notes") as never}
        path="NOTES.txt"
        threadId={threadId}
      />,
    );
    expect(await screen.findByText("plain notes")).toBeInTheDocument();

    render(
      <DockDocumentTool
        client={client("unused") as never}
        path="docs/handoff.md"
        threadId={threadId}
      />,
    );
    expect(
      await screen.findByText("This thread has no checkout to read from."),
    ).toBeInTheDocument();
  });
});
