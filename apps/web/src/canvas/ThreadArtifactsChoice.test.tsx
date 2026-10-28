import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ThreadArtifactsOffer, threadArtifactsOfferRow } from "./ThreadArtifactsChoice";

const canvasesByRow = new Map<string, ReadonlyArray<unknown>>([
  ["turn-2", [{ canvasId: "a" }]],
  ["turn-4", [{ canvasId: "b" }]],
]);
const rowKeys = ["turn-1", "turn-2", "turn-3", "turn-4"];

describe("the one-time offer of Claude artifacts in a thread", () => {
  it("sits under the thread's first Canvas until the person decides, and never after", () => {
    expect(
      threadArtifactsOfferRow({
        choosable: true,
        documentDelivery: undefined,
        rowKeys,
        canvasesByRow,
      }),
    ).toBe("turn-2");
    for (const decided of ["canvas", "native-artifacts"] as const) {
      expect(
        threadArtifactsOfferRow({
          choosable: true,
          documentDelivery: decided,
          rowKeys,
          canvasesByRow,
        }),
      ).toBeUndefined();
    }
    // An account that has not enabled them, or a thread with no Canvas yet, is not offered them.
    expect(
      threadArtifactsOfferRow({
        choosable: false,
        documentDelivery: undefined,
        rowKeys,
        canvasesByRow,
      }),
    ).toBeUndefined();
    expect(
      threadArtifactsOfferRow({
        choosable: true,
        documentDelivery: undefined,
        rowKeys,
        canvasesByRow: new Map(),
      }),
    ).toBeUndefined();
  });

  it("repeats the telemetry warning and records either answer", async () => {
    const onChoose = vi.fn();
    render(<ThreadArtifactsOffer onChoose={onChoose} pending={false} />);
    expect(screen.getByText("Use Claude artifacts for this thread instead?")).toBeVisible();
    expect(screen.getByText(/usage telemetry to Anthropic for this thread/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Use Claude artifacts" }));
    await userEvent.click(screen.getByRole("button", { name: "Keep Canvas" }));
    expect(onChoose.mock.calls).toEqual([["native-artifacts"], ["canvas"]]);
  });
});
