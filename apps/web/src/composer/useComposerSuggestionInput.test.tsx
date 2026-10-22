import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ThreadFollowUpSuggestions } from "@octant/contracts";
import { FollowUpSuggestionContext } from "../followUps/FollowUpSuggestionChips";
import { useComposerSuggestionInput } from "./useComposerSuggestionInput";

const threadId = "00000000-0000-4000-8000-000000000120";
const suggestionId = "00000000-0000-4000-8000-000000000141";
const turnId = "00000000-0000-4000-8000-000000000131";

function suggestions(
  target: "same-thread" | "new-thread",
  activated: ReadonlyArray<string> = [],
): ThreadFollowUpSuggestions {
  return {
    threadId,
    mode: "chat",
    suggestedBy: {
      providerInstanceId: "00000000-0000-4000-8000-000000000001",
      modelId: "claude-sonnet",
    },
    followUps: {
      turnId,
      suggestions: [
        {
          id: suggestionId,
          title: "Shorter",
          prompt: "Make the summary half as long.",
          target,
        },
      ],
    },
    activatedFollowUpIds: activated,
  } as never;
}

function Composer() {
  const [draft, setDraft] = useState("");
  const input = useComposerSuggestionInput(draft, setDraft);
  return (
    <textarea
      aria-label="Message"
      className="composer-input"
      onChange={(event) => setDraft(event.currentTarget.value)}
      onKeyDown={(event) => {
        input.takeOnTab(event);
      }}
      placeholder={input.placeholder}
      value={draft}
    />
  );
}

function renderComposer(target: "same-thread" | "new-thread") {
  let activated: ReadonlyArray<string> = [];
  const client = {
    suggestions: vi.fn(async () => suggestions(target, activated)),
    preview: vi.fn(),
    activate: vi.fn(async () => {
      activated = [suggestionId];
      return { kind: "follow-up-activated", suggestionId, created: { kind: "same-thread" } };
    }),
  };
  render(
    <FollowUpSuggestionContext
      value={{ client: client as never, threadId, mode: "chat", onCreated: vi.fn() }}
    >
      <Composer />
    </FollowUpSuggestionContext>,
  );
  return client;
}

describe("useComposerSuggestionInput", () => {
  it("shows the suggested next message in an empty composer and takes it on Tab", async () => {
    const client = renderComposer("same-thread");
    const message = screen.getByRole("textbox", { name: "Message" });
    await waitFor(() =>
      expect(message).toHaveAttribute("placeholder", "Make the summary half as long."),
    );

    message.focus();
    await userEvent.keyboard("{Tab}");

    expect(message).toHaveValue("Make the summary half as long.");
    expect(message).toHaveFocus();
    await waitFor(() =>
      expect(client.activate).toHaveBeenCalledWith(threadId, {
        turnId,
        suggestionId,
        confirmed: true,
      }),
    );
  });

  it("keeps Tab's ordinary meaning once the person has typed", async () => {
    const client = renderComposer("same-thread");
    const message = screen.getByRole("textbox", { name: "Message" });
    await waitFor(() =>
      expect(message).toHaveAttribute("placeholder", "Make the summary half as long."),
    );

    await userEvent.type(message, "Thanks");
    expect(message).toHaveAttribute("placeholder", "Reply…");
    await userEvent.keyboard("{Tab}");

    expect(message).toHaveValue("Thanks");
    expect(client.activate).not.toHaveBeenCalled();
  });

  it("offers nothing here for a suggestion that starts another thread", async () => {
    const client = renderComposer("new-thread");
    const message = screen.getByRole("textbox", { name: "Message" });
    await waitFor(() => expect(client.suggestions).toHaveBeenCalled());

    expect(message).toHaveAttribute("placeholder", "Reply…");
  });
});
