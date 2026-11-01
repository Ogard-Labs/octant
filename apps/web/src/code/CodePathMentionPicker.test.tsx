import type { FileMentionClient } from "@octant/client-runtime";
import type { CodeCheckoutId, CodeThreadId } from "@octant/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";
import { useCodePathMentions } from "./CodePathMentionPicker";

const threadId = "00000000-0000-4000-8000-000000000911" as CodeThreadId;
const checkoutId = "00000000-0000-4000-8000-000000000912" as CodeCheckoutId;

const mentionClient: FileMentionClient = {
  complete: async () =>
    [
      { path: "src/inside.ts", kind: "file" },
      { path: "/Users/me/notes/plan.md", kind: "file" },
    ] as never,
  resolve: async () => ({ mentions: [], unavailable: [] }),
  execute: async () => ({ kind: "file-mentions-completed", candidates: [] }) as never,
};

const listingClient = {
  list: async () => ({ status: "failed" }),
  search: async () => ({ status: "failed" }),
} as never;

function Harness() {
  const mentions = useCodePathMentions({
    client: listingClient,
    mentionClient,
    threadId,
    checkoutId,
    draft: "@plan",
    onDraftChange: () => undefined,
    textarea: () => null,
  });
  useEffect(() => {
    mentions.sync("@plan", 5);
  }, []);
  return (
    <output aria-label="candidates">{mentions.candidates.map((c) => c.path).join(",")}</output>
  );
}

describe("useCodePathMentions", () => {
  it("offers a file in an extra folder by its absolute path and ignores the host's relative hits", async () => {
    render(<Harness />);

    await waitFor(() =>
      expect(screen.getByLabelText("candidates")).toHaveTextContent("/Users/me/notes/plan.md"),
    );
    expect(screen.getByLabelText("candidates")).not.toHaveTextContent("src/inside.ts");
  });
});
