import type { AutomationDefinitionDraft } from "@octant/contracts";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationDefinitionEditor, utcInstantFromLocalInput } from "./AutomationDefinitionEditor";
import type { AutomationEditorCatalog } from "./automationCenterModel";
import {
  AUTOMATION_UI_TEST_IDS,
  AUTOMATION_UI_TEST_NOW,
  automationCodeDraftFixture,
  automationWorkDraftFixture,
  automationDefinitionFixture,
} from "./automationTestFixtures";

const workDraft = automationWorkDraftFixture();
const codeDraft = automationCodeDraftFixture();

function catalog(overrides: Partial<AutomationEditorCatalog> = {}): AutomationEditorCatalog {
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
      {
        projectId: codeDraft.projectId,
        name: "Repo Project",
        mode: "code",
        projectVersion: codeDraft.projectVersion,
        binding: codeDraft.binding,
      },
    ],
    executionProfiles: [
      { label: "Work default", receipt: workDraft.executionProfile },
      { label: "Code default", receipt: codeDraft.executionProfile },
    ],
    authorityProfiles: [
      { label: "Approval-gated Work", receipt: workDraft.authorityProfile },
      { label: "Approval-gated Code", receipt: codeDraft.authorityProfile },
    ],
    actorId: AUTOMATION_UI_TEST_IDS.actor,
    ...overrides,
  };
}

