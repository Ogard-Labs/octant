import type { AutomationClient } from "@octant/client-runtime";
import type { AutomationSummary } from "@octant/contracts/automation";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTOMATION_UI_TEST_IDS,
  AUTOMATION_UI_TEST_NOW,
  automationDefinitionFixture,
  automationSummaryFixture,
} from "../automation/automationTestFixtures";
import { EnvironmentRoutines } from "./EnvironmentRoutines";

const thisThread = "bb000000-0000-4000-8000-000000000001";
const otherThread = "bb000000-0000-4000-8000-000000000002";
// The quick picks are the person's local clock, so the expected instants are too.
const tomorrowNine = new Date(2026, 7, 11, 9, 0, 0).toISOString();

let idCounter = 100;
function nextId(): string {
  idCounter += 1;
  return `aa000000-0000-4000-8000-${String(idCounter).padStart(12, "0")}`;
}

function routine(overrides: Partial<AutomationSummary> = {}): AutomationSummary {
  return automationSummaryFixture({
    displayName: "Friday digest",
    originThreadId: thisThread,
    ...overrides,
  } as never);
}

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

/** A routine of this Project that some other thread, or the Automation Center, created. */
function projectRoutine(displayName: string, overrides: Partial<AutomationSummary> = {}) {
  const { originThreadId: _origin, ...summary } = routine({
    id: nextId(),
    displayName,
  } as never);
  return { ...summary, ...overrides } as AutomationSummary;
}

function client(initial: ReadonlyArray<AutomationSummary>) {
  let items = initial;
  const fake = {
    list: vi.fn(async () => ({ kind: "automation-list" as const, items })),
    execute: vi.fn(async (command: { readonly kind: string; readonly automationId: string }) => {
      if (command.kind === "archive-automation") {
        items = items.filter((item) => String(item.id) !== command.automationId);
        return { kind: "automation-archived" as const, automation: automationDefinitionFixture() };
      }
      const paused = command.kind === "pause-automation";
      items = items.map((item) =>
        String(item.id) === command.automationId
          ? automationSummaryFixture({
              ...item,
              lifecycle: paused ? "paused" : "enabled",
              version: item.version + 1,
            } as never)
          : item,
      );
      return {
        kind: paused ? ("automation-paused" as const) : ("automation-resumed" as const),
        automation: automationDefinitionFixture(),
      };
    }),
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
    createThreadRoutine: vi.fn(async () => {
      items = [...items, routine({ id: nextId(), displayName: "Morning check" } as never)];
      return { kind: "automation-created" as const, automation: automationDefinitionFixture() };
    }),
  };
  return fake as unknown as AutomationClient & typeof fake;
}

function renderRoutines(
  automationClient: AutomationClient,
  options: {
    readonly mode?: "work" | "code";
    readonly onOpenRoutine?: (automationId: string) => void;
  } = {},
) {
  return render(
    <EnvironmentRoutines
      client={automationClient}
      mode={options.mode ?? "work"}
      {...(options.onOpenRoutine === undefined ? {} : { onOpenRoutine: options.onOpenRoutine })}
      projectId={AUTOMATION_UI_TEST_IDS.project}
      threadId={thisThread}
    />,
  );
}

function listedNames(): ReadonlyArray<string> {
  const list = screen.getByRole("list", { name: "Routines in this Project" });
  return within(list)
    .getAllByRole("listitem")
    .map((item) => item.getAttribute("aria-label") ?? "");
}

