import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
  NativeHarnessProjectRoutingOverride,
  NativeHarnessRoutingConfiguration,
  ProviderInstance,
  ProviderObservedState,
} from "@octant/contracts";
import { buildModelPickerGroups } from "@octant/domain";
import { chooseSelectFieldOption } from "../test/chooseSelectFieldOption.test-support";
import { ProjectModelRolesSection } from "./ProjectModelRolesSection";

const hostId = "00000000-0000-0000-0000-000000000001";
const now = "2026-11-15T12:00:00.000Z";
const endpoint = "10000000-0000-4000-8000-00000000000a";
const projectId = "20000000-0000-4000-8000-000000000001";
const models = ["scribe-1", "scribe-2", "scribe-3"];

const candidate = (modelId: string) => ({
  hostId: hostId as never,
  providerInstanceId: endpoint as never,
  modelId: modelId as never,
});
const configuration = (
  slots: Readonly<Record<string, ReadonlyArray<string>>>,
): NativeHarnessRoutingConfiguration => ({
  slots: Object.entries(slots).map(([id, ids]) => ({
    id: id as never,
    candidates: ids.map(candidate),
  })),
  jobSlots: [],
});
const hostSettings = (config: NativeHarnessRoutingConfiguration, version = 1) => ({
  configuration: config,
  version: version as never,
  updatedAt: now as never,
});
const override = (
  config: NativeHarnessRoutingConfiguration,
  version = 1,
): NativeHarnessProjectRoutingOverride => ({
  projectId: projectId as never,
  configuration: config,
  version: version as never,
  updatedAt: now as never,
});

