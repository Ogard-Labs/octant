import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { loginSequenceBlock, orderStateBlock } from "@octant/domain";
import { CanvasCommentsPanel } from "../CanvasCommentsPanel";
import { CanvasDocument } from "../CanvasDocument";
import { canvasFixture } from "../test-fixtures";

const canvasId = "11111111-1111-4111-8111-111111111111" as never;
const author = {
  kind: "local-user" as const,
  actorId: "88888888-8888-4888-8888-888888888888" as never,
};

describe("sequence and state diagrams", () => {
  it("draws a login sequence and an order state machine a reader can name", () => {
    render(
      <CanvasDocument
        definition={{
          ...canvasFixture,
          blocks: [loginSequenceBlock, orderStateBlock],
        }}
      />,
    );

    expect(screen.getByRole("figure", { name: /Sequence with 3 participants/ })).toBeVisible();
    expect(screen.getByText("Person")).toBeVisible();
    expect(screen.getByText("Paid")).toBeVisible();
    expect(screen.getByRole("figure", { name: /State machine with 8 states/ })).toBeVisible();
    expect(document.querySelector("[data-edge-id='submit'] title")?.textContent).toBe(
      "Submit credentials",
    );
    expect(document.querySelector("[data-node-id='paid']")).not.toBeNull();
  });

  it("offers sequence messages and state nodes as comment anchors", async () => {
    const user = userEvent.setup();
    render(
      <CanvasCommentsPanel
        author={author}
        canvasId={canvasId}
        definition={{
          ...canvasFixture,
          blocks: [loginSequenceBlock, orderStateBlock],
        }}
        load={async () => ({ kind: "ready", canvasId, sequence: 0, threads: [] })}
        send={vi.fn()}
      />,
    );

    await user.click(await screen.findByRole("combobox", { name: "Comment anchor" }));
    expect(
      await screen.findByRole("option", { name: "Sequence · Submit credentials" }),
    ).toBeVisible();
    expect(screen.getByRole("option", { name: "State · Paid" })).toBeVisible();
  });
});
