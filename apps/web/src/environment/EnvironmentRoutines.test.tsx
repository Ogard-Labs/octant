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
import { EnvironmentRoutines } from "./EnvironmentRoutines";

const thisThread = "bb000000-0000-4000-8000-000000000001";
const otherThread = "bb000000-0000-4000-8000-000000000002";

function routine(overrides: Partial<AutomationSummary> = {}): AutomationSummary {
  return automationSummaryFixture({
    displayName: "Friday digest",
    originThreadId: thisThread,
    ...overrides,
  } as never);
}

function client(initial: ReadonlyArray<AutomationSummary>) {
  let items = initial;
  const fake = {
    list: vi.fn(async () => ({ kind: "automation-list" as const, items })),
    execute: vi.fn(async (command: { readonly kind: string }) => {
      const paused = command.kind === "pause-automation";
      items = items.map((item) =>
        automationSummaryFixture({
          ...item,
          lifecycle: paused ? "paused" : "enabled",
          version: item.version + 1,
        } as never),
      );
      return {
        kind: paused ? ("automation-paused" as const) : ("automation-resumed" as const),
        automation: automationDefinitionFixture(),
      };
    }),
  };
  return fake as unknown as AutomationClient & typeof fake;
}

function renderRoutines(
  automationClient: AutomationClient,
  onOpenRoutine?: (automationId: string) => void,
) {
  return render(
    <EnvironmentRoutines
      client={automationClient}
      mode="work"
      {...(onOpenRoutine === undefined ? {} : { onOpenRoutine })}
      projectId={AUTOMATION_UI_TEST_IDS.project}
      threadId={thisThread}
    />,
  );
}

describe("EnvironmentRoutines", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(AUTOMATION_UI_TEST_NOW));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows nothing when no routine came from this thread", async () => {
    const fake = client([routine({ originThreadId: otherThread } as never)]);
    const { container } = renderRoutines(fake);
    await waitFor(() => expect(fake.list).toHaveBeenCalled());
    await Promise.resolve();
    expect(container).toBeEmptyDOMElement();
  });

  it("lists a routine from this thread with its schedule, next run, and state", async () => {
    const fake = client([
      routine(),
      routine({
        id: AUTOMATION_UI_TEST_IDS.otherAutomation,
        displayName: "Someone else's routine",
        originThreadId: otherThread,
      } as never),
    ]);
    renderRoutines(fake);

    await userEvent.click(await screen.findByRole("button", { name: "Routines 1 routine" }));
    expect(screen.getByText("Friday digest")).toBeInTheDocument();
    expect(screen.queryByText("Someone else's routine")).not.toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText(/Next run/)).toHaveTextContent("(UTC)");
    expect(fake.list).toHaveBeenCalledWith(
      { mode: "work", projectId: AUTOMATION_UI_TEST_IDS.project, limit: 100 },
      expect.anything(),
    );
  });

  it("pauses a routine with its current version and then shows it paused", async () => {
    const fake = client([routine()]);
    renderRoutines(fake);
    await userEvent.click(await screen.findByRole("button", { name: "Routines 1 routine" }));

    await userEvent.click(screen.getByRole("button", { name: "Pause" }));

    expect(fake.execute).toHaveBeenCalledWith({
      kind: "pause-automation",
      automationId: AUTOMATION_UI_TEST_IDS.automation,
      expectedVersion: 1,
    });
    expect(await screen.findByText("Paused")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
  });

  it("says so when a pause did not reach the host", async () => {
    const fake = client([routine()]);
    fake.execute.mockRejectedValueOnce(new Error("offline"));
    renderRoutines(fake);
    await userEvent.click(await screen.findByRole("button", { name: "Routines 1 routine" }));

    await userEvent.click(screen.getByRole("button", { name: "Pause" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("did not reach the host");
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("opens the routine in the Automation Center", async () => {
    const onOpenRoutine = vi.fn();
    renderRoutines(client([routine()]), onOpenRoutine);
    await userEvent.click(await screen.findByRole("button", { name: "Routines 1 routine" }));

    await userEvent.click(screen.getByRole("button", { name: "Open in Automation Center" }));

    expect(onOpenRoutine).toHaveBeenCalledWith(AUTOMATION_UI_TEST_IDS.automation);
  });
});
