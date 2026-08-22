import { decodeThreadCheckpoint } from "@octant/contracts/thread-checkpoints";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ThreadCheckpointControls } from "./ThreadCheckpointControls";

const now = "2026-08-18T09:00:00.000Z";

const checkpoint = decodeThreadCheckpoint({
  id: "11111111-1111-4111-8111-111111111111",
  anchor: {
    mode: "chat",
    threadId: "22222222-2222-4222-8222-222222222222",
    turnId: "33333333-3333-4333-8333-333333333333",
  },
  label: "Before the rewrite",
  lifecycle: "marked",
  restoreCount: 0,
  markedAt: now,
  version: 1,
  updatedAt: now,
});

function controls(overrides: Partial<Parameters<typeof ThreadCheckpointControls>[0]> = {}) {
  const onMark = vi.fn();
  const onCancelDraft = vi.fn();
  const onRestore = vi.fn();
  render(
    <ThreadCheckpointControls
      busy={false}
      defaultLabel="Message 1"
      onCancelDraft={onCancelDraft}
      onMark={onMark}
      onRestore={onRestore}
      {...overrides}
    />,
  );
  return { onMark, onCancelDraft, onRestore };
}

describe("the checkpoint affordance on a message", () => {
  it("shows nothing on an unmarked turn until the naming form is asked for", () => {
    controls();

    expect(screen.queryByRole("button", { name: "Checkpoint" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Checkpoint name" })).not.toBeInTheDocument();
  });

  it("marks the point under the name the user typed", async () => {
    const user = userEvent.setup();
    const { onMark, onCancelDraft } = controls({ draft: "mark" });

    const field = screen.getByRole("textbox", { name: "Checkpoint name" });
    await user.clear(field);
    await user.type(field, "Green tests");
    await user.click(screen.getByRole("button", { name: "Mark" }));

    expect(onMark).toHaveBeenCalledWith("Green tests");
    expect(onCancelDraft).toHaveBeenCalledTimes(1);
  });

  it("offers no marking gesture while a checkpoint request is in flight", () => {
    controls({ busy: true, draft: "mark" });

    expect(screen.getByRole("button", { name: "Mark" })).toBeDisabled();
  });

  it("says restoring starts a new thread rather than undoing this one", async () => {
    const user = userEvent.setup();
    const { onRestore } = controls({ checkpoint, draft: "restore" });

    expect(screen.getByText("Before the rewrite")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start the new thread" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start the new thread" }));
    // An untouched name falls back to the checkpoint's own, so a restore never
    // starts a thread with no name at all.
    expect(onRestore).toHaveBeenCalledWith("Before the rewrite");
  });

  it("keeps the marker visible once a point is marked, without a Forget control", () => {
    controls({ checkpoint });

    expect(screen.getByText("Before the rewrite")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Forget" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restore from here" })).not.toBeInTheDocument();
  });

  it("says how often a point has already been taken up", () => {
    controls({
      checkpoint: decodeThreadCheckpoint({
        ...checkpoint,
        restoreCount: 2,
        lastRestoredAt: now,
      }),
    });

    expect(screen.getByText(/taken up 2 times/)).toBeInTheDocument();
  });
});
