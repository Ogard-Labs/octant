import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  decodeProviderInstance,
  decodeProviderInstanceId,
  decodeProviderModelId,
  type ProviderObservedState,
} from "@octant/contracts";
import { buildModelPickerGroups } from "@octant/domain";
import { WorkOverview, type WorkOverviewModel, type OverviewSectionStatus } from "./WorkOverview";

describe("WorkOverview", () => {
  it("renders confined Work sections and excludes Code affordances", () => {
    render(<WorkOverview model={populatedModel()} onCreateThread={vi.fn(async () => true)} />);

    expect(screen.getByRole("region", { name: "Work overview" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Produced by Octant" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Recent tasks" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Approvals" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Versions and recent changes" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Validation" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Exports and handoffs" })).toBeVisible();
    expect(screen.getByText("Quarterly notes")).toBeVisible();
    expect(screen.getByText("Draft brief thread")).toBeVisible();
    expect(screen.getByText("Approve destructive rename")).toBeVisible();
    expect(screen.getByText("v3 · Quarterly notes")).toBeVisible();
    expect(screen.getByText("DOCX · limited fidelity")).toBeVisible();
    expect(screen.getByText("Exported PDF")).toBeVisible();

    expect(
      screen.queryByText(/Git|worktree|commit|pull request|Monaco|coding test/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Open Git|Open terminal|Open PR/i }),
    ).not.toBeInTheDocument();
  });

  it("leads with where the work stands and which dates are due, read from STATUS.md", () => {
    render(
      <WorkOverview
        model={{
          ...populatedModel(),
          status: {
            projectId: "00000000-0000-4000-8000-000000000001" as never,
            hasAgentsFile: true,
            hasStatusFile: true,
            lastUpdatedOn: "2026-08-20",
            stale: true,
            currentStatus: "Offer v2 sent, waiting on procurement.",
            followUps: [
              { date: "2026-09-14", text: "Call Dana about scope", state: "due-soon" },
              { date: "2026-10-01", text: "Kick-off if signed", state: "upcoming" },
            ],
            deadlines: [{ date: "2026-09-01", text: "Signed offer was due", state: "overdue" }],
          },
        }}
        onCreateThread={vi.fn(async () => true)}
      />,
    );

    const status = screen.getByRole("region", { name: "Status" });
    expect(within(status).getByText("Last updated 2026-08-20 · stale")).toBeVisible();
    expect(within(status).getByText("Offer v2 sent, waiting on procurement.")).toBeVisible();
    const due = within(status).getByRole("status");
    expect(within(due).getByText("Signed offer was due")).toBeVisible();
    expect(within(due).getByText("2026-09-01 · overdue")).toBeVisible();
    expect(within(due).getByText("2026-09-14 · due soon")).toBeVisible();
    expect(within(due).queryByText("Kick-off if signed")).not.toBeInTheDocument();
    expect(within(status).getByText("Kick-off if signed")).toBeVisible();
  });

  it("says when a Project has no STATUS.md yet instead of showing an empty card", () => {
    render(
      <WorkOverview
        model={{
          ...emptyModel(),
          status: {
            projectId: "00000000-0000-4000-8000-000000000001" as never,
            hasAgentsFile: false,
            hasStatusFile: false,
            stale: true,
            followUps: [],
            deadlines: [],
          },
        }}
        onCreateThread={vi.fn(async () => true)}
      />,
    );
    expect(screen.getByText(/No STATUS.md yet/)).toBeVisible();
  });

  it("distinguishes an active workflow from an ordinary related thread by its rendered detail and still opens the underlying thread", () => {
    const onOpenThread = vi.fn();
    const model: WorkOverviewModel = {
      ...populatedModel(),
      workflowsAndThreads: {
        status: "ready",
        items: [
          { id: "thread-1", label: "Draft brief thread", detail: "Active workflow" },
          { id: "thread-2", label: "Ask a quick question", detail: "Active thread" },
        ],
      },
    };

    render(
      <WorkOverview
        model={model}
        onCreateThread={vi.fn(async () => true)}
        onOpenThread={onOpenThread}
      />,
    );

    const section = screen.getByRole("region", { name: "Recent tasks" });
    expect(within(section).getByText("Active workflow")).toBeVisible();
    expect(within(section).getByText("Active thread")).toBeVisible();

    fireEvent.click(within(section).getByText("Draft brief thread"));
    expect(onOpenThread).toHaveBeenCalledWith("thread-1");
  });

  it("keeps section states independent so one failure does not blank others", () => {
    const model: WorkOverviewModel = {
      ...populatedModel(),
      approvals: { status: "failure", message: "Approvals could not be loaded." },
      versions: { status: "stale", message: "Versions may be out of date.", items: [] },
      exports: { status: "unauthorized", message: "Export history is unauthorized." },
    };

    render(<WorkOverview model={model} onCreateThread={vi.fn(async () => true)} />);

    const approvals = screen.getByRole("region", { name: "Approvals" });
    expect(within(approvals).getByRole("alert")).toHaveTextContent(
      "Approvals could not be loaded.",
    );
    expect(screen.getByText("Quarterly notes")).toBeVisible();
    expect(screen.getByText("Draft brief thread")).toBeVisible();

    const versions = screen.getByRole("region", { name: "Versions and recent changes" });
    expect(within(versions).getByRole("status")).toHaveTextContent("Versions may be out of date.");

    const exports = screen.getByRole("region", { name: "Exports and handoffs" });
    expect(within(exports).getByRole("alert")).toHaveTextContent("Export history is unauthorized.");
  });

  it.each([
    ["loading", "Loading recent files and artifacts."],
    ["empty", "No recent files or artifacts in this Project yet."],
    ["unavailable", "Recent files are unavailable."],
    ["unauthorized", "Recent files are unauthorized."],
    ["stale", "Recent files may be out of date."],
    ["failure", "Recent files could not be loaded."],
  ] as const satisfies ReadonlyArray<readonly [OverviewSectionStatus, string]>)(
    "renders the %s state for a section",
    (status, message) => {
      const model: WorkOverviewModel = {
        ...emptyModel(),
        filesAndArtifacts: { status, message, items: [] },
      };
      render(<WorkOverview model={model} onCreateThread={vi.fn(async () => true)} />);
      const section = screen.getByRole("region", { name: "Produced by Octant" });
      const role =
        status === "loading" || status === "empty" || status === "stale" ? "status" : "alert";
      expect(within(section).getByRole(role)).toHaveTextContent(message);
    },
  );

  it("creates a thread through the quick-start composer and preserves drafts on failure", async () => {
    const onCreateThread = vi.fn(async () => false);
    render(<WorkOverview model={emptyModel()} onCreateThread={onCreateThread} />);

    const composer = screen.getByRole("region", { name: "Work quick start" });
    const input = within(composer).getByRole("textbox", { name: "Start a new task" });
    fireEvent.change(input, { target: { value: "Summarize the brief" } });
    fireEvent.click(within(composer).getByRole("button", { name: "Start task" }));

    await waitFor(() => {
      expect(onCreateThread).toHaveBeenCalledWith("Summarize the brief");
    });
    expect(input).toHaveValue("Summarize the brief");
  });

  it("clears the quick-start draft after authoritative creation succeeds", async () => {
    const onCreateThread = vi.fn(async () => true);
    render(<WorkOverview model={emptyModel()} onCreateThread={onCreateThread} />);

    const composer = screen.getByRole("region", { name: "Work quick start" });
    const input = within(composer).getByRole("textbox", { name: "Start a new task" });
    fireEvent.change(input, { target: { value: "Open the quarterly notes" } });
    fireEvent.click(within(composer).getByRole("button", { name: "Start task" }));

    await waitFor(() => {
      expect(onCreateThread).toHaveBeenCalledWith("Open the quarterly notes");
      expect(input).toHaveValue("");
    });
  });

  it("confirms exact Project confinement and allows provider/model selection", async () => {
    const user = userEvent.setup();
    const onSelectProvider = vi.fn();
    const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-0000000000a1");
    const modelId = decodeProviderModelId("model-one");
    const provider = decodeProviderInstance({
      id: instanceId,
      displayName: "Local OpenCode",
      driverKind: "opencode",
      configuration: { kind: "opencode-cli", binaryPath: "/opt/homebrew/bin/opencode" },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: "2026-07-14T10:00:00.000Z",
      updatedAt: "2026-07-14T10:00:00.000Z",
    });
    const providerGroups = buildModelPickerGroups({
      instances: [provider],
      observedByInstance: new Map([
        [
          instanceId,
          {
            instanceId,
            readiness: "ready" as const,
            processState: "running" as const,
            observedAt: "2026-07-14T10:00:00.000Z" as never,
            lastSuccessfulProbeAt: "2026-07-14T10:00:00.000Z" as never,
            capabilities: {
              streaming: "supported",
              resume: "unavailable",
              interruption: "supported",
              approvals: "supported",
              userQuestions: "supported",
              reasoning: "unavailable",
              usage: "supported",
              toolActivity: "supported",
              fileChanges: "unavailable",
              diffs: "unavailable",
              taskProgress: "supported",
              nativeChildAgents: "unavailable",
              harnessAutoReview: "unsupported",
              nativeAttachments: "unavailable",
              nativeWebResearch: "unavailable",
              appManagedTools: "supported",
              citations: "unavailable",
            },
            models: [
              {
                id: modelId,
                displayName: "Model One",
                source: "discovered" as const,
                verification: "verified" as const,
                reasoning: "unavailable" as const,
                inputModalities: ["text" as const],
                options: [],
                capabilityEvidence: [
                  {
                    capability: "tool-calling" as const,
                    support: "supported" as const,
                    source: "endpoint-observation" as const,
                    confidence: "high" as const,
                    protocol: "acp" as const,
                    observedAt: "2026-07-14T10:00:00.000Z" as never,
                    invalidated: false,
                  },
                ],
              },
            ],
          } as ProviderObservedState,
        ],
      ]),
      mode: "work",
    });

    render(
      <WorkOverview
        model={emptyModel()}
        onCreateThread={vi.fn(async () => true)}
        onSelectProvider={onSelectProvider}
        projectName="Quarterly planning"
        providerGroups={providerGroups}
        selectedModelId={modelId}
        selectedProviderInstanceId={instanceId}
      />,
    );

    const composer = screen.getByRole("region", { name: "Work quick start" });
    expect(within(composer).getByText("Quarterly planning")).toBeVisible();
    expect(within(composer).getByText("Confined to this Project")).toBeVisible();
    expect(within(composer).getByRole("button", { name: "Provider and model" })).toHaveTextContent(
      "Model One",
    );
    await user.click(within(composer).getByRole("button", { name: "Provider and model" }));
    await user.click(await screen.findByRole("option", { name: "Model One" }));
    expect(onSelectProvider).toHaveBeenCalledWith({ providerInstanceId: instanceId, modelId });
  });

  it("disables quick-start when thread creation is unavailable", () => {
    render(
      <WorkOverview
        createThreadAvailable={false}
        model={emptyModel()}
        onCreateThread={vi.fn(async () => true)}
      />,
    );

    const composer = screen.getByRole("region", { name: "Work quick start" });
    expect(within(composer).getByRole("textbox", { name: "Start a new task" })).toBeDisabled();
    expect(within(composer).getByRole("button", { name: "Start task" })).toBeDisabled();
    expect(
      within(composer).getByText("Thread creation is unavailable for this Project."),
    ).toBeVisible();
  });

  it("keeps provider setup reachable when no Work provider is ready", async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    render(
      <WorkOverview
        createThreadAvailable={false}
        model={emptyModel()}
        onCreateThread={vi.fn(async () => true)}
        onOpenSettings={onOpenSettings}
        onSelectProvider={vi.fn()}
        providerGroups={[]}
      />,
    );

    const composer = screen.getByRole("region", { name: "Work quick start" });
    const providerSetup = within(composer).getByRole("button", { name: "Provider and model" });
    expect(providerSetup).toHaveTextContent("No provider ready");
    expect(providerSetup).toBeEnabled();

    await user.click(providerSetup);
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(within(composer).getByRole("button", { name: "Start task" })).toBeDisabled();
  });

  it("creates a starter artifact with the default markdown path and preserves content on failure", async () => {
    const user = userEvent.setup();
    const onCreateStarterArtifact = vi.fn(async () => false);
    render(
      <WorkOverview
        createStarterArtifactAvailable
        model={emptyModel()}
        onCreateStarterArtifact={onCreateStarterArtifact}
        onCreateThread={vi.fn(async () => true)}
      />,
    );

    const composer = screen.getByRole("region", { name: "Create starter artifact" });
    const pathInput = within(composer).getByRole("textbox", { name: "Artifact path" });
    const contentInput = within(composer).getByRole("textbox", {
      name: "Starter artifact content",
    });

    expect(pathInput).toHaveValue("notes.md");
    expect(within(composer).getByRole("combobox", { name: "Artifact kind" })).toHaveTextContent(
      "markdown",
    );

    await user.type(contentInput, "# Kickoff notes");
    await user.click(within(composer).getByRole("button", { name: "Create starter artifact" }));

    await waitFor(() => {
      expect(onCreateStarterArtifact).toHaveBeenCalledWith({
        format: "markdown",
        displayName: "notes.md",
        content: "# Kickoff notes",
      });
    });
    expect(contentInput).toHaveValue("# Kickoff notes");
  });

  it("clears the starter artifact draft after authoritative creation succeeds", async () => {
    const user = userEvent.setup();
    const onCreateStarterArtifact = vi.fn(async () => true);
    render(
      <WorkOverview
        createStarterArtifactAvailable
        model={emptyModel()}
        onCreateStarterArtifact={onCreateStarterArtifact}
        onCreateThread={vi.fn(async () => true)}
      />,
    );

    const composer = screen.getByRole("region", { name: "Create starter artifact" });
    const pathInput = within(composer).getByRole("textbox", { name: "Artifact path" });
    const contentInput = within(composer).getByRole("textbox", {
      name: "Starter artifact content",
    });
    await user.clear(pathInput);
    await user.type(pathInput, "starter.md");
    await user.type(contentInput, "Hello workspace");
    await user.click(within(composer).getByRole("button", { name: "Create starter artifact" }));

    await waitFor(() => {
      expect(onCreateStarterArtifact).toHaveBeenCalledWith({
        format: "markdown",
        displayName: "starter.md",
        content: "Hello workspace",
      });
      expect(pathInput).toHaveValue("notes.md");
      expect(contentInput).toHaveValue("");
    });
  });

  it("fails closed and hides starter artifact creation when unavailable", () => {
    render(
      <WorkOverview
        createStarterArtifactAvailable={false}
        model={emptyModel()}
        onCreateStarterArtifact={vi.fn(async () => true)}
        onCreateThread={vi.fn(async () => true)}
      />,
    );

    expect(
      screen.queryByRole("region", { name: "Create starter artifact" }),
    ).not.toBeInTheDocument();
  });
});

