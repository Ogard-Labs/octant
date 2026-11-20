import { decodeTurnLoopNotice, decodeTurnStallNotice } from "@octant/contracts";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TurnLoopStallNotice } from "./TurnLoopStallNotice";

const occurredAt = "2026-11-19T12:00:00.000Z";

describe("TurnLoopStallNotice", () => {
  it("shows a quiet loop notice line with a working Stop button while the turn runs", async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();
    render(
      <TurnLoopStallNotice
        loopNotice={decodeTurnLoopNotice({
          kind: "turn-loop-noticed",
          toolName: "octant_read",
          count: 6,
          occurredAt,
        })}
        onStop={onStop}
        running
      />,
    );

    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("Repeated octant_read 6 times in a row with the same input.");
    const stop = screen.getByRole("button", { name: "Stop" });
    await user.click(stop);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("shows a quiet stall notice line with a working Stop button while the turn runs and hides Stop once settled", async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();
    const stallNotice = decodeTurnStallNotice({
      kind: "turn-stall-noticed",
      idleMs: 30 * 60_000,
      occurredAt,
    });
    const { rerender } = render(
      <TurnLoopStallNotice onStop={onStop} running stallNotice={stallNotice} />,
    );

    expect(screen.getByRole("note")).toHaveTextContent(
      "No activity from the provider for 30 minutes.",
    );
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalledTimes(1);

    rerender(<TurnLoopStallNotice onStop={onStop} running={false} stallNotice={stallNotice} />);
    expect(screen.getByRole("note")).toHaveTextContent(
      "No activity from the provider for 30 minutes.",
    );
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
  });

  it("renders a Strict loop stop as a quiet line without a Stop button", () => {
    render(
      <TurnLoopStallNotice
        loopNotice={decodeTurnLoopNotice({
          kind: "turn-loop-stopped",
          toolName: "Read",
          count: 6,
          occurredAt,
        })}
        onStop={vi.fn()}
        running={false}
      />,
    );

    expect(screen.getByRole("note")).toHaveTextContent(
      "Stopped under Strict after Read ran 6 times in a row with the same input.",
    );
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
  });
});
