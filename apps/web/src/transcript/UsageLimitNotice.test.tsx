import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { UsageResumeThreadState, UtcTimestamp } from "@octant/contracts";
import { UsageLimitNotice } from "./UsageLimitNotice";

const LIMIT = {
  kind: "exhausted" as const,
  resetsAt: "2099-07-19T13:00:00.000Z" as UtcTimestamp,
};

const armedResume = (status: UsageResumeThreadState["status"]): UsageResumeThreadState => ({
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

describe("the usage-limit notice", () => {
  it("offers to hide the thread until the reset and dispatches that choice", () => {
    const onSnoozeAtReset = vi.fn();
    render(
      <UsageLimitNotice
        limit={LIMIT}
        provider="Codex"
        resumable={true}
        onSnoozeAtReset={onSnoozeAtReset}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Snooze until reset" }));
    expect(onSnoozeAtReset).toHaveBeenCalledTimes(1);
  });

  it("offers the snooze alongside an armed resume as an independent choice", () => {
    render(
      <UsageLimitNotice
        limit={LIMIT}
        provider="Codex"
        resumable={true}
        usageResume={armedResume("scheduled")}
        onSnoozeAtReset={() => undefined}
      />,
    );
    expect(screen.getByRole("button", { name: "Snooze until reset" })).toBeDefined();
  });

  it("never offers the snooze once the recovery dispatch consumes the reset", () => {
    render(
      <UsageLimitNotice
        limit={LIMIT}
        provider="Codex"
        resumable={true}
        usageResume={armedResume("dispatched")}
        onSnoozeAtReset={() => undefined}
      />,
    );
    expect(screen.queryByRole("button", { name: "Snooze until reset" })).toBeNull();
  });

  it("describes a dispatched recovery as a past event after the resumed turn settles", () => {
    const { rerender } = render(
      <UsageLimitNotice
        limit={LIMIT}
        provider="Codex"
        resumable={true}
        usageResume={armedResume("dispatched")}
      />,
    );
    rerender(
      <UsageLimitNotice
        limit={LIMIT}
        provider="Codex"
        resumable={false}
        usageResume={armedResume("dispatched")}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Resume started.");
    expect(screen.getByRole("alert")).not.toHaveTextContent("Resuming…");
  });

  it("offers nothing when the stop discloses no reset to wait on", () => {
    render(
      <UsageLimitNotice
        limit={{ kind: "exhausted" }}
        provider="Codex"
        resumable={true}
        onSnoozeAtReset={() => undefined}
      />,
    );
    expect(screen.queryByRole("button", { name: "Snooze until reset" })).toBeNull();
  });

  it("offers nothing for a billing stop, which no clock can clear", () => {
    render(
      <UsageLimitNotice
        limit={{ kind: "billing", resetsAt: LIMIT.resetsAt }}
        provider="Codex"
        resumable={true}
        onSnoozeAtReset={() => undefined}
      />,
    );
    expect(screen.queryByRole("button", { name: "Snooze until reset" })).toBeNull();
  });

  it("leaves the snooze offer to the caller, who withholds it once the thread is snoozed", () => {
    render(<UsageLimitNotice limit={LIMIT} provider="Codex" resumable={true} />);
    expect(screen.queryByRole("button", { name: "Snooze until reset" })).toBeNull();
  });
});