function groups() {
  const instance = {
    id: endpoint,
    displayName: "Scribe Local",
    driverKind: "openai-compatible",
    configuration: {
      kind: "openai-compatible-http",
      baseUrl: "http://127.0.0.1:11434/v1/",
      authentication: "none",
      protocol: "responses",
      manualModelIds: [],
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: now,
    updatedAt: now,
  } as unknown as ProviderInstance;
  const observed = {
    instanceId: endpoint,
    readiness: "ready",
    processState: "running",
    models: models.map((id) => ({
      id,
      displayName: id,
      reasoning: "unsupported",
      inputModalities: ["text", "image"],
      options: [],
      source: "discovered",
      verification: "verified",
    })),
    capabilities: {
      streaming: "supported",
      resume: "unsupported",
      interruption: "supported",
      approvals: "unsupported",
      userQuestions: "unsupported",
      reasoning: "unsupported",
      usage: "supported",
      toolActivity: "supported",
      fileChanges: "unsupported",
      diffs: "unsupported",
      taskProgress: "unsupported",
      nativeChildAgents: "unsupported",
      harnessAutoReview: "unsupported",
      nativeAttachments: "unsupported",
      nativeWebResearch: "unsupported",
      appManagedTools: "supported",
      citations: "unsupported",
    },
    observedAt: now,
  } as unknown as ProviderObservedState;
  return buildModelPickerGroups({
    instances: [instance],
    observedByInstance: new Map([[endpoint as never, observed]]),
    mode: "chat",
  });
}

function renderSection(input: {
  readonly host: NativeHarnessRoutingConfiguration;
  readonly project?: NativeHarnessRoutingConfiguration;
  readonly projectVersion?: number;
  readonly setProjectRouting?: ReturnType<typeof vi.fn>;
  readonly updateRouting?: ReturnType<typeof vi.fn>;
}) {
  const client = {
    routing: vi.fn(async () => hostSettings(input.host)),
    updateRouting: input.updateRouting ?? vi.fn(),
    projectRoutingState: vi.fn(async () => ({
      override: input.project === undefined ? null : override(input.project, input.projectVersion),
      version: input.projectVersion ?? (input.project === undefined ? 0 : 1),
    })),
    setProjectRouting: input.setProjectRouting ?? vi.fn(),
  };
  render(
    <ProjectModelRolesSection
      client={client as never}
      groups={groups()}
      hostId={hostId}
      projectId={projectId}
    />,
  );
  return client;
}

const savedOverride = (config: NativeHarnessRoutingConfiguration, version = 1) =>
  vi.fn(async () => ({
    kind: "project-routing-override" as const,
    override: override(config, version),
  }));

describe("ProjectModelRolesSection", () => {
  it("uses Settings for every role until the Project chooses, and shows Settings' models read-only", async () => {
    renderSection({ host: configuration({ default: ["scribe-1", "scribe-2"] }) });

    const builder = await screen.findByRole("group", { name: "Builder" });
    expect(screen.getByRole("combobox", { name: "Builder for this Project" })).toHaveTextContent(
      "Use Settings",
    );
    expect(within(builder).getByText("scribe-1")).toBeVisible();
    expect(within(builder).getByText("scribe-2")).toBeVisible();
    expect(within(builder).queryByRole("button", { name: /Remove/ })).not.toBeInTheDocument();
    expect(within(builder).getByRole("checkbox", { name: "Ask before using" })).toBeDisabled();
    for (const role of ["Scout", "Quick edit", "Hard problems", "Reviewer"]) {
      expect(screen.getByRole("combobox", { name: `${role} for this Project` })).toHaveTextContent(
        "Use Settings",
      );
    }
  });

  it("starts a chosen role from Settings' own and leaves the other roles to Settings", async () => {
    const user = userEvent.setup();
    const host = configuration({ default: ["scribe-1", "scribe-2"], task: ["scribe-3"] });
    const setProjectRouting = savedOverride(configuration({ default: ["scribe-1", "scribe-2"] }));
    const client = renderSection({ host, setProjectRouting });

    await chooseSelectFieldOption(
      user,
      await screen.findByRole("combobox", { name: "Builder for this Project" }),
      "Choose for this Project",
    );

    expect(client.setProjectRouting).toHaveBeenCalledWith(projectId, {
      configuration: configuration({ default: ["scribe-1", "scribe-2"] }),
      expectedVersion: 0,
    });
    expect(screen.getByRole("combobox", { name: "Scout for this Project" })).toHaveTextContent(
      "Use Settings",
    );
  });

  it("saves a Project's smaller list and goes back to Settings by dropping the role", async () => {
    const user = userEvent.setup();
    const host = configuration({ default: ["scribe-1", "scribe-2"] });
    const setProjectRouting = savedOverride(configuration({ default: ["scribe-1"] }), 2);
    const client = renderSection({
      host,
      project: configuration({ default: ["scribe-1", "scribe-2"] }),
      setProjectRouting,
    });

    await user.click(await screen.findByRole("button", { name: "Remove scribe-2 from Builder" }));
    expect(client.setProjectRouting).toHaveBeenLastCalledWith(projectId, {
      configuration: configuration({ default: ["scribe-1"] }),
      expectedVersion: 1,
    });

    client.setProjectRouting.mockImplementation(async () => ({
      kind: "project-routing-override" as const,
      override: override({ slots: [], jobSlots: [] }, 3),
    }));
    const choice = await screen.findByRole("combobox", { name: "Builder for this Project" });
    await waitFor(() => expect(choice).toBeEnabled());
    await chooseSelectFieldOption(user, choice, "Use Settings");
    expect(client.setProjectRouting).toHaveBeenLastCalledWith(projectId, {
      configuration: { slots: [], jobSlots: [] },
      expectedVersion: 2,
    });
  });

  it("offers a model Settings lacks as Add in Settings too, and adds it to Settings before the Project", async () => {
    const user = userEvent.setup();
    const host = configuration({ default: ["scribe-1"] });
    const updateRouting = vi.fn(async () => ({
      kind: "routing-settings" as const,
      settings: hostSettings(configuration({ default: ["scribe-1", "scribe-3"] }), 2),
    }));
    const setProjectRouting = savedOverride(configuration({ default: ["scribe-1", "scribe-3"] }));
    const client = renderSection({
      host,
      project: configuration({ default: ["scribe-1"] }),
      setProjectRouting,
      updateRouting,
    });

    await user.click(await screen.findByRole("button", { name: "Add a fallback for Builder" }));
    await user.click(screen.getByRole("button", { name: "Builder, new fallback" }));
    await user.click(await screen.findByRole("option", { name: "Scribe 3" }));
    expect(client.setProjectRouting).not.toHaveBeenCalled();
    expect(screen.getByText(/scribe-3 is not in Settings for Builder/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Add in Settings too" }));

    await waitFor(() => expect(setProjectRouting).toHaveBeenCalled());
    expect(updateRouting).toHaveBeenCalledWith({
      configuration: configuration({ default: ["scribe-1", "scribe-3"] }),
      expectedVersion: 1,
    });
    expect(setProjectRouting).toHaveBeenCalledWith(projectId, {
      configuration: configuration({ default: ["scribe-1", "scribe-3"] }),
      expectedVersion: 1,
    });
  });

  it("puts an added model where the person picked it, not at the end", async () => {
    const user = userEvent.setup();
    const updateRouting = vi.fn(async () => ({
      kind: "routing-settings" as const,
      settings: hostSettings(configuration({ default: ["scribe-1", "scribe-3"] }), 2),
    }));
    const setProjectRouting = savedOverride(configuration({ default: ["scribe-3"] }));
    renderSection({
      host: configuration({ default: ["scribe-1"] }),
      project: configuration({ default: ["scribe-1"] }),
      setProjectRouting,
      updateRouting,
    });

    await user.click(await screen.findByRole("button", { name: "Builder, main" }));
    await user.click(await screen.findByRole("option", { name: "Scribe 3" }));
    await user.click(screen.getByRole("button", { name: "Add in Settings too" }));

    await waitFor(() => expect(setProjectRouting).toHaveBeenCalled());
    expect(setProjectRouting).toHaveBeenCalledWith(projectId, {
      configuration: configuration({ default: ["scribe-3"] }),
      expectedVersion: 1,
    });
  });

  it("changes nothing when the model an added one would replace left the role first", async () => {
    const user = userEvent.setup();
    const updateRouting = vi.fn();
    const setProjectRouting = savedOverride(configuration({ default: ["scribe-1"] }), 2);
    renderSection({
      host: configuration({ default: ["scribe-1", "scribe-2"] }),
      project: configuration({ default: ["scribe-1", "scribe-2"] }),
      setProjectRouting,
      updateRouting,
    });

    await user.click(await screen.findByRole("button", { name: "Builder, fallback 1" }));
    await user.click(await screen.findByRole("option", { name: "Scribe 3" }));
    await user.click(screen.getByRole("button", { name: "Remove scribe-2 from Builder" }));
    await waitFor(() => expect(setProjectRouting).toHaveBeenCalledOnce());
    const add = screen.queryByRole("button", { name: "Add in Settings too" });
    if (add !== null) await user.click(add);

    expect(updateRouting).not.toHaveBeenCalled();
    expect(setProjectRouting).toHaveBeenCalledOnce();
  });

  it("says a Project change made elsewhere won and reloads", async () => {
    const user = userEvent.setup();
    const setProjectRouting = vi.fn(async () => ({
      kind: "routing-refused" as const,
      reason: "stale-version" as const,
      message: "The routing table changed.",
    }));
    const client = renderSection({
      host: configuration({ default: ["scribe-1", "scribe-2"] }),
      project: configuration({ default: ["scribe-1", "scribe-2"] }),
      setProjectRouting,
    });

    await user.click(await screen.findByRole("button", { name: "Remove scribe-2 from Builder" }));

    expect(
      await screen.findByText("Changed elsewhere. Reloaded; make your change again."),
    ).toBeVisible();
    expect(client.projectRoutingState).toHaveBeenCalledTimes(2);
  });

  it("suggests only for a role the Project chose, and only from the models Settings lists for it", async () => {
    const user = userEvent.setup();
    const host = configuration({ vision: ["scribe-1", "scribe-2"], quick: ["scribe-1"] });
    const setProjectRouting = savedOverride(configuration({ vision: ["scribe-2", "scribe-1"] }), 2);
    const client = renderSection({
      host,
      project: configuration({ vision: ["scribe-1"] }),
      setProjectRouting,
    });

    // Quick edit uses Settings, so it offers no Suggest; Sees images is the Project's own.
    await screen.findByRole("button", { name: "Suggest a model for Sees images" });
    expect(
      screen.queryByRole("button", { name: "Suggest a model for Quick edit" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Suggest a model for Sees images" }));
    const dialog = await screen.findByRole("dialog", { name: "Suggested models" });
    expect(dialog).toHaveTextContent(/Sees images → scribe-2 \(Scribe Local\)/);
    // scribe-3 is connected but not in Settings' Sees images list.
    expect(dialog).not.toHaveTextContent(/scribe-3/);
    expect(client.setProjectRouting).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Use these" }));
    expect(client.setProjectRouting).toHaveBeenCalledWith(projectId, {
      configuration: configuration({ vision: ["scribe-2", "scribe-1"] }),
      expectedVersion: 1,
    });
  });

  it("leaves the Project's role as it is when the person cancels", async () => {
    const user = userEvent.setup();
    const client = renderSection({
      host: configuration({ vision: ["scribe-1", "scribe-2"] }),
      project: configuration({ vision: ["scribe-1"] }),
    });
    await user.click(
      await screen.findByRole("button", { name: "Suggest a model for Sees images" }),
    );
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(client.setProjectRouting).not.toHaveBeenCalled();
  });
});
