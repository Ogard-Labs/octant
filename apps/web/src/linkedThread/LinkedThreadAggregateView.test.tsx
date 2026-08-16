import type { LinkedThreadAggregate } from "@octant/contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LinkedThreadAggregateView } from "./LinkedThreadAggregateView";

const aggregate = {
  aggregateId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  requestId: "33333333-3333-4333-8333-333333333333",
  receiptId: "55555555-5555-4555-8555-555555555555",
  previewId: "66666666-6666-4666-8666-666666666666",
  sourceThreadId: "11111111-1111-4111-8111-111111111111",
  skillName: "review-in-parallel",
  requestedCount: 2,
  status: "partial",
  results: [
    {
      targetIndex: 1,
      label: "Reviewer 1",
      status: "created",
      threadId: "22222222-2222-4222-8222-222222222222",
      resultRefId: "linked-thread:22222222-2222-4222-8222-222222222222",
    },
    {
      targetIndex: 2,
      label: "Reviewer 2",
      status: "rejected",
      reason: "Provider capacity unavailable.",
    },
  ],
  createdAt: "2026-08-02T12:00:00.000Z",
  updatedAt: "2026-08-02T12:00:05.000Z",
} as unknown as LinkedThreadAggregate;

describe("LinkedThreadAggregateView", () => {
  it("renders aggregate status and per-thread links without collapsing to all-or-nothing", () => {
    render(<LinkedThreadAggregateView aggregate={aggregate} />);
    expect(screen.getByRole("status", { name: "Aggregate status" })).toHaveTextContent("Partial");
    expect(screen.getByRole("link", { name: "Reviewer 1" })).toHaveAttribute(
      "href",
      "/threads/22222222-2222-4222-8222-222222222222",
    );
    expect(screen.getByText("Provider capacity unavailable.")).toBeInTheDocument();
  });
});
