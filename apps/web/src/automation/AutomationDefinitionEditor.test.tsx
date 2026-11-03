import {
  decodeAgentProfile,
  decodeAutomationDefinition,
  decodeProjectSummary,
  type AutomationDefinitionDraft,
} from "@octant/contracts";
import { buildAutomationEditorCatalog } from "./automationEditorCatalog";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationDefinitionEditor, utcInstantFromLocalInput } from "./AutomationDefinitionEditor";
import type { AutomationEditorCatalog } from "./automationCenterModel";
import {
  AUTOMATION_UI_TEST_IDS,
  AUTOMATION_UI_TEST_NOW,
  automationChatDraftFixture,
  automationCodeDraftFixture,
  automationWorkDraftFixture,
  automationDefinitionFixture,
} from "./automationTestFixtures";

const workDraft = automationWorkDraftFixture();
const codeDraft = automationCodeDraftFixture();
const chatDraft = automationChatDraftFixture();

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
      {
        projectId: chatDraft.projectId,
        name: "Briefings",
        mode: "chat",
        projectVersion: chatDraft.projectVersion,
        binding: chatDraft.binding,
      },
    ],
    executionProfiles: [
      { label: "Work default", receipt: workDraft.executionProfile },
      { label: "Code default", receipt: codeDraft.executionProfile },
      { label: "Chat default", receipt: chatDraft.executionProfile },
    ],
    authorityProfiles: [
      { label: "Ask for approvals Work", receipt: workDraft.authorityProfile },
      { label: "Ask for approvals Code", receipt: codeDraft.authorityProfile },
      { label: "Ask for approvals Chat", receipt: chatDraft.authorityProfile },
    ],
    actorId: AUTOMATION_UI_TEST_IDS.actor,
    ...overrides,
  };
}

function ordinaryWorkCatalog(): AutomationEditorCatalog {
  return buildAutomationEditorCatalog({
    hostId: "local",
    hostLabel: "This Mac",
    actorId: AUTOMATION_UI_TEST_IDS.actor,
    projects: [
      decodeProjectSummary({
        id: workDraft.projectId,
        name: "Docs Project",
        type: "work",
        lifecycle: "active",
        pinned: false,
        rank: "0/1",
        version: 1,
        createdAt: AUTOMATION_UI_TEST_NOW,
        updatedAt: AUTOMATION_UI_TEST_NOW,
        binding: { canonicalRoot: "/tmp/docs" },
        bindingRevisionId: AUTOMATION_UI_TEST_IDS.bindingRevision,
      }),
    ],
    profiles: [
      decodeAgentProfile({
        id: AUTOMATION_UI_TEST_IDS.executionProfile,
        displayName: "Work default",
        approvedSkillIds: [],
        toolConstraints: [],
        modelConstraints: ["approved-model"],
        defaultExecutionPolicy: "approval-gated",
        defaultPermissionPersistence: "current-session",
        compatibleModes: ["work", "code"],
        version: 1,
        createdAt: AUTOMATION_UI_TEST_NOW,
        updatedAt: AUTOMATION_UI_TEST_NOW,
      }),
    ],
    providerChoicesByMode: {
      work: [
        { providerInstanceId: AUTOMATION_UI_TEST_IDS.providerInstance, modelId: "approved-model" },
      ],
      code: [],
    },
  });
}

async function chooseLabeledOption(label: string, optionName: string): Promise<void> {
  await userEvent.click(screen.getByLabelText(label));
  await userEvent.click(await screen.findByRole("option", { name: optionName }));
}

