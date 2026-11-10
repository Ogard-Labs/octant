import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ThreadInfo, useThreadInfoAttention, useThreadInfoPanel } from "./ThreadInfo";

function PendingReview(props: { readonly pending: boolean }) {
  useThreadInfoAttention("review", props.pending);
  return <p>Saved commands</p>;
}

function OpensPanel() {
  const panel = useThreadInfoPanel();
  return (
    <button onClick={() => panel?.open()} type="button">
      Show access
    </button>
  );
}

describe("ThreadInfo", () => {
  it("says on its button that a row inside the closed panel waits for the person", () => {
    const { rerender } = render(
      <ThreadInfo>
        <PendingReview pending />
      </ThreadInfo>,
    );

    expect(screen.getByText("Saved commands")).not.toBeVisible();
    expect(screen.getByRole("button", { name: "Thread info, review required" })).toBeVisible();

    rerender(
      <ThreadInfo>
        <PendingReview pending={false} />
      </ThreadInfo>,
    );

    expect(screen.getByRole("button", { name: "Thread info" })).toBeVisible();
  });

  it("keeps its rows mounted while closed and closes on a press outside it", () => {
    render(
      <>
        <ThreadInfo>
          <PendingReview pending={false} />
        </ThreadInfo>
        <p>Transcript</p>
      </>,
    );
    const row = screen.getByText("Saved commands");

    fireEvent.click(screen.getByRole("button", { name: "Thread info" }));
    expect(row).toBeVisible();

    fireEvent.pointerDown(screen.getByText("Transcript"));
    expect(row).not.toBeVisible();
    expect(screen.getByText("Saved commands")).toBe(row);
  });

  it("opens for a control that leads to one of its rows", () => {
    render(
      <ThreadInfo>
        <OpensPanel />
      </ThreadInfo>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show access", hidden: true }));

    expect(screen.getByRole("region", { name: "Thread info" })).toBeVisible();
  });
});
