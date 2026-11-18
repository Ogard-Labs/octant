import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CodeTurnReviewPreview } from "@octant/contracts";
import { CodeTurnReviewPreviewCard } from "./CodeTurnReviewPreviewCard";

const preview = {
  explanation: "Checkout changes since this turn’s starting capture.",
  capture: {
    final: false,
    version: 3,
    capturedAt: "2026-11-15T19:04:29.000Z",
    baseline: "32962ea0aaaa",
    changedFiles: { total: 0, files: [] },
    diff: {},
  },
} as unknown as CodeTurnReviewPreview;

describe("the checkout capture notes", () => {
  it("fold into one closed line instead of reading as part of the answer", () => {
    const { container } = render(<CodeTurnReviewPreviewCard preview={preview} settled />);
    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(container.querySelectorAll("details")).toHaveLength(1);
    expect(details?.querySelector("summary")).toHaveTextContent(/^Checkout capture · /);
    expect(screen.getByText(/Checkout changes since start tree 32962ea0/).closest("details")).toBe(
      details,
    );
    expect(screen.getByText(/A final comparison was not captured/).closest("details")).toBe(
      details,
    );
  });
});
