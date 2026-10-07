import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HarnessRetryStatus, type HarnessRetryStreamEvent } from "./HarnessRetryStatus";

const announcedAt = "2026-10-06T12:00:00.000Z";
const announcedMs = Date.parse(announcedAt);

function retry(attempt: number, delayMs: number, at: string): HarnessRetryStreamEvent {
  return {
    kind: "retrying",
    attempt,
    maxAttempts: 5,
    delayMs,
    reason: "unavailable",
    announcedAt: at,
  };
}

describe("the transcript working indicator during an endpoint retry", () => {
  it("shows a retry, replaces it with the next retry, counts the wait down, and clears when content arrives", () => {
    const first = retry(2, 4_000, announcedAt);
    const secondAt = new Date(announcedMs + 4_000).toISOString();
    const second = retry(3, 2_000, secondAt);
    const { rerender } = render(<HarnessRetryStatus events={[first]} nowMs={announcedMs} />);
    expect(screen.getByRole("status")).toHaveTextContent("Provider busy, retrying 2/5 in 4 s");

    rerender(<HarnessRetryStatus events={[first]} nowMs={announcedMs + 1_000} />);
    expect(screen.getByRole("status")).toHaveTextContent("Provider busy, retrying 2/5 in 3 s");

    rerender(<HarnessRetryStatus events={[first, second]} nowMs={announcedMs + 4_000} />);
    expect(screen.getByRole("status")).toHaveTextContent("Provider busy, retrying 3/5 in 2 s");

    rerender(
      <HarnessRetryStatus
        events={[first, second, { kind: "content" }]}
        nowMs={announcedMs + 5_000}
      />,
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
