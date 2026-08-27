import type { AutomationClient } from "@octant/client-runtime";
import { AutomationClientFailure } from "@octant/client-runtime";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationCenter, type AutomationCenterProps } from "./AutomationCenter";
import type { AutomationEditorCatalog } from "./automationCenterModel";
import {
  AUTOMATION_UI_TEST_IDS,
  AUTOMATION_UI_TEST_NOW,
  automationWorkDraftFixture,
  automationDefinitionFixture,
  automationRunFixture,
  automationSummaryFixture,
} from "./automationTestFixtures";

const workDraft = automationWorkDraftFixture();
const definition = automationDefinitionFixture();
const workSummary = automationSummaryFixture();
const codeSummary = automationSummaryFixture({
  id: AUTOMATION_UI_TEST_IDS.otherAutomation,
  displayName: "Nightly build check",
  mode: "code",
  projectId: AUTOMATION_UI_TEST_IDS.otherProject,
  lifecycle: "paused",
  nextDueAt: null,
  latestRunLifecycle: "failed",
} as never);
const completedRun = automationRunFixture(definition, { lifecycle: "completed" });
const failedRun = automationRunFixture(definition, {
  id: AUTOMATION_UI_TEST_IDS.otherRun,
  lifecycle: "failed",
});

function catalog(): AutomationEditorCatalog {
  return {
    hosts: [{ hostId: "local", label: "This Mac" }],
    projects: [
      {
        projectId: workDraft.projectId,
        name: "Docs Project",
        mode: "work",
        projectVersion: workDraft.projectVersion,
        binding: workDraft.binding,
      },
    ],
    executionProfiles: [{ label: "Work default", receipt: workDraft.executionProfile }],
    authorityProfiles: [{ label: "Approval-gated Work", receipt: workDraft.authorityProfile }],
    actorId: AUTOMATION_UI_TEST_IDS.actor,
  };
}

function fakeClient(overrides: Partial<AutomationClient> = {}): AutomationClient {
  return {
    list: vi.fn(async () => ({
      kind: "automation-list" as const,
      items: [workSummary, codeSummary],
    })),
    get: vi.fn(async () => ({
      kind: "automation-detail" as const,
      automation: definition,
      runs: [completedRun, failedRun],
    })),
    history: vi.fn(async () => ({
      kind: "automation-history" as const,
      automationId: definition.id,
      runs: [completedRun, failedRun],
    })),
    execute: vi.fn(async () => ({ kind: "automation-paused" as const, automation: definition })),
    ...overrides,
  } as AutomationClient;
}

function renderCenter(overrides: Record<string, unknown> = {}) {
  const client = (overrides["client"] as AutomationClient | undefined) ?? fakeClient();
  const props = {
    client,
    catalog: catalog(),
    displayTimeZone: "UTC",
    localHostId: "local",
    now: () => AUTOMATION_UI_TEST_NOW,
    generateId: () => AUTOMATION_UI_TEST_IDS.runNowRequest,
    ...overrides,
  };
  return {
    client,
    ...render(<AutomationCenter {...(props as unknown as AutomationCenterProps)} />),
  };
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, "error");
  consoleWarnSpy = vi.spyOn(console, "warn");
});

