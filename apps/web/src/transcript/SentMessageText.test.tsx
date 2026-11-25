import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  ThreadReferencesContext,
  type ThreadReferences,
} from "../threadReferences/ThreadReferences";
import { SentMessageText } from "./SentMessageText";

const references: ThreadReferences = {
  find: (threadId) =>
    threadId === "thread-1"
      ? { mode: "code", thread: { threadId, title: "Roadmap" }, projectName: "octant" }
      : undefined,
};

function renderMessage(text: string, threadMentionIds?: ReadonlyArray<string>) {
  return render(
    <ThreadReferencesContext.Provider value={references}>
      <SentMessageText text={text} threadMentionIds={threadMentionIds} />
    </ThreadReferencesContext.Provider>,
  );
}

describe("SentMessageText", () => {
  it("shows a mentioned thread as its chip where the message named it", async () => {
    const { container } = renderMessage("Continue from #[Roadmap] today", ["thread-1"]);

    expect(
      await screen.findByRole("button", { name: "Thread: Roadmap, Code, octant" }),
    ).toBeVisible();
    expect(container.querySelector("p")).toHaveTextContent("Continue from Roadmap today");
  });

  it("keeps the message's own text when it recorded no mention", () => {
    const { container } = renderMessage("Continue from #[Roadmap] today");
    expect(container).toHaveTextContent("Continue from #[Roadmap] today");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("keeps the text of a mentioned thread this window does not list", () => {
    const { container } = renderMessage("Continue from #[Elsewhere]", ["thread-2"]);
    expect(container).toHaveTextContent("Continue from #[Elsewhere]");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
