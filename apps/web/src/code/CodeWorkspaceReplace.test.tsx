import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CodeWorkspaceReplace } from "./CodeWorkspaceReplace";
import { createEditorDraftStore } from "../editor/editorDraftStore";
import {
  decodeCodeCheckoutId,
  decodeCodeThreadId,
  decodeCodeFileMetadata,
  decodeCodeProjectFilePath,
  decodeCodeFileId,
} from "@octant/contracts";
const threadId = decodeCodeThreadId("10000000-0000-4000-8000-000000000001");
const checkoutId = decodeCodeCheckoutId("20000000-0000-4000-8000-000000000001");
const fileId = decodeCodeFileId("30000000-0000-4000-8000-000000000001");
const metadata = decodeCodeFileMetadata({
  identity: { device: "1", inode: "2" },
  byteLength: 7,
  modifiedNanoseconds: "123",
  digest: "a".repeat(64),
});
function fixture() {
  const drafts = createEditorDraftStore(`replace-${crypto.randomUUID()}`);
  const client = {
    openFile: vi.fn(async () => ({
      status: "editable" as const,
      fileId,
      metadata,
      content: { contentId: "content" as never, digest: metadata.digest, byteLength: 7 },
    })),
    content: vi.fn(async () => new TextEncoder().encode("old OLD")),
    save: vi.fn(async () => ({ status: "completed" as const, metadata })),
  };
  const matches = [
    {
      scope: "content" as const,
      fileId,
      path: decodeCodeProjectFilePath("a.ts"),
      line: 1,
      column: 1,
      preview: "old OLD",
    },
  ];
  const props = {
    client,
    drafts,
    threadId,
    checkoutId,
    matches,
    query: "old",
    truncated: false,
    readOnly: false,
  };
  return { props, client, drafts };
}
describe("reviewed workspace replacement", () => {
  it("previews literal replacement and saves using the reviewed identity and digest", async () => {
    const f = fixture();
    render(<CodeWorkspaceReplace {...f.props} />);
    fireEvent.click(screen.getByText("Replace in matching files"));
    fireEvent.change(screen.getByLabelText("Replacement text"), { target: { value: "$&" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview replacements" }));
    await screen.findByText("a.ts · 2 replacements");
    expect(f.client.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save reviewed replacements" }));
    await screen.findByText("Saved replacements in 1 files.");
    expect(f.client.save).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "$& $&",
        expectedIdentity: metadata.identity,
        expectedDigest: metadata.digest,
      }),
    );
  });
  it("refuses an unsaved draft appearing after review and does not save in Plan", async () => {
    const f = fixture();
    const view = render(<CodeWorkspaceReplace {...f.props} />);
    fireEvent.click(screen.getByText("Replace in matching files"));
    fireEvent.click(screen.getByRole("button", { name: "Preview replacements" }));
    await screen.findByText("a.ts · 2 replacements");
    view.rerender(<CodeWorkspaceReplace {...f.props} readOnly />);
    expect(screen.getByRole("button", { name: "Save reviewed replacements" })).toBeDisabled();
    view.rerender(<CodeWorkspaceReplace {...f.props} />);
    f.drafts.write(`octant-code://${checkoutId}/${fileId}`, "a concurrent draft");
    fireEvent.click(screen.getByRole("button", { name: "Save reviewed replacements" }));
    await screen.findByText(/An affected file has an unsaved draft/);
    expect(f.client.save).not.toHaveBeenCalled();
  });
});
