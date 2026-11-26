import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderUsageLimit, UsageResumeThreadState, UtcTimestamp } from "@octant/contracts";
import { usageLimitStripNotice, type UsageLimitStripInput } from "./usageLimitStrip";
import {
  UsageLimitStripActions,
  UsageLimitStripLine,
  usageLimitStripText,
} from "./usageLimitStripParts";

const NOW = Date.parse("2026-07-19T12:00:00.000Z");
const IN_42_MIN = new Date(NOW + 42 * 60_000).toISOString() as UtcTimestamp;
const AGO = new Date(NOW - 60_000).toISOString() as UtcTimestamp;

const resume = (
  status: UsageResumeThreadState["status"],
  limit: ProviderUsageLimit = { kind: "exhausted", resetsAt: IN_42_MIN },
): UsageResumeThreadState => ({
  record: {
    threadId: "83000000-0000-4000-8000-000000000003",
    turnId: "83000000-0000-4000-8000-000000000004",
    providerInstanceId:
      "83000000-0000-4000-8000-00000000000a" as UsageResumeThreadState["record"]["providerInstanceId"],
    usageLimit: limit,
    resetsAt: IN_42_MIN,
    scheduledAt: new Date(NOW).toISOString() as UtcTimestamp,
  },
  status,
});

const handlers = () => ({
  onResumeNow: vi.fn(),
  onScheduleResume: vi.fn(),
  onCancelResume: vi.fn(),
  onSnoozeAtReset: vi.fn(),
});

/** The strip's two parts drawn directly; the notice loads them lazily. */
function renderStrip(input: UsageLimitStripInput) {
  return render(
    <div>
      <UsageLimitStripLine
        limit={input.limit}
        provider={input.provider}
        usageResume={input.usageResume}
        now={input.now}
      />
      <UsageLimitStripActions input={input} />
    </div>,
  );
}

describe("the usage-limit strip", () => {
  it("names the provider, the kind of limit and when it resets", () => {
    const text = usageLimitStripText({
      limit: { kind: "exhausted", resetsAt: IN_42_MIN },
      provider: "Codex",
      now: NOW,
    });
    expect(text).toMatch(/^Codex · Usage limit · resets .+ · in 42 min$/);
    expect(
      usageLimitStripText({ limit: { kind: "temporary" }, provider: "Claude", now: NOW }),
    ).toBe("Claude · Rate limit · reset time not given");
  });

  it("offers Resume at reset and Snooze only when the reset is known and in the future", () => {
    const known = handlers();
    const first = renderStrip({
      limit: { kind: "exhausted", resetsAt: IN_42_MIN },
      provider: "Codex",
      now: NOW,
      ...known,
    });
    fireEvent.click(screen.getByRole("button", { name: "Resume at reset" }));
    fireEvent.click(screen.getByRole("button", { name: "Snooze until reset" }));
    fireEvent.click(screen.getByRole("button", { name: "Resume now" }));
    expect(known.onScheduleResume).toHaveBeenCalledTimes(1);
    expect(known.onSnoozeAtReset).toHaveBeenCalledTimes(1);
    expect(known.onResumeNow).toHaveBeenCalledTimes(1);
    first.unmount();

    for (const limit of [
      { kind: "exhausted" as const },
      { kind: "exhausted" as const, resetsAt: AGO },
    ]) {
      const view = renderStrip({ limit, provider: "Codex", now: NOW, ...handlers() });
      expect(screen.queryByRole("button", { name: "Resume at reset" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Snooze until reset" })).toBeNull();
      // Trying again now needs no clock.
      expect(screen.getByRole("button", { name: "Resume now" })).toBeDefined();
      view.unmount();
    }
  });

  describe("while it sits parked", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("stops offering Resume at reset and Snooze once the reset passes", () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      renderStrip({
        limit: {
          kind: "exhausted",
          resetsAt: new Date(NOW + 90_000).toISOString() as UtcTimestamp,
        },
        provider: "Codex",
        ...handlers(),
      });
      expect(screen.getByRole("button", { name: "Resume at reset" })).toBeDefined();
      expect(screen.getByRole("button", { name: "Snooze until reset" })).toBeDefined();

      act(() => {
        vi.advanceTimersByTime(91_000);
      });

      expect(screen.queryByRole("button", { name: "Resume at reset" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Snooze until reset" })).toBeNull();
      expect(screen.getByRole("button", { name: "Resume now" })).toBeDefined();
      expect(screen.getByText(/· now$/)).toBeDefined();
    });
  });

  it("a billing stop shows no reset and no resume", () => {
    const input = {
      limit: { kind: "billing", resetsAt: IN_42_MIN },
      provider: "Codex",
      now: NOW,
      ...handlers(),
    } as const;
    const notice = usageLimitStripNotice(input);
    renderStrip(input);
    expect(screen.getByText("Codex · Billing problem")).toBeDefined();
    expect(screen.queryByRole("button")).toBeNull();
    expect(notice.action).toBeUndefined();
  });

  it("turns Resume at reset into Cancel once a resume is set, and says when it runs", () => {
    const set = handlers();
    renderStrip({
      limit: { kind: "exhausted", resetsAt: IN_42_MIN },
      provider: "Codex",
      usageResume: resume("scheduled"),
      now: NOW,
      ...set,
    });
    expect(screen.queryByRole("button", { name: "Resume at reset" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel resume" }));
    expect(set.onCancelResume).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/^Codex · Usage limit · Resumes at /)).toBeDefined();
  });

  it("says when a resume was armed by the default, with Cancel", () => {
    const set = handlers();
    renderStrip({
      limit: { kind: "exhausted", resetsAt: IN_42_MIN },
      provider: "Codex",
      usageResume: {
        ...resume("scheduled"),
        record: { ...resume("scheduled").record, origin: "default" },
      },
      now: NOW,
      ...set,
    });
    expect(screen.getByText(/· Resumes at .+ \(default\)$/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Cancel resume" }));
    expect(set.onCancelResume).toHaveBeenCalledTimes(1);
  });

  it("tells why a scheduled resume did not run and offers it again", () => {
    renderStrip({
      limit: { kind: "exhausted", resetsAt: IN_42_MIN },
      provider: "Codex",
      usageResume: { ...resume("failed"), detail: "Work is turned off on this host." },
      now: NOW,
      ...handlers(),
    });
    expect(
      screen.getByText(/The scheduled resume could not start: Work is turned off on this host\./),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "Resume at reset" })).toBeDefined();
  });
});
