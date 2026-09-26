import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ThreadFollowUpSuggestions } from "@octant/contracts";
import { FollowUpSuggestionChips } from "./FollowUpSuggestionChips";

const threadId = "00000000-0000-4000-8000-000000000020";
const suggestionId = "00000000-0000-4000-8000-000000000041";
const turnId = "00000000-0000-4000-8000-000000000031";

function suggestions(activated: ReadonlyArray<string> = []): ThreadFollowUpSuggestions {
  return {
    threadId,
    mode: "code",
    suggestedBy: {
      providerInstanceId: "00000000-0000-4000-8000-000000000001",
      modelId: "claude-sonnet",
    },
    followUps: {
      turnId,
      suggestions: [
        {
          id: suggestionId,
          title: "Add tests",
          prompt: "Write tests for nested lists in the parser.",
          target: "new-worktree",
        },
      ],
    },
    activatedFollowUpIds: activated,
  } as never;
}

const created = {
  kind: "new-worktree",
  mode: "code",
  projectId: "00000000-0000-4000-8000-0000000000bb",
  title: "Add tests",
  threadId: "00000000-0000-4000-8000-000000000099",
} as const;

describe("FollowUpSuggestionChips", () => {
  it("previews a suggestion and creates nothing until the person starts it", async () => {
    let activated: ReadonlyArray<string> = [];
    const client = {
      suggestions: vi.fn(async () => suggestions(activated)),
      preview: vi.fn(async () => ({
        suggestion: suggestions().followUps.suggestions[0]!,
        wouldCreate: {
          kind: "new-worktree",
          mode: "code",
          projectId: created.projectId,
          title: "Add tests",
        },
      })),
      activate: vi.fn(async () => {
        activated = [suggestionId];
        return { kind: "follow-up-activated", suggestionId, created };
      }),
    };
    const onCreated = vi.fn();
    render(
      <FollowUpSuggestionChips
        client={client as never}
        mode="code"
        onCreated={onCreated}
        threadId={threadId}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Add tests" }));
    expect(await screen.findByText(/starts a new Code thread on its own worktree/)).toBeVisible();
    expect(client.activate).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(client.activate.mock.calls[0]).toEqual([
      threadId,
      { turnId, suggestionId, confirmed: true },
    ]);
    expect(onCreated).toHaveBeenCalledWith({
      mode: "code",
      created,
      prompt: "Write tests for nested lists in the parser.",
    });
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: "Suggested follow-ups" })).toBeNull(),
    );
  });

  it("says why the host refused a suggestion and keeps the chips", async () => {
    const client = {
      suggestions: vi.fn(async () => suggestions()),
      preview: vi.fn(async () => ({
        kind: "follow-up-refused",
        suggestionId,
        reason: "target-unavailable",
        message: "The follow-up was refused: target-unavailable.",
      })),
      activate: vi.fn(),
    };
    render(
      <FollowUpSuggestionChips
        client={client as never}
        mode="work"
        onCreated={vi.fn()}
        threadId={threadId}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Add tests" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("target-unavailable");
    expect(screen.getByRole("button", { name: "Add tests" })).toBeVisible();
  });

  it("stays out of the composer when the latest reply suggested nothing", async () => {
    const client = {
      suggestions: vi.fn(async () => null),
      preview: vi.fn(),
      activate: vi.fn(),
    };
    const { container } = render(
      <FollowUpSuggestionChips
        client={client as never}
        mode="chat"
        onCreated={vi.fn()}
        threadId={threadId}
      />,
    );
    await waitFor(() => expect(client.suggestions).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