describe("EnvironmentRoutines", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(AUTOMATION_UI_TEST_NOW));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("offers only the two create actions when the Project has no routines", async () => {
    const fake = client([]);
    renderRoutines(fake);
    await waitFor(() => expect(fake.list).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: "Routines" }));

    expect(screen.getByRole("button", { name: "Follow up later" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New routine" })).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it.each(["work", "code"] as const)(
    "lists the Project's routines in a %s thread: its follow-ups, then its routines, then the rest",
    async (mode) => {
      const fake = client([
        projectRoutine("Nightly build check"),
        routine({ id: nextId(), displayName: "Friday digest" } as never),
        followUp({ id: nextId() } as never),
        projectRoutine("Paused weekly plan", { lifecycle: "paused" } as never),
        projectRoutine("Archived report", { lifecycle: "archived" } as never),
      ]);
      renderRoutines(fake, { mode });

      await userEvent.click(await screen.findByRole("button", { name: "Routines 4 routines" }));

      expect(listedNames()).toEqual([
        "Check for the reply",
        "Friday digest",
        "Nightly build check",
        "Paused weekly plan",
      ]);
      expect(screen.getByText("Follow-up here")).toBeInTheDocument();
      expect(screen.getByText("From this thread")).toBeInTheDocument();
      expect(
        within(screen.getByRole("listitem", { name: "Paused weekly plan" })).getByText("Paused"),
      ).toBeInTheDocument();
      expect(fake.list).toHaveBeenCalledWith(
        { mode, projectId: AUTOMATION_UI_TEST_IDS.project, limit: 100 },
        expect.anything(),
      );
    },
  );

  it("reads every page so an older routine of this thread is not crowded out", async () => {
    const fake = client([]);
    fake.list
      .mockResolvedValueOnce({
        kind: "automation-list",
        items: [projectRoutine("Recently changed")],
        nextCursor: "page-2",
      } as never)
      .mockResolvedValueOnce({ kind: "automation-list", items: [routine()] } as never);
    renderRoutines(fake);

    await userEvent.click(await screen.findByRole("button", { name: "Routines 2 routines" }));

    expect(listedNames()).toEqual(["Friday digest", "Recently changed"]);
    expect(fake.list).toHaveBeenCalledWith(
      { mode: "work", projectId: AUTOMATION_UI_TEST_IDS.project, limit: 100, cursor: "page-2" },
      expect.anything(),
    );
  });

  it("shows the first five and the rest on Show all", async () => {
    const fake = client(
      Array.from({ length: 7 }, (_, index) => projectRoutine(`Routine ${String(index + 1)}`)),
    );
    renderRoutines(fake);
    await userEvent.click(await screen.findByRole("button", { name: "Routines 7 routines" }));

    expect(listedNames()).toHaveLength(5);
    await userEvent.click(screen.getByRole("button", { name: "Show all 7" }));
    expect(listedNames()).toHaveLength(7);
  });

  it("pauses a routine with its current version and then shows it paused", async () => {
    const fake = client([routine()]);
    renderRoutines(fake);
    await userEvent.click(await screen.findByRole("button", { name: "Routines 1 routine" }));

    await userEvent.click(screen.getByRole("button", { name: "Pause Friday digest" }));

    expect(fake.execute).toHaveBeenCalledWith({
      kind: "pause-automation",
      automationId: AUTOMATION_UI_TEST_IDS.automation,
      expectedVersion: 1,
    });
    expect(await screen.findByText("Paused")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resume Friday digest" })).toBeInTheDocument();
  });

  it("says so when a pause did not reach the host", async () => {
    const fake = client([routine()]);
    fake.execute.mockRejectedValueOnce(new Error("offline"));
    renderRoutines(fake);
    await userEvent.click(await screen.findByRole("button", { name: "Routines 1 routine" }));

    await userEvent.click(screen.getByRole("button", { name: "Pause Friday digest" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("did not reach the host");
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("opens a routine in the Automation Center", async () => {
    const onOpenRoutine = vi.fn();
    renderRoutines(client([routine()]), { onOpenRoutine });
    await userEvent.click(await screen.findByRole("button", { name: "Routines 1 routine" }));

    await userEvent.click(
      screen.getByRole("button", { name: "Open Friday digest in Automation Center" }),
    );

    expect(onOpenRoutine).toHaveBeenCalledWith(AUTOMATION_UI_TEST_IDS.automation);
  });

  it.each(["work", "code"] as const)(
    "creates a routine from a %s thread for this thread's Project and mode",
    async (mode) => {
      const fake = client([]);
      renderRoutines(fake, { mode });
      await waitFor(() => expect(fake.list).toHaveBeenCalled());
      await userEvent.click(screen.getByRole("button", { name: "Routines" }));

      await userEvent.click(screen.getByRole("button", { name: "New routine" }));
      const form = screen.getByRole("form", { name: "New routine" });
      await userEvent.type(within(form).getByLabelText("Name"), "Morning check");
      await userEvent.type(
        within(form).getByLabelText("Task for each run"),
        "Summarise what changed overnight.",
      );
      await userEvent.clear(within(form).getByLabelText("Timezone"));
      await userEvent.type(within(form).getByLabelText("Timezone"), "Europe/Oslo");
      await userEvent.click(within(form).getByRole("button", { name: "Create routine" }));

      expect(fake.createThreadRoutine).toHaveBeenCalledWith({
        kind: "create-thread-routine",
        threadId: thisThread,
        mode,
        projectId: AUTOMATION_UI_TEST_IDS.project,
        displayName: "Morning check",
        taskPrompt: "Summarise what changed overnight.",
        trigger: {
          kind: "weekly-local",
          weekdays: [1, 2, 3, 4, 5],
          localTime: "09:00",
          timeZone: "Europe/Oslo",
        },
        missedRunPolicy: "skip",
      });
      expect(await screen.findByRole("listitem", { name: "Morning check" })).toBeInTheDocument();
      expect(screen.queryByRole("form", { name: "New routine" })).not.toBeInTheDocument();
    },
  );

  it("sends nothing while the new routine has no name", async () => {
    const fake = client([]);
    renderRoutines(fake);
    await waitFor(() => expect(fake.list).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: "Routines" }));
    await userEvent.click(screen.getByRole("button", { name: "New routine" }));

    await userEvent.click(screen.getByRole("button", { name: "Create routine" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Name the routine.");
    expect(fake.createThreadRoutine).not.toHaveBeenCalled();
  });

  it("sets up a follow-up for tomorrow at 9:00 in this thread with the person's prompt", async () => {
    const fake = client([]);
    renderRoutines(fake);
    await waitFor(() => expect(fake.list).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: "Routines" }));

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
    renderRoutines(fake);
    await waitFor(() => expect(fake.list).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: "Routines" }));
    await userEvent.click(screen.getByRole("button", { name: "Follow up later" }));
    await userEvent.click(screen.getByRole("button", { name: "In 1 hour" }));
    await userEvent.click(screen.getByRole("button", { name: "Schedule follow-up" }));
    expect(fake.followUp).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledAt: "2026-08-10T13:00:00.000Z" }),
    );
  });

  it("moves a pending follow-up to another time", async () => {
    const fake = client([followUp()]);
    renderRoutines(fake);
    await userEvent.click(await screen.findByRole("button", { name: "Routines 1 routine" }));
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
    renderRoutines(fake);
    await userEvent.click(await screen.findByRole("button", { name: "Routines 1 routine" }));

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
    renderRoutines(fake);
    await waitFor(() => expect(fake.list).toHaveBeenCalled());
    await Promise.resolve();
    expect(screen.getByRole("button", { name: "Routines" })).toBeInTheDocument();
  });

  it("lists another thread's follow-up with the Project's routines, labelled as such", async () => {
    const fake = client([followUp({ originThreadId: otherThread } as never)]);
    renderRoutines(fake);
    await userEvent.click(await screen.findByRole("button", { name: "Routines 1 routine" }));

    expect(screen.getByText("Follow-up in another thread")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change time" })).not.toBeInTheDocument();
  });
});