afterEach(() => {
  expect(consoleErrorSpy).not.toHaveBeenCalled();
  expect(consoleWarnSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe("AutomationCenter default surface", () => {
  it("shows search, mode filters, compact rows, and one primary create action", async () => {
    renderCenter();

    expect(screen.getByRole("status")).toHaveTextContent("Loading automations.");
    const rows = await screen.findByRole("list", { name: "Automations" });
    expect(screen.getByLabelText("Search automations")).toBeVisible();
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Work" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Code" })).toBeVisible();
    expect(screen.getByRole("button", { name: "New automation" })).toBeVisible();

    const workRow = within(rows).getByRole("listitem", { name: "Weekly summary" });
    expect(within(workRow).getByText("Docs Project")).toBeVisible();
    // A row says what the routine does and when it next does it, in one line.
    expect(
      within(workRow).getByText("Weekly on Mon at 9:00 · Next run on Sep 1 at 9:00"),
    ).toBeVisible();
    expect(within(workRow).getByText("Recurring")).toBeVisible();
    // A routine on this machine carries no environment badge: badging every row
    // would make the machine you are sitting at look like one more remote one.
    expect(within(workRow).queryByText("Local")).toBeNull();
    expect(within(workRow).getByText("Enabled")).toBeVisible();
    expect(within(workRow).getByText("Last run: Completed")).toBeVisible();

    const codeRow = within(rows).getByRole("listitem", { name: "Nightly build check" });
    expect(within(codeRow).getByText("Weekly on Mon at 9:00 · Not scheduled")).toBeVisible();
    expect(within(codeRow).getByText("Paused")).toBeVisible();
    expect(within(codeRow).getByText("Last run: Failed")).toBeVisible();
  });

  it("re-queries the server when the mode filter or search change", async () => {
    const { client } = renderCenter();
    await screen.findByRole("list", { name: "Automations" });

    await userEvent.click(screen.getByRole("button", { name: "Work" }));
    await waitFor(() =>
      expect(client.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ mode: "work" }),
        expect.anything(),
      ),
    );

    await userEvent.type(screen.getByLabelText("Search automations"), "weekly");
    await waitFor(() =>
      expect(client.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ search: "weekly" }),
        expect.anything(),
      ),
    );
  });

  it("names an unavailable list and recovers through retry", async () => {
    let fail = true;
    const client = fakeClient({
      list: vi.fn(async () => {
        if (fail) throw new AutomationClientFailure("network", "The host is unreachable.");
        return { kind: "automation-list" as const, items: [workSummary] };
      }),
    });
    renderCenter({ client });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The host is unreachable.");

    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("list", { name: "Automations" })).toBeVisible();
  });

  it("turns an empty list into creation paths and working suggestions", async () => {
    const client = fakeClient({
      list: vi.fn(async () => ({ kind: "automation-list" as const, items: [] })),
    });
    renderCenter({ client });

    expect(await screen.findByRole("heading", { name: "Create an automation" })).toBeVisible();
    expect(screen.getByRole("button", { name: /Describe with Octant/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /Create manually/ })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Suggested automations" })).toBeVisible();
    expect(screen.queryByText("No automations match the current filters.")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Every weekday morning/ }));
    expect(screen.getByLabelText("What do you want automated?")).toHaveValue(
      "Every weekday at 9:00, summarise what changed in this Project overnight",
    );
  });
});

describe("AutomationCenter row actions", () => {
  it("pauses, runs now, and archives from the row overflow menu with exact versions", async () => {
    const { client } = renderCenter();
    const rows = await screen.findByRole("list", { name: "Automations" });
    const row = within(rows).getByRole("listitem", { name: "Weekly summary" });

    await userEvent.click(within(row).getByText("Actions"));
    await userEvent.click(within(row).getByRole("button", { name: "Pause" }));
    await waitFor(() =>
      expect(client.execute).toHaveBeenLastCalledWith({
        kind: "pause-automation",
        automationId: workSummary.id,
        expectedVersion: workSummary.version,
      }),
    );
    expect(await screen.findByText("Automation paused.")).toBeVisible();

    await userEvent.click(within(row).getByText("Actions"));
    await userEvent.click(within(row).getByRole("button", { name: "Run now" }));
    await waitFor(() =>
      expect(client.execute).toHaveBeenLastCalledWith({
        kind: "run-now-automation",
        automationId: workSummary.id,
        expectedVersion: workSummary.version,
        runNowRequestId: AUTOMATION_UI_TEST_IDS.runNowRequest,
      }),
    );

    await userEvent.click(within(row).getByText("Actions"));
    await userEvent.click(within(row).getByRole("button", { name: "Archive" }));
    await waitFor(() =>
      expect(client.execute).toHaveBeenLastCalledWith({
        kind: "archive-automation",
        automationId: workSummary.id,
        expectedVersion: workSummary.version,
      }),
    );
  });

  it("offers Resume instead of Pause for a paused automation", async () => {
    renderCenter();
    const rows = await screen.findByRole("list", { name: "Automations" });
    const row = within(rows).getByRole("listitem", { name: "Nightly build check" });
    await userEvent.click(within(row).getByText("Actions"));
    expect(within(row).getByRole("button", { name: "Resume" })).toBeVisible();
    expect(within(row).queryByRole("button", { name: "Pause" })).not.toBeInTheDocument();
  });
});

