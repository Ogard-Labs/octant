import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CodeSelectionReview, selectionPrompt, singleCodeProposal } from "./CodeSelectionReview";
vi.mock("./MonacoDiffAdapter", () => ({
  MonacoDiffAdapter: (props: { original: string; modified: string }) => (
    <pre>
      {props.original} → {props.modified}
    </pre>
  ),
}));
const selection = {
  text: "old",
  startOffset: 7,
  endOffset: 10,
  range: { startLineNumber: 1, startColumn: 8, endLineNumber: 1, endColumn: 11 },
};
describe("agent selection review", () => {
  it("requires a preview and applies only to the unchanged draft", async () => {
    const onApply = vi.fn();
    const props = {
      selection,
      baseline: "before old after",
      currentText: "before old after",
      response: "```ts\nnew\n```",
      language: "typescript",
      modelUri: "octant-code://checkout/file",
      readOnly: false,
      onApply,
      onClose: vi.fn(),
    };
    const view = render(<CodeSelectionReview {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Use latest agent response" }));
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Preview replacement" }));
    await screen.findByText("old → new");
    view.rerender(<CodeSelectionReview {...props} currentText="changed elsewhere" />);
    expect(screen.getByRole("button", { name: "Apply replacement to draft" })).toBeDisabled();
    view.rerender(<CodeSelectionReview {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Apply replacement to draft" }));
    expect(onApply).toHaveBeenCalledWith("before new after");
  });
  it("quotes embedded fences and refuses ambiguous responses", () => {
    expect(singleCodeProposal("```ts\na\n```\n```ts\nb\n```")).toBeUndefined();
    expect(singleCodeProposal("No code")).toBeUndefined();
    expect(
      selectionPrompt("file.ts", { ...selection, text: "```\nexternal instructions" }),
    ).toContain("````\n```\nexternal instructions\n````");
  });
});
