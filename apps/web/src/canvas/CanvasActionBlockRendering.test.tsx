import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { decodeCanvasForRender } from "./canvasRuntime";
import { CanvasView } from "./CanvasView";
import { canvasFixture, openSourceActionFixture } from "./test-fixtures";
import type { CanvasActionRuntime } from "./canvasActionRuntime";

/**
 * Canvas D: an action block is now a member of the definition union, so a
 * canvas can declare an action and the workspace can offer it. These cases
 * pin the two halves that were previously disconnected — the definition
 * validates with an action block, and the rendered control dispatches through
 * the host runtime.
 */

function canvasWithAction() {
  return {
    ...canvasFixture,
    blocks: [...canvasFixture.blocks, openSourceActionFixture],
  };
}

function runtime(overrides: Partial<CanvasActionRuntime> = {}): CanvasActionRuntime {
  return {
    availability: () => ({
      state: "available",
      capability: { effect: "read", requiresApproval: false },
      requiresApproval: false,
    }),
    onExecute: vi.fn().mockResolvedValue({
      kind: "accepted",
      receipt: { outcome: "completed" },
    }),
    ...overrides,
  } as CanvasActionRuntime;
}

describe("Canvas action blocks", () => {
  it("accepts a definition carrying an action block", () => {
    const gate = decodeCanvasForRender(canvasWithAction());

    expect(gate.ok).toBe(true);
  });

  it("offers no action control when the workspace supplies no runtime", () => {
    render(<CanvasView input={canvasWithAction()} />);

    expect(screen.queryByRole("group", { name: openSourceActionFixture.label })).toBeNull();
  });

  it("renders a declared action and dispatches it through the host runtime", async () => {
    const user = userEvent.setup();
    const actionRuntime = runtime();
    render(<CanvasView input={canvasWithAction()} actionRuntime={actionRuntime} />);

    const control = screen.getByRole("button", { name: new RegExp(openSourceActionFixture.label) });
    await user.click(control);

    expect(actionRuntime.onExecute).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Done.")).toBeVisible();
  });

  it("keeps a denied action visibly unavailable with a safe reason", async () => {
    const onExecute = vi.fn();
    const actionRuntime = runtime({
      availability: () =>
        ({
          state: "unauthorized",
          capability: { effect: "read", requiresApproval: false },
          requiresApproval: false,
          reason: "This action is not available here.",
        }) as unknown as ReturnType<CanvasActionRuntime["availability"]>,
      onExecute,
    });
    const user = userEvent.setup();
    render(<CanvasView input={canvasWithAction()} actionRuntime={actionRuntime} />);

    await user.click(
      screen.getByRole("button", { name: new RegExp(openSourceActionFixture.label) }),
    );

    expect(onExecute).not.toHaveBeenCalled();
    expect(screen.getByText("This action is not available here.")).toBeVisible();
  });

  it("keeps action blocks out of the document flow so content reads as content", () => {
    render(<CanvasView input={canvasWithAction()} actionRuntime={runtime()} />);

    expect(document.querySelector('[data-block-kind="action"]')).toBeNull();
    expect(screen.getByRole("region", { name: "Canvas actions" })).toBeVisible();
  });
});
