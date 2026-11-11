import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { decodePreviewTarget } from "@octant/contracts/previews";
import { PreviewTextEditor } from "./PreviewTextEditor";
import type { PreviewClient } from "@octant/client-runtime/preview-client";

vi.mock("../code/MonacoEditorAdapter", () => ({
  MonacoEditorAdapter: (props: { value: string; onChange: (text: string) => void }) => (
    <textarea
      className="resize-none"
      aria-label="Source text"
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
    />
  ),
}));
vi.mock("../code/MonacoDiffAdapter", () => ({
  MonacoDiffAdapter: (props: { original: string; modified: string }) => (
    <pre aria-label="Comparison">
      {props.original} → {props.modified}
    </pre>
  ),
}));
const target = decodePreviewTarget({
  targetId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  hostId: "33333333-3333-4333-8333-333333333333",
  kind: "file",
  opaqueRef: "notes",
  displayName: "notes.md",
});
const ready = {
  kind: "ready" as const,
  fileKey: "c".repeat(64),
  text: "# Original\n",
  revision: "a".repeat(64),
};
function client(): PreviewClient & Required<Pick<PreviewClient, "text">> {
  return {
    open: vi.fn(),
    refresh: vi.fn(),
    readChunks: vi.fn(),
    cancel: vi.fn(),
    handoff: vi.fn(),
    text: vi.fn().mockResolvedValue(ready),
  };
}
describe("Work source editing", () => {
  it("loads full source only on request, previews a draft, saves and clears recovery", async () => {
    localStorage.clear();
    const api = client();
    render(
      <PreviewTextEditor target={target} client={api}>
        <p>Original preview</p>
      </PreviewTextEditor>,
    );
    expect(api.text).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    const editor = await screen.findByLabelText("Source text");
    fireEvent.change(editor, { target: { value: "# Changed\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Split" }));
    expect(await screen.findByRole("heading", { name: "Changed" })).toBeVisible();
    vi.mocked(api.text).mockResolvedValueOnce({
      kind: "saved",
      fileKey: ready.fileKey,
      text: "# Changed\n",
      revision: "b".repeat(64),
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved");
    expect(api.text).toHaveBeenLastCalledWith({
      target,
      change: { text: "# Changed\n", revision: ready.revision },
    });
    expect(localStorage.length).toBe(0);
  });
  it("recovers edits against a changed disk revision and requires explicit reconciliation", async () => {
    localStorage.clear();
    const api = client();
    const first = render(
      <PreviewTextEditor target={target} client={api}>
        <p>Preview</p>
      </PreviewTextEditor>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    fireEvent.change(await screen.findByLabelText("Source text"), {
      target: { value: "my draft" },
    });
    first.unmount();
    vi.mocked(api.text).mockResolvedValue({
      ...ready,
      text: "agent changes",
      revision: "b".repeat(64),
    });
    render(
      <PreviewTextEditor
        target={decodePreviewTarget({ ...target, opaqueRef: "reissued-reference" })}
        client={api}
      >
        <p>Preview</p>
      </PreviewTextEditor>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(await screen.findByLabelText("Source text")).toHaveValue("my draft");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(await screen.findByLabelText("Comparison")).toHaveTextContent(
      "agent changes → my draft",
    );
    fireEvent.click(screen.getByRole("button", { name: "Keep draft against this version" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
    await act(async () => undefined);
  });
});