function editorProps(overrides: Record<string, unknown> = {}) {
  return {
    catalog: catalog(),
    onCancel: vi.fn(),
    onSubmit: vi.fn(async () => undefined),
    now: () => AUTOMATION_UI_TEST_NOW,
    generateId: () => AUTOMATION_UI_TEST_IDS.deliveryTargetRevision,
    ...overrides,
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

describe("AutomationDefinitionEditor creation", () => {
  it("creates a contract-valid draft from exact host, mode, Project, profiles, trigger, and target", async () => {
    const props = editorProps();
    render(<AutomationDefinitionEditor {...props} />);

    expect(screen.getByLabelText("Name")).toHaveFocus();
    await userEvent.type(screen.getByLabelText("Name"), "Weekly summary");
    await userEvent.type(
      screen.getByLabelText("Task for each run"),
      "Summarize the Project's open work.",
    );
    // The destination environment, named the way every other surface names it.
    expect(screen.getByLabelText("Environment")).toHaveValue("local");
    await userEvent.selectOptions(screen.getByLabelText("Project"), String(workDraft.projectId));
    await userEvent.selectOptions(screen.getByLabelText("Execution profile"), [
      String(workDraft.executionProfile.profileId),
    ]);
    await userEvent.selectOptions(screen.getByLabelText("Authority profile"), [
      String(workDraft.authorityProfile.profileId),
    ]);
    // The effective authority is summarized as named text, never a token dump.
    expect(
      screen.getByText("Approval-gated · filesystem, tools · this session only"),
    ).toBeVisible();

    await userEvent.selectOptions(screen.getByLabelText("Schedule"), "once");
    fireEvent.change(screen.getByLabelText("Run at"), { target: { value: "2026-09-01T09:00" } });

    await userEvent.type(
      screen.getByLabelText("Delivery target"),
      "A confirmed weekly summary document exists in the Project.",
    );
    await userEvent.click(
      screen.getByLabelText("I confirm this delivery target for every scheduled run"),
    );
    await userEvent.click(screen.getByRole("button", { name: "Save automation" }));

    await waitFor(() => expect(props.onSubmit).toHaveBeenCalledOnce());
    const draft = (props.onSubmit as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as AutomationDefinitionDraft;
    expect(draft.displayName).toBe("Weekly summary");
    expect(draft.hostId).toBe("local");
    expect(draft.mode).toBe("work");
    expect(draft.projectId).toBe(workDraft.projectId);
    expect(draft.binding).toEqual(workDraft.binding);
    expect(draft.executionProfile).toEqual(workDraft.executionProfile);
    expect(draft.authorityProfile).toEqual(workDraft.authorityProfile);
    expect(draft.trigger).toEqual({
      kind: "once",
      scheduledAt: utcInstantFromLocalInput("2026-09-01T09:00"),
    });
    expect(draft.deliveryTarget.confirmed).toBe(true);
    expect(draft.deliveryTarget.revision).toBe(1);
    expect(draft.targetPolicy).toBe("new-thread");
  });

  it("builds a weekly-local trigger with weekdays, wall time, and IANA timezone", async () => {
    const props = editorProps();
    render(<AutomationDefinitionEditor {...props} />);

    await userEvent.type(screen.getByLabelText("Name"), "Weekly summary");
    await userEvent.type(screen.getByLabelText("Task for each run"), "Summarize open work.");
    await userEvent.selectOptions(screen.getByLabelText("Project"), String(workDraft.projectId));
    await userEvent.selectOptions(screen.getByLabelText("Execution profile"), [
      String(workDraft.executionProfile.profileId),
    ]);
    await userEvent.selectOptions(screen.getByLabelText("Authority profile"), [
      String(workDraft.authorityProfile.profileId),
    ]);
    await userEvent.selectOptions(screen.getByLabelText("Schedule"), "weekly-local");
    await userEvent.click(screen.getByRole("checkbox", { name: "Mon" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Wed" }));
    fireEvent.change(screen.getByLabelText("Time of day"), { target: { value: "09:30" } });
    fireEvent.change(screen.getByLabelText("Timezone"), { target: { value: "Europe/Oslo" } });
    await userEvent.type(screen.getByLabelText("Delivery target"), "A weekly summary exists.");
    await userEvent.click(
      screen.getByLabelText("I confirm this delivery target for every scheduled run"),
    );
    await userEvent.click(screen.getByRole("button", { name: "Save automation" }));

    await waitFor(() => expect(props.onSubmit).toHaveBeenCalledOnce());
    const draft = (props.onSubmit as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as AutomationDefinitionDraft;
    expect(draft.trigger).toEqual({
      kind: "weekly-local",
      weekdays: [1, 3],
      localTime: "09:30",
      timeZone: "Europe/Oslo",
    });
  });

  it("refuses to save without explicit delivery-target confirmation", async () => {
    const props = editorProps();
    render(<AutomationDefinitionEditor {...props} />);

    await userEvent.type(screen.getByLabelText("Name"), "Weekly summary");
    await userEvent.type(screen.getByLabelText("Task for each run"), "Summarize open work.");
    await userEvent.selectOptions(screen.getByLabelText("Project"), String(workDraft.projectId));
    await userEvent.selectOptions(screen.getByLabelText("Execution profile"), [
      String(workDraft.executionProfile.profileId),
    ]);
    await userEvent.selectOptions(screen.getByLabelText("Authority profile"), [
      String(workDraft.authorityProfile.profileId),
    ]);
    await userEvent.selectOptions(screen.getByLabelText("Schedule"), "once");
    fireEvent.change(screen.getByLabelText("Run at"), { target: { value: "2026-09-01T09:00" } });
    await userEvent.type(screen.getByLabelText("Delivery target"), "A weekly summary exists.");
    await userEvent.click(screen.getByRole("button", { name: "Save automation" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Confirm the delivery target before saving.");
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it("never offers Full access profiles and names the boundary", () => {
    const fullAccessExecution = {
      ...workDraft.executionProfile,
      profileId: AUTOMATION_UI_TEST_IDS.otherAutomation,
      executionPolicy: "full-access",
    };
    render(
      <AutomationDefinitionEditor
        {...editorProps({
          catalog: catalog({
            executionProfiles: [
              { label: "Work default", receipt: workDraft.executionProfile },
              { label: "Full access", receipt: fullAccessExecution as never },
            ],
          }),
        })}
      />,
    );

    const select = screen.getByLabelText("Execution profile");
    expect(select).not.toHaveTextContent("Full access");
    expect(
      screen.getByText(
        "Full access profiles are not eligible for automations. Choose an approval-gated profile.",
      ),
    ).toBeVisible();
  });

  it("filters Projects by mode and resets stale selections when the mode changes", async () => {
    render(<AutomationDefinitionEditor {...editorProps()} />);

    const projectSelect = screen.getByLabelText("Project");
    expect(projectSelect).toHaveTextContent("Docs Project");
    expect(projectSelect).not.toHaveTextContent("Repo Project");
    await userEvent.selectOptions(projectSelect, String(workDraft.projectId));

    await userEvent.click(screen.getByRole("radio", { name: "Code" }));
    expect(screen.getByLabelText("Project")).toHaveValue("");
    expect(screen.getByLabelText("Project")).toHaveTextContent("Repo Project");
    expect(screen.getByLabelText("Project")).not.toHaveTextContent("Docs Project");
  });

  it("fails closed with named text when no Project or profile options exist", () => {
    render(
      <AutomationDefinitionEditor
        {...editorProps({
          catalog: catalog({ projects: [], executionProfiles: [], authorityProfiles: [] }),
        })}
      />,
    );
    expect(screen.getByText("No Work Projects are available on this host.")).toBeVisible();
    expect(
      screen.getByText("No eligible execution profiles are available for this selection."),
    ).toBeVisible();
    expect(
      screen.getByText("No eligible authority profiles are available for this selection."),
    ).toBeVisible();
  });

  it("cancels from the keyboard without saving", async () => {
    const props = editorProps();
    render(<AutomationDefinitionEditor {...props} />);
    const cancel = screen.getByRole("button", { name: "Cancel" });
    cancel.focus();
    await userEvent.keyboard("{Enter}");
    expect(props.onCancel).toHaveBeenCalledOnce();
    expect(props.onSubmit).not.toHaveBeenCalled();
  });
});

describe("AutomationDefinitionEditor editing", () => {
  const definition = automationDefinitionFixture();

  it("prefills the definition, requires re-confirmation, and increments the target revision", async () => {
    const props = editorProps({ initial: definition });
    render(<AutomationDefinitionEditor {...props} />);

    expect(screen.getByLabelText("Name")).toHaveValue("Weekly summary");
    expect(screen.getByLabelText("Task for each run")).toHaveValue(
      "Summarize the Project's open work.",
    );
    expect(screen.getByLabelText("Project")).toHaveValue(String(definition.projectId));
    expect(screen.getByLabelText("Delivery target")).toHaveValue(
      "A confirmed weekly summary document exists in the Project.",
    );
    const confirmation = screen.getByLabelText(
      "I confirm this delivery target for every scheduled run",
    );
    expect(confirmation).not.toBeChecked();

    await userEvent.click(confirmation);
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(props.onSubmit).toHaveBeenCalledOnce());
    const draft = (props.onSubmit as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as AutomationDefinitionDraft;
    expect(draft.deliveryTarget.revision).toBe(definition.deliveryTarget.revision + 1);
    expect(draft.deliveryTarget.confirmedAt).toBe(AUTOMATION_UI_TEST_NOW);
  });

  it("shows the server's typed failure message and keeps the form open", async () => {
    const props = editorProps({
      initial: definition,
      onSubmit: vi.fn(async () => "The automation changed. Reload before editing."),
    });
    render(<AutomationDefinitionEditor {...props} />);

    await userEvent.click(
      screen.getByLabelText("I confirm this delivery target for every scheduled run"),
    );
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The automation changed. Reload before editing.");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });
});

describe("choosing where a routine runs", () => {
  it("calls this window's own host Local rather than by its machine name", () => {
    render(
      <AutomationDefinitionEditor
        catalog={{
          ...catalog(),
          hosts: [
            { hostId: "local", label: "This Mac" },
            { hostId: "devbox", label: "Devbox" },
          ],
        }}
        localHostId="local"
        onCancel={() => undefined}
        onSubmit={async () => undefined}
      />,
    );

    const options = within(screen.getByLabelText("Environment")).getAllByRole("option");

    expect(options.map((option) => option.textContent)).toEqual(["Local", "Devbox"]);
  });
});
