import type { AutomationClient } from "@octant/client-runtime";
import type { AutomationSummary } from "@octant/contracts/automation";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTOMATION_UI_TEST_IDS,
  AUTOMATION_UI_TEST_NOW,
  automationDefinitionFixture,
  automationSummaryFixture,
} from "../automation/automationTestFixtures";
import { EnvironmentFollowUps } from "./EnvironmentFollowUps";

const thisThread = "bb000000-0000-4000-8000-000000000001";
// The quick picks are the person's local clock, so the expected instants are too.
const tomorrowNine = new Date(2026, 7, 11, 9, 0, 0).toISOString();

/** A follow-up still to come: enabled, with no run yet. */
function followUp(overrides: Partial<AutomationSummary> = {}): AutomationSummary {
  const { latestRunLifecycle: _ran, ...summary } = automationSummaryFixture({
    displayName: "Check for the reply",
    originThreadId: thisThread,
    targetPolicy: "same-thread",
    trigger: { kind: "once", scheduledAt: tomorrowNine },
    nextDueAt: tomorrowNine,
  } as never);
  return { ...summary, ...overrides } as AutomationSummary;
}

function client(initial: ReadonlyArray<AutomationSummary>) {
  let items = initial;
  const fake = {
    list: vi.fn(async () => ({ kind: "automation-list" as const, items })),
    followUp: vi.fn(async (request: { readonly scheduledAt: string }) => {
      items = [
        followUp({
          trigger: { kind: "once", scheduledAt: request.scheduledAt },
          nextDueAt: request.scheduledAt,
          version: 2,
        } as never),
      ];
      return { kind: "automation-created" as const, automation: automationDefinitionFixture() };
    }),
    execute: vi.fn(async () => {
      items = [];
      return { kind: "automation-archived" as const, automation: automationDefinitionFixture() };
    }),
  };
  return fake as unknown as AutomationClient & typeof fake;
}

function renderFollowUps(automationClient: AutomationClient) {
  return render(
    <EnvironmentFollowUps
      client={automationClient}
      mode="work"
      projectId={AUTOMATION_UI_TEST_IDS.project}
      threadId={thisThread}
    />,
  );
}

describe("EnvironmentFollowUps", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(AUTOMATION_UI_TEST_NOW));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sets up a follow-up for tomorrow at 9:00 in this thread with the person's prompt", async () => {
    const fake = client([]);
    renderFollowUps(fake);
    await waitFor(() => expect(fake.list).toHaveBeenCalled());

    await userEvent.click(screen.getByRole("button", { name: "Follow up later" }));
    expect(screen.getByRole("button", { name: "Tomorrow at 9:00" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const prompt = screen.getByLabelText("What to check");
    await userEvent.clear(prompt);
    await userEvent.type(prompt, "Did the reply arrive?");
    await userEvent.click(screen.getByRole("button", { name: "Schedule follow-up" }));

    expect(fake.followUp).toHaveBeenCalledWith({
      kind: "schedule-follow-up",
      threadId: thisThread,
      mode: "work",
      projectId: AUTOMATION_UI_TEST_IDS.project,
      scheduledAt: tomorrowNine,
      taskPrompt: "Did the reply arrive?",
    });
    expect(await screen.findByText(/^Follows up tomorrow at/)).toBeInTheDocument();
  });

  it("offers an hour from now", async () => {
    const fake = client([]);
    renderFollowUps(fake);
    await userEvent.click(screen.getByRole("button", { name: "Follow up later" }));
    await userEvent.click(screen.getByRole("button", { name: "In 1 hour" }));
    await userEvent.click(screen.getByRole("button", { name: "Schedule follow-up" }));
    expect(fake.followUp).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledAt: "2026-08-10T13:00:00.000Z" }),
    );
  });

  it("shows a pending follow-up and moves it to another time", async () => {
    const fake = client([followUp()]);
    renderFollowUps(fake);
    await userEvent.click(await screen.findByRole("button", { name: /^Follow-up tomorrow at/ }));
    expect(screen.getByText(/^Follows up tomorrow at/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Change time" }));
    await userEvent.click(screen.getByRole("button", { name: "In 1 hour" }));
    await userEvent.click(screen.getByRole("button", { name: "Move follow-up" }));

    expect(fake.followUp).toHaveBeenCalledWith({
      kind: "reschedule-follow-up",
      automationId: AUTOMATION_UI_TEST_IDS.automation,
      expectedVersion: 1,
      scheduledAt: "2026-08-10T13:00:00.000Z",
    });
  });

  it("cancels a pending follow-up through the ordinary archive command", async () => {
    const fake = client([followUp()]);
    renderFollowUps(fake);
    await userEvent.click(await screen.findByRole("button", { name: /^Follow-up tomorrow at/ }));

    await userEvent.click(
      screen.getByRole("button", { name: "Cancel follow-up Check for the reply" }),
    );

    expect(fake.execute).toHaveBeenCalledWith({
      kind: "archive-automation",
      automationId: AUTOMATION_UI_TEST_IDS.automation,
      expectedVersion: 1,
    });
    await waitFor(() =>
      expect(screen.queryByText(/^Follows up tomorrow at/)).not.toBeInTheDocument(),
    );
  });

  it("stops listing a follow-up once its turn has been sent", async () => {
    const fake = client([followUp({ latestRunLifecycle: "running" } as never)]);
    renderFollowUps(fake);
    await waitFor(() => expect(fake.list).toHaveBeenCalled());
    await Promise.resolve();
    expect(screen.getByRole("button", { name: "Follow-up" })).toBeInTheDocument();
  });

  it("does not list a routine that starts new threads as a follow-up", async () => {
    const fake = client([followUp({ targetPolicy: "new-thread" } as never)]);
    renderFollowUps(fake);
    await waitFor(() => expect(fake.list).toHaveBeenCalled());
    await Promise.resolve();
    expect(screen.getByRole("button", { name: "Follow-up" })).toBeInTheDocument();
  });
});