function editorProps(overrides: Record<string, unknown> = {}) {
  return {
    catalog: catalog(),
    onCancel: vi.fn(),
    onSubmit: vi.fn(async (_draft: AutomationDefinitionDraft) => undefined),
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
    expect(screen.getByLabelText("Environment")).toHaveTextContent("This Mac");
    await chooseLabeledOption("Project", "Docs Project");
    await chooseLabeledOption("Execution profile", "Work default");
    await chooseLabeledOption("Authority profile", "Ask for approvals Work");
    // The effective authority is summarized as named text, never a token dump.
    expect(
      screen.getByText("Ask for approvals · filesystem, shell, git, tools · this session only"),
    ).toBeVisible();

    await chooseLabeledOption("Schedule", "Run once");
    fireEvent.change(screen.getByLabelText("Run at"), { target: { value: "2026-09-01T09:00" } });

    await userEvent.type(
      screen.getByLabelText("Delivery"),
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
    // Asking first is saved explicitly; the Project's mode is opted into.
    expect(draft.runLevel).toBe("ask-first");
    expect(draft.projectLevel).toBeUndefined();
  });

  it("creates a Work routine from the real catalog with one ordinary profile", async () => {
    const props = editorProps({ catalog: ordinaryWorkCatalog() });
    render(<AutomationDefinitionEditor {...props} />);
    await userEvent.type(screen.getByLabelText("Name"), "Weekly summary");
    await userEvent.type(screen.getByLabelText("Task for each run"), "Summarize open work.");
    await chooseLabeledOption("Project", "Docs Project");
    await chooseLabeledOption("Execution profile", "Work default");
    await chooseLabeledOption("Authority profile", "Work default");
    await chooseLabeledOption("Schedule", "Run once");
    fireEvent.change(screen.getByLabelText("Run at"), { target: { value: "2026-09-01T09:00" } });
    await userEvent.type(screen.getByLabelText("Delivery"), "A weekly summary exists.");
    await userEvent.click(
      screen.getByLabelText("I confirm this delivery target for every scheduled run"),
    );
    const draft = await savedDraft(props);
    expect(draft.authorityProfile.effective).toMatchObject({
      filesystem: true,
      shell: true,
      git: true,
      executionPolicy: "approval-gated",
    });
    expect(draft.runLevel).toBe("ask-first");
  });

  async function fillWorkRoutine(): Promise<void> {
    await userEvent.type(screen.getByLabelText("Name"), "Weekly summary");
    await userEvent.type(screen.getByLabelText("Task for each run"), "Summarize open work.");
    await chooseLabeledOption("Project", "Docs Project");
    await chooseLabeledOption("Execution profile", "Work default");
    await chooseLabeledOption("Authority profile", "Ask for approvals Work");
    await chooseLabeledOption("Schedule", "Run once");
    fireEvent.change(screen.getByLabelText("Run at"), { target: { value: "2026-09-01T09:00" } });
    await userEvent.type(screen.getByLabelText("Delivery"), "A weekly summary exists.");
    await userEvent.click(
      screen.getByLabelText("I confirm this delivery target for every scheduled run"),
    );
  }

  async function savedDraft(props: ReturnType<typeof editorProps>) {
    await userEvent.click(screen.getByRole("button", { name: "Save automation" }));
    await waitFor(() => expect(props.onSubmit).toHaveBeenCalledOnce());
    return (props.onSubmit as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as AutomationDefinitionDraft;
  }

  it("previews a bounded Work file trigger and submits the chosen folder separately from readiness", async () => {
    const submit = vi.fn(async (_draft: AutomationDefinitionDraft) => undefined);
    render(<AutomationDefinitionEditor {...editorProps({ onSubmit: submit })} />);
    await fillWorkRoutine();
    await chooseLabeledOption("Schedule", "When files arrive or change");
    fireEvent.change(screen.getByLabelText("Input folder in this Project"), {
      target: { value: "Inbox" },
    });
    fireEvent.change(screen.getByLabelText("File suffixes"), { target: { value: "PDF, .txt" } });
    fireEvent.change(screen.getByLabelText("Excluded folders"), {
      target: { value: "output, processed" },
    });
    expect(screen.getByLabelText("Automatic runs per arm")).toHaveValue(8);
    expect(screen.getByRole("region", { name: "File arrival preview" })).toHaveTextContent(
      "first complete scan is a baseline",
    );
    expect(screen.getByRole("region", { name: "File arrival preview" })).toHaveTextContent(
      "At most 8 automatic runs per arm",
    );
    expect(screen.getByRole("region", { name: "File arrival preview" })).toHaveTextContent(
      "cannot tell which program wrote a file",
    );
    await userEvent.click(screen.getByRole("button", { name: "Save automation" }));
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(submit.mock.calls[0]?.[0]).toMatchObject({
      mode: "work",
      targetPolicy: "new-thread",
      trigger: {
        kind: "file-arrival",
        directory: "Inbox",
        includeExtensions: ["pdf", "txt"],
        excludeDirectories: ["output", "processed"],
        settleSeconds: 5,
        automaticStartLimit: 8,
      },
    });
  });

  it("keeps file choices and the task on unsafe-path or host preparation refusal", async () => {
    const submit = vi.fn(
      async (_draft: AutomationDefinitionDraft) =>
        "The input folder was not available. Choose an existing Project folder.",
    );
    render(<AutomationDefinitionEditor {...editorProps({ onSubmit: submit })} />);
    await fillWorkRoutine();
    await chooseLabeledOption("Schedule", "When files arrive or change");
    fireEvent.change(screen.getByLabelText("Input folder in this Project"), {
      target: { value: "../outside" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Save automation" }));
    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Input folder in this Project")).toHaveValue("../outside");
    fireEvent.change(screen.getByLabelText("Input folder in this Project"), {
      target: { value: "Inbox" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Save automation" }));
    await screen.findByText(
      "The input folder was not available. Choose an existing Project folder.",
    );
    expect(screen.getByLabelText("Input folder in this Project")).toHaveValue("Inbox");
    expect(screen.getByLabelText("Task for each run")).toHaveValue("Summarize open work.");
    expect(screen.getByLabelText("Automatic runs per arm")).toHaveValue(8);
  });

  it.each(["Code", "Chat"])("does not offer file arrivals for %s", async (mode) => {
    render(<AutomationDefinitionEditor {...editorProps()} />);
    await userEvent.click(screen.getByRole("button", { name: mode, exact: true }));
    await userEvent.click(screen.getByLabelText("Schedule"));
    expect(
      screen.queryByRole("option", { name: "When files arrive or change" }),
    ).not.toBeInTheDocument();
  });

  it("records the person's choice to run at the Project's mode, Full access included", async () => {
    const props = editorProps();
    render(<AutomationDefinitionEditor {...props} />);
    await fillWorkRoutine();

    expect(screen.getByText(/Full access means no sandbox and no prompts/)).toBeVisible();
    await chooseLabeledOption("Mode for each run", "The Project's mode");

    const draft = await savedDraft(props);
    expect(draft.projectLevel).toBe("opted-in");
    expect(draft.runLevel).toBeUndefined();
  });

  it("records a level picked on the routine itself, apart from the Project's", async () => {
    const props = editorProps();
    render(<AutomationDefinitionEditor {...props} />);
    await fillWorkRoutine();

    await chooseLabeledOption("Mode for each run", "Accept edits");

    const draft = await savedDraft(props);
    expect(draft.runLevel).toBe("auto-accept-edits");
    expect(draft.projectLevel).toBeUndefined();
  });

  it("builds a Chat routine with Chat's authority and no level to pick", async () => {
    const props = editorProps();
    render(<AutomationDefinitionEditor {...props} />);

    await userEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(screen.queryByLabelText("Mode for each run")).toBeNull();
    expect(screen.getByText(/no files, commands, or Git/)).toBeVisible();
    await userEvent.type(screen.getByLabelText("Name"), "Morning briefing");
    await userEvent.type(screen.getByLabelText("Task for each run"), "Brief me on the day.");
    await chooseLabeledOption("Project", "Briefings");
    await chooseLabeledOption("Execution profile", "Chat default");
    // Work's and Code's authority grant a folder, so only Chat's is offered.
    await userEvent.click(screen.getByLabelText("Authority profile"));
    expect(screen.queryByRole("option", { name: "Ask for approvals Work" })).toBeNull();
    await userEvent.click(await screen.findByRole("option", { name: "Ask for approvals Chat" }));
    await chooseLabeledOption("Schedule", "Run once");
    fireEvent.change(screen.getByLabelText("Run at"), { target: { value: "2026-09-01T09:00" } });
    await userEvent.type(screen.getByLabelText("Delivery"), "A short briefing is in the thread.");
    await userEvent.click(
      screen.getByLabelText("I confirm this delivery target for every scheduled run"),
    );

    const draft = await savedDraft(props);
    expect(draft.mode).toBe("chat");
    expect(draft.binding.kind).toBe("chat");
    expect(draft.authorityProfile.effective).toMatchObject({
      filesystem: false,
      shell: false,
      git: false,
    });
    expect(draft.projectLevel).toBeUndefined();
    expect(draft.runLevel).toBeUndefined();
  });

  it("offers merging its pull requests only to a Code routine, and records the choice", async () => {
    const props = editorProps();
    render(<AutomationDefinitionEditor {...props} />);

    await userEvent.type(screen.getByLabelText("Name"), "Nightly fix");
    await userEvent.type(screen.getByLabelText("Task for each run"), "Fix the flaky test.");
    await chooseLabeledOption("Project", "Docs Project");
    expect(screen.queryByLabelText("Merge the pull requests it opens")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Code" }));
    await chooseLabeledOption("Project", "Repo Project");
    await chooseLabeledOption("Execution profile", "Code default");
    await chooseLabeledOption("Authority profile", "Ask for approvals Code");
    await chooseLabeledOption("Schedule", "Run once");
    fireEvent.change(screen.getByLabelText("Run at"), { target: { value: "2026-09-01T09:00" } });
    await userEvent.type(screen.getByLabelText("Delivery"), "A fix is merged.");
    const optIn = screen.getByLabelText("Merge the pull requests it opens");
    expect(optIn).toHaveAccessibleDescription(/required checks passing/);
    await userEvent.click(optIn);
    await userEvent.click(
      screen.getByLabelText("I confirm this delivery target for every scheduled run"),
    );
    await userEvent.click(screen.getByRole("button", { name: "Save automation" }));

    await waitFor(() => expect(props.onSubmit).toHaveBeenCalledOnce());
    const draft = (props.onSubmit as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as AutomationDefinitionDraft;
    expect(draft.agentMerge).toBe("allowed");
    expect(draft.runLevel).toBe("ask-first");
  });

  it("builds a weekly-local trigger with weekdays, wall time, and IANA timezone", async () => {
    const props = editorProps();
    render(<AutomationDefinitionEditor {...props} />);

    await userEvent.type(screen.getByLabelText("Name"), "Weekly summary");
    await userEvent.type(screen.getByLabelText("Task for each run"), "Summarize open work.");
    await chooseLabeledOption("Project", "Docs Project");
    await chooseLabeledOption("Execution profile", "Work default");
    await chooseLabeledOption("Authority profile", "Ask for approvals Work");
    await chooseLabeledOption("Schedule", "Weekly on chosen days");
    await userEvent.click(screen.getByRole("checkbox", { name: "Mon" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Wed" }));
    fireEvent.change(screen.getByLabelText("Time of day"), { target: { value: "09:30" } });
    fireEvent.change(screen.getByLabelText("Timezone"), { target: { value: "Europe/Oslo" } });
    await userEvent.type(screen.getByLabelText("Delivery"), "A weekly summary exists.");
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
    await chooseLabeledOption("Project", "Docs Project");
    await chooseLabeledOption("Execution profile", "Work default");
    await chooseLabeledOption("Authority profile", "Ask for approvals Work");
    await chooseLabeledOption("Schedule", "Run once");
    fireEvent.change(screen.getByLabelText("Run at"), { target: { value: "2026-09-01T09:00" } });
    await userEvent.type(screen.getByLabelText("Delivery"), "A weekly summary exists.");
    await userEvent.click(screen.getByRole("button", { name: "Save automation" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Confirm the delivery target before saving.");
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it("never offers Full access profiles and names the boundary", async () => {
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

    await userEvent.click(screen.getByLabelText("Execution profile"));
    expect(await screen.findByRole("option", { name: "Work default" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Full access" })).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Full access profiles are not eligible for automations. Choose an approval-gated profile.",
      ),
    ).toBeVisible();
  });

  it("filters Projects by mode and resets stale selections when the mode changes", async () => {
    render(<AutomationDefinitionEditor {...editorProps()} />);

    await userEvent.click(screen.getByLabelText("Project"));
    expect(await screen.findByRole("option", { name: "Docs Project" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Repo Project" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("option", { name: "Docs Project" }));

    await userEvent.click(screen.getByRole("button", { name: "Code" }));
    expect(screen.getByLabelText("Project")).toHaveTextContent("Choose a Project");
    await userEvent.click(screen.getByLabelText("Project"));
    expect(await screen.findByRole("option", { name: "Repo Project" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Docs Project" })).not.toBeInTheDocument();
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
    expect(screen.getByLabelText("Project")).toHaveTextContent("Docs Project");
    expect(screen.getByLabelText("Delivery")).toHaveValue(
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

  it("repairs a Work routine's missing shell and Git only when the person saves it", async () => {
    const authority = { ...workDraft.authorityProfile.effective, shell: false, git: false };
    const blocked = decodeAutomationDefinition({
      ...automationDefinitionFixture(),
      authorityProfile: {
        ...workDraft.authorityProfile,
        profileId: String(workDraft.executionProfile.profileId),
        requested: authority,
        effective: authority,
      },
    });
    const props = editorProps({ catalog: ordinaryWorkCatalog(), initial: blocked });
    render(<AutomationDefinitionEditor {...props} />);
    expect(screen.getByLabelText("Authority profile")).toHaveTextContent("Work default");
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(blocked.authorityProfile.effective.shell).toBe(false);
    await userEvent.click(
      screen.getByLabelText("I confirm this delivery target for every scheduled run"),
    );
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(props.onSubmit).toHaveBeenCalledOnce());
    const [call] = props.onSubmit.mock.calls;
    expect(call?.[0]).toMatchObject({
      runLevel: "ask-first",
      authorityProfile: {
        effective: { filesystem: true, shell: true, git: true, executionPolicy: "approval-gated" },
      },
    });
    expect(blocked.authorityProfile.effective.shell).toBe(false);
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
  it("calls this window's own host Local rather than by its machine name", async () => {
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

    await userEvent.click(screen.getByLabelText("Environment"));
    const options = await screen.findAllByRole("option");

    expect(options.map((option) => option.textContent)).toEqual(["Local", "Devbox"]);
  });
});
