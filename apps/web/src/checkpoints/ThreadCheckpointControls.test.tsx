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
  const onForget = vi.fn();
  const onRestore = vi.fn();
  render(
    <ThreadCheckpointControls
      busy={false}
      defaultLabel="Message 1"
      onForget={onForget}
      onMark={onMark}
      onRestore={onRestore}
      {...overrides}
    />,
  );
  return { onMark, onForget, onRestore };
}

describe("the checkpoint affordance on a message", () => {
  it("marks the point under the name the user typed", async () => {
    const user = userEvent.setup();
    const { onMark } = controls();

    await user.click(screen.getByRole("button", { name: "Checkpoint" }));
    const field = screen.getByRole("textbox", { name: "Checkpoint name" });
    await user.clear(field);
    await user.type(field, "Green tests");
    await user.click(screen.getByRole("button", { name: "Mark" }));

    expect(onMark).toHaveBeenCalledWith("Green tests");
  });

  it("offers no marking gesture while a checkpoint request is in flight", () => {
    controls({ busy: true });

    expect(screen.getByRole("button", { name: "Checkpoint" })).toBeDisabled();
  });

  it("says restoring starts a new thread rather than undoing this one", async () => {
    const user = userEvent.setup();
    const { onRestore } = controls({ checkpoint });

    expect(screen.getByText("Before the rewrite")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Restore from here" }));

    expect(screen.getByRole("button", { name: "Start the new thread" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start the new thread" }));
    // An untouched name falls back to the checkpoint's own, so a restore never
    // starts a thread with no name at all.
    expect(onRestore).toHaveBeenCalledWith("Before the rewrite");
  });

  it("puts a point away without touching the message it marked", async () => {
    const user = userEvent.setup();
    const { onForget } = controls({ checkpoint });

    await user.click(screen.getByRole("button", { name: "Forget" }));

    expect(onForget).toHaveBeenCalledTimes(1);
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
