import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { UsageResumeThreadState, UtcTimestamp } from "@octant/contracts";
import { UsageLimitNotice } from "./UsageLimitNotice";

const LIMIT = {
  kind: "exhausted" as const,
  resetsAt: "2099-07-19T13:00:00.000Z" as UtcTimestamp,
};

const resume = (status: UsageResumeThreadState["status"]): UsageResumeThreadState => ({
  record: {
    threadId: "83000000-0000-4000-8000-000000000003",
    turnId: "83000000-0000-4000-8000-000000000004",
    providerInstanceId:
      "83000000-0000-4000-8000-00000000000a" as UsageResumeThreadState["record"]["providerInstanceId"],
    usageLimit: LIMIT,
    resetsAt: LIMIT.resetsAt,
    scheduledAt: "2026-07-19T12:00:00.000Z" as UtcTimestamp,
  },
  status,
});

describe("the transcript's usage-limit record", () => {
  it("is one quiet line with the provider's sentence and its reset, and no recovery offers", () => {
    render(<UsageLimitNotice limit={LIMIT} provider="Codex" />);
    const record = screen.getByTestId("usage-limit-record");
    expect(record).toHaveTextContent("Codex's usage allowance on this account is exhausted.");
    expect(record).toHaveTextContent("It resets at");
    expect(record.className).toContain("callout--row");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("says an unknown reset is unknown", () => {
    render(<UsageLimitNotice limit={{ kind: "temporary" }} provider="Codex" />);
    expect(screen.getByTestId("usage-limit-record")).toHaveTextContent(
      "The provider did not say when this clears.",
    );
  });

  it("gives a billing stop no reset", () => {
    render(
      <UsageLimitNotice limit={{ kind: "billing", resetsAt: LIMIT.resetsAt }} provider="Codex" />,
    );
    expect(screen.getByTestId("usage-limit-record")).not.toHaveTextContent("resets");
  });

  it("records a dispatched resume as having happened at the reset", () => {
    render(<UsageLimitNotice limit={LIMIT} provider="Codex" usageResume={resume("dispatched")} />);
    expect(screen.getByTestId("usage-limit-record")).toHaveTextContent("Resumed at the reset.");
  });
});