describe("AutomationCenter detail disclosure", () => {
  async function openDetail() {
    const rows = await screen.findByRole("list", { name: "Automations" });
    await userEvent.click(within(rows).getByRole("button", { name: "Weekly summary" }));
    return await screen.findByRole("region", { name: "Automation details" });
  }

  it("shows trigger, context, confirmed target, and keeps authority behind disclosure", async () => {
    renderCenter();
    const detail = await openDetail();

    expect(within(detail).getByText("Once at Sep 1, 2026, 09:00")).toBeVisible();
    expect(within(detail).getByText("Docs Project")).toBeVisible();
    expect(within(detail).getByText("Work")).toBeVisible();
    expect(
      within(detail).getByText("A confirmed weekly summary document exists in the Project."),
    ).toBeVisible();

    const authoritySummary = within(detail).getByText(
      "Approval-gated · filesystem, tools · this session only",
    );
    expect(authoritySummary).not.toBeVisible();
    await userEvent.click(within(detail).getByText("Advanced"));
    expect(authoritySummary).toBeVisible();
    expect(within(detail).getByText("Skip missed runs")).toBeVisible();
  });

  it("loads bounded history lazily and pages through the opaque cursor", async () => {
    const olderRun = automationRunFixture(definition, {
      id: "aa000000-0000-4000-8000-0000000000ff",
      lifecycle: "cancelled",
    });
    const history = vi.fn(async (input: { cursor?: string }) =>
      input.cursor === undefined
        ? {
            kind: "automation-history" as const,
            automationId: definition.id,
            runs: [completedRun],
            nextCursor: "cursor-1",
          }
        : {
            kind: "automation-history" as const,
            automationId: definition.id,
            runs: [olderRun],
          },
    );
    const client = fakeClient({ history: history as never });
    renderCenter({ client });
    const detail = await openDetail();

    expect(client.history).not.toHaveBeenCalled();
    await userEvent.click(within(detail).getByText("Run history"));
    const historyList = await within(detail).findByRole("list", { name: "Run history" });
    expect(within(historyList).getAllByRole("listitem")).toHaveLength(1);

    await userEvent.click(within(detail).getByRole("button", { name: "Load more runs" }));
    await waitFor(() => expect(within(historyList).getAllByRole("listitem")).toHaveLength(2));
    expect(within(historyList).getByText("Cancelled")).toBeVisible();
    expect(
      within(detail).queryByRole("button", { name: "Load more runs" }),
    ).not.toBeInTheDocument();
  });

  it("navigates run rows to the ordinary thread only after the thread exists", async () => {
    const onOpenThread = vi.fn();
    renderCenter({ onOpenThread });
    const detail = await openDetail();

    await userEvent.click(within(detail).getByText("Run history"));
    const historyList = await within(detail).findByRole("list", { name: "Run history" });
    const entries = within(historyList).getAllByRole("listitem");

    const completedEntry = entries.find((entry) => within(entry).queryByText("Completed"))!;
    await userEvent.click(within(completedEntry).getByRole("button", { name: "Open thread" }));
    expect(onOpenThread).toHaveBeenCalledWith({
      mode: "work",
      threadId: AUTOMATION_UI_TEST_IDS.thread,
      title: "Weekly summary",
    });

    const failedEntry = entries.find((entry) => within(entry).queryByText("Failed"))!;
    expect(
      within(failedEntry).queryByRole("button", { name: "Open thread" }),
    ).not.toBeInTheDocument();
    expect(within(failedEntry).getByText("The delivery target no longer matches.")).toBeVisible();
  });

  it("cancels the current run with the exact run identity and version", async () => {
    const activeRun = automationRunFixture(definition, {
      id: AUTOMATION_UI_TEST_IDS.otherRun,
      lifecycle: "running",
    });
    const client = fakeClient({
      get: vi.fn(async () => ({
        kind: "automation-detail" as const,
        automation: definition,
        runs: [activeRun],
      })),
    });
    renderCenter({ client });
    const detail = await openDetail();

    await userEvent.click(within(detail).getByRole("button", { name: "Cancel current run" }));
    await waitFor(() =>
      expect(client.execute).toHaveBeenLastCalledWith({
        kind: "cancel-current-automation-run",
        automationId: definition.id,
        expectedVersion: definition.version,
        runId: activeRun.id,
        cancelRunRequestId: AUTOMATION_UI_TEST_IDS.runNowRequest,
        expectedRunVersion: activeRun.version,
      }),
    );
  });

  it("names a blocked definition's typed reason as plain text", async () => {
    const blocked = automationDefinitionFixture({
      lifecycle: "paused",
      blockedReason: "missed-run-cap-exceeded",
      nextDueAt: null,
    } as never);
    const client = fakeClient({
      get: vi.fn(async () => ({
        kind: "automation-detail" as const,
        automation: blocked,
        runs: [],
      })),
    });
    renderCenter({ client });
    const detail = await openDetail();
    expect(
      within(detail).getByText(
        "Paused automatically: too many missed runs. Resume after reviewing the schedule.",
      ),
    ).toBeVisible();
  });

  it("names an unavailable detail and recovers through retry", async () => {
    let fail = true;
    const client = fakeClient({
      get: vi.fn(async () => {
        if (fail) throw new AutomationClientFailure("http", "Automation is unavailable.", 404);
        return { kind: "automation-detail" as const, automation: definition, runs: [] };
      }),
    });
    renderCenter({ client });
    const rows = await screen.findByRole("list", { name: "Automations" });
    await userEvent.click(within(rows).getByRole("button", { name: "Weekly summary" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Automation is unavailable.");
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("region", { name: "Automation details" })).toBeVisible();
  });
});

describe("AutomationCenter creation and editing", () => {
  it("carries a confirmed routine request into the editor", async () => {
    const client = fakeClient({
      list: vi.fn(async () => ({ kind: "automation-list" as const, items: [] })),
    });
    renderCenter({ client });

    await screen.findByRole("heading", { name: "Suggested automations" });
    await userEvent.click(screen.getByRole("button", { name: /Every weekday morning/ }));
    await userEvent.click(screen.getByRole("button", { name: "Review this routine" }));

    const form = await screen.findByRole("form", { name: "New automation" });
    expect(within(form).getByLabelText("Name")).toHaveValue(
      "Summarise what changed in this Project overnight",
    );
    expect(within(form).getByLabelText("Task for each run")).toHaveValue(
      "summarise what changed in this Project overnight",
    );
    expect(within(form).getByLabelText("Schedule")).toHaveValue("weekly-local");
    expect(within(form).getByRole("checkbox", { name: "Mon" })).toBeChecked();
    expect(within(form).getByRole("checkbox", { name: "Fri" })).toBeChecked();
    expect(within(form).getByLabelText("Time of day")).toHaveValue("09:00");
    expect(within(form).getByLabelText("Timezone")).toHaveValue("UTC");

    await userEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("What do you want automated?")).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Suggested automations" })).toBeVisible();
  });

  it("creates through the editor with expected version zero and refreshes the list", async () => {
    const client = fakeClient({
      execute: vi.fn(async () => ({
        kind: "automation-created" as const,
        automation: definition,
      })),
    });
    renderCenter({ client });
    await screen.findByRole("list", { name: "Automations" });
    const listCalls = (client.list as ReturnType<typeof vi.fn>).mock.calls.length;

    await userEvent.click(screen.getByRole("button", { name: "New automation" }));
    const form = await screen.findByRole("form", { name: "New automation" });

    await userEvent.type(within(form).getByLabelText("Name"), "Weekly summary");
    await userEvent.type(within(form).getByLabelText("Task for each run"), "Summarize work.");
    await userEvent.selectOptions(
      within(form).getByLabelText("Project"),
      String(workDraft.projectId),
    );
    await userEvent.selectOptions(within(form).getByLabelText("Execution profile"), [
      String(workDraft.executionProfile.profileId),
    ]);
    await userEvent.selectOptions(within(form).getByLabelText("Authority profile"), [
      String(workDraft.authorityProfile.profileId),
    ]);
    fireEvent.change(within(form).getByLabelText("Run at"), {
      target: { value: "2026-09-01T09:00" },
    });
    await userEvent.type(within(form).getByLabelText("Delivery target"), "A summary exists.");
    await userEvent.click(
      within(form).getByLabelText("I confirm this delivery target for every scheduled run"),
    );
    await userEvent.click(within(form).getByRole("button", { name: "Save automation" }));

    await waitFor(() =>
      expect(client.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "create-automation",
          automationId: AUTOMATION_UI_TEST_IDS.runNowRequest,
          expectedVersion: 0,
        }),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole("form", { name: "New automation" })).not.toBeInTheDocument(),
    );
    expect(await screen.findByText("Automation created.")).toBeVisible();
    expect((client.list as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(listCalls);
  });

  it("edits the selected automation with its exact expected version", async () => {
    const client = fakeClient({
      execute: vi.fn(async () => ({
        kind: "automation-updated" as const,
        automation: definition,
      })),
    });
    renderCenter({ client });
    const rows = await screen.findByRole("list", { name: "Automations" });
    await userEvent.click(within(rows).getByRole("button", { name: "Weekly summary" }));
    const detail = await screen.findByRole("region", { name: "Automation details" });

    await userEvent.click(within(detail).getByRole("button", { name: "Edit" }));
    const form = await screen.findByRole("form", { name: "Edit automation" });
    expect(within(form).getByLabelText("Name")).toHaveValue("Weekly summary");

    await userEvent.click(
      within(form).getByLabelText("I confirm this delivery target for every scheduled run"),
    );
    await userEvent.click(within(form).getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(client.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "update-automation",
          automationId: definition.id,
          expectedVersion: definition.version,
        }),
      ),
    );
  });
});

