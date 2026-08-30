import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { FileMentionClient } from "@octant/client-runtime";
import type { WorkThreadId } from "@octant/contracts";
import { useWorkFileMentions } from "./useWorkFileMentions";

const threadId = "10000000-0000-4000-8000-000000000101" as WorkThreadId;
const fileMentionClient: FileMentionClient = {
  complete: async () => [],
  resolve: async () => ({ mentions: [], unavailable: [] }),
  execute: async () => ({ kind: "file-mentions-completed", candidates: [] }) as never,
};

function Harness() {
  const [draft, setDraft] = useState("@first");
  const mentions = useWorkFileMentions({
    client: fileMentionClient,
    draft,
    onDraftChange: (next) => setDraft(next),
    textarea: () => null,
    threadId,
  });
  return (
    <div>
      <button onClick={() => mentions.sync(draft, draft.length)} type="button">
        open
      </button>
      <button onClick={() => mentions.choose({ kind: "file", path: "first.md" })} type="button">
        choose
      </button>
      <button onClick={mentions.clear} type="button">
        clear
      </button>
      <button onClick={() => mentions.restore(["first.md"])} type="button">
        restore
      </button>
      <output aria-label="paths">{mentions.selectedPaths.join(",")}</output>
      <output aria-label="draft">{draft}</output>
    </div>
  );
}

describe("useWorkFileMentions", () => {
  it("restores captured paths when their send is refused", () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "open" }));
    fireEvent.click(screen.getByRole("button", { name: "choose" }));
    fireEvent.click(screen.getByRole("button", { name: "clear" }));
    fireEvent.click(screen.getByRole("button", { name: "restore" }));

    expect(screen.getByLabelText("paths")).toHaveTextContent("first.md");
  });
});