function populatedModel(): WorkOverviewModel {
  return {
    folder: {
      status: "ready",
      items: [{ id: "folder:offers", label: "offers", detail: "Folder" }],
    },
    filesAndArtifacts: {
      status: "ready",
      items: [{ id: "artifact-1", label: "Quarterly notes", detail: "DOCX" }],
    },
    workflowsAndThreads: {
      status: "ready",
      items: [{ id: "thread-1", label: "Draft brief thread", detail: "Active" }],
    },
    approvals: {
      status: "ready",
      items: [{ id: "approval-1", label: "Approve destructive rename", detail: "Waiting" }],
    },
    versions: {
      status: "ready",
      items: [{ id: "version-1", label: "v3 · Quarterly notes", detail: "Revised" }],
    },
    validation: {
      status: "ready",
      items: [
        { id: "validation-1", label: "DOCX · limited fidelity", detail: "Honest capability" },
      ],
    },
    exports: {
      status: "ready",
      items: [{ id: "export-1", label: "Exported PDF", detail: "External handoff" }],
    },
  };
}

function emptyModel(): WorkOverviewModel {
  return {
    folder: { status: "empty", message: "The folder is empty.", items: [] },
    filesAndArtifacts: {
      status: "empty",
      message: "No recent files or artifacts in this Project yet.",
      items: [],
    },
    workflowsAndThreads: {
      status: "empty",
      message: "No active workflows or related threads yet.",
      items: [],
    },
    approvals: { status: "empty", message: "No pending approvals.", items: [] },
    versions: { status: "empty", message: "No versions recorded yet.", items: [] },
    validation: {
      status: "empty",
      message: "No validation status for this Project yet.",
      items: [],
    },
    exports: { status: "empty", message: "No exports or handoffs recorded.", items: [] },
  };
}