describe("AutomationCenter narrow layout, keyboard, and focus", () => {
  it("uses one full-height detail view on narrow layouts and preserves list state", async () => {
    renderCenter({ narrow: true });
    await screen.findByRole("list", { name: "Automations" });
    await userEvent.click(screen.getByRole("button", { name: "Work" }));
    await userEvent.type(screen.getByLabelText("Search automations"), "weekly");
    const rows = await screen.findByRole("list", { name: "Automations" });

    await userEvent.click(within(rows).getByRole("button", { name: "Weekly summary" }));
    const detail = await screen.findByRole("region", { name: "Automation details" });
    expect(screen.queryByRole("list", { name: "Automations" })).not.toBeInTheDocument();
    expect(within(detail).getByRole("heading", { name: "Weekly summary" })).toHaveFocus();

    await userEvent.click(screen.getByRole("button", { name: "Back to list" }));
    expect(await screen.findByRole("list", { name: "Automations" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Work" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Search automations")).toHaveValue("weekly");
    expect(screen.getByRole("button", { name: "Weekly summary" })).toHaveFocus();
  });

  it("opens a row and its detail entirely from the keyboard", async () => {
    renderCenter();
    const rows = await screen.findByRole("list", { name: "Automations" });
    const row = within(rows).getByRole("button", { name: "Weekly summary" });
    row.focus();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("region", { name: "Automation details" })).toBeVisible();
  });

  it("announces command notices politely and can dismiss them", async () => {
    renderCenter();
    const rows = await screen.findByRole("list", { name: "Automations" });
    const row = within(rows).getByRole("listitem", { name: "Weekly summary" });
    await userEvent.click(within(row).getByText("Actions"));
    await userEvent.click(within(row).getByRole("button", { name: "Pause" }));

    const notice = await screen.findByText("Automation paused.");
    expect(notice.closest("[role='status']")).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Automation paused.")).not.toBeInTheDocument();
  });

  it("scales with browser zoom: the stylesheet sizes text and layout in rem/em, never px fonts", () => {
    const stylesheet = readFileSync(resolve(process.cwd(), "src/styles/automation.css"), "utf8");
    // 200% zoom multiplies the root font size; px-sized fonts and px-fixed
    // heights would refuse to scale with it.
    expect(stylesheet).not.toMatch(/font-size:\s*\d+px/);
    expect(stylesheet).toMatch(/font-size:\s*[\d.]+rem/);
    // 1px is the visually-hidden input idiom; anything larger must scale.
    expect(stylesheet).not.toMatch(/(?<!m(?:in|ax)-)height:\s*(?!1px)\d+px/);
    // The full-surface layer scrolls instead of clipping at high zoom.
    expect(stylesheet).toMatch(/\.automation-center-layer\s*\{[^}]*overflow:\s*auto;/s);
    expect(stylesheet).toMatch(/\.automation-center\s*\{[^}]*overflow:\s*auto;/s);
  });
});

describe("AutomationCenter calendar view", () => {
  it("lays the same routines out by when they run, and goes back to the list", async () => {
    renderCenter();
    expect(await screen.findByLabelText("Automations")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Calendar" }));

    const calendar = screen.getByRole("region", { name: "Routine calendar" });
    expect(
      within(calendar).getAllByRole("button", { name: /Weekly summary/ }).length,
    ).toBeGreaterThan(0);
    // The list is a view, not a place: switching away and back keeps the rows.
    expect(screen.queryByLabelText("Automations")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "List" }));

    expect(screen.getByLabelText("Automations")).toBeTruthy();
  });

  it("moves between months without losing the routines", async () => {
    renderCenter();
    await screen.findByLabelText("Automations");
    await userEvent.click(screen.getByRole("button", { name: "Calendar" }));
    const heading = screen.getByRole("region", { name: "Routine calendar" });
    const before = within(heading).getByRole("heading").textContent;

    await userEvent.click(screen.getByRole("button", { name: "Next month" }));

    expect(within(heading).getByRole("heading").textContent).not.toBe(before);

    await userEvent.click(screen.getByRole("button", { name: "Previous month" }));

    expect(within(heading).getByRole("heading").textContent).toBe(before);
  });
});

describe("AutomationCenter arranging", () => {
  const remoteSummary = automationSummaryFixture({
    id: AUTOMATION_UI_TEST_IDS.otherAutomation,
    displayName: "Devbox nightly",
    hostId: "devbox",
    lifecycle: "enabled",
    latestRunLifecycle: "failed",
  } as never);

  function renderWithRemote() {
    return renderCenter({
      client: fakeClient({
        list: vi.fn(async () => ({
          kind: "automation-list" as const,
          items: [workSummary, remoteSummary],
        })),
      } as Partial<AutomationClient>),
      environmentNames: new Map([["devbox", "Devbox"]]),
    });
  }

  it("badges a routine that belongs to another environment, and only that one", async () => {
    renderWithRemote();
    const rows = await screen.findByRole("list", { name: "Automations" });

    const remote = within(rows).getByRole("listitem", { name: "Devbox nightly" });
    expect(within(remote).getByText("Devbox")).toBeVisible();
    const local = within(rows).getByRole("listitem", { name: "Weekly summary" });
    expect(within(local).queryByText("Local")).toBeNull();
  });

  it("keeps only the routines whose status was asked for", async () => {
    renderWithRemote();
    await screen.findByRole("list", { name: "Automations" });

    await userEvent.selectOptions(screen.getByLabelText("Status"), "needs-attention");

    const rows = screen.getByRole("list", { name: "Automations" });
    expect(within(rows).getAllByRole("listitem")).toHaveLength(1);
    expect(within(rows).getByRole("listitem", { name: "Devbox nightly" })).toBeVisible();
  });

  it("groups by environment under the same names the filter uses", async () => {
    renderWithRemote();
    await screen.findByRole("list", { name: "Automations" });

    await userEvent.selectOptions(screen.getByLabelText("Group"), "environment");

    const local = screen.getByRole("list", { name: "Automations in Local" });
    const devbox = screen.getByRole("list", { name: "Automations in Devbox" });
    // Grouping is arrangement, not authority: the same rows, under headings.
    expect(
      within(local)
        .getAllByRole("listitem")
        .map((row) => row.getAttribute("aria-label")),
    ).toEqual(["Weekly summary"]);
    expect(
      within(devbox)
        .getAllByRole("listitem")
        .map((row) => row.getAttribute("aria-label")),
    ).toEqual(["Devbox nightly"]);
  });

  it("says nothing matched rather than showing an empty group", async () => {
    renderCenter({
      client: fakeClient({
        list: vi.fn(async () => ({
          kind: "automation-list" as const,
          items: [workSummary],
        })),
      } as Partial<AutomationClient>),
    });
    await screen.findByRole("list", { name: "Automations" });

    await userEvent.selectOptions(screen.getByLabelText("Status"), "needs-attention");

    expect(screen.queryByRole("list", { name: /Automations/ })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(
      "No automations match the current filters",
    );
  });
});
