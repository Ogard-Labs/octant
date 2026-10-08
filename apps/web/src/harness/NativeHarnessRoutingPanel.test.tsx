import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
  NativeHarnessRoutingConfiguration,
  NativeHarnessRoutingSettings,
  ProviderInstance,
  ProviderObservedState,
} from "@octant/contracts";
import { buildModelPickerGroups } from "@octant/domain";
import { chooseSelectFieldOption } from "../test/chooseSelectFieldOption.test-support";
import {
  NativeHarnessRoutingPanel,
  type NativeHarnessProviderOption,
} from "./NativeHarnessRoutingPanel";

const hostId = "00000000-0000-0000-0000-000000000001";
const now = "2026-09-05T12:00:00.000Z";
const endpointA = "10000000-0000-4000-8000-00000000000a";
const endpointB = "10000000-0000-4000-8000-00000000000b";

const settings = (
  configuration: NativeHarnessRoutingConfiguration = { slots: [], jobSlots: [] },
  version = 1,
): NativeHarnessRoutingSettings => ({
  configuration,
  version: version as never,
  updatedAt: now as never,
});

const candidate = (providerInstanceId: string, modelId: string) => ({
  hostId: hostId as never,
  providerInstanceId: providerInstanceId as never,
  modelId: modelId as never,
});

const roles = (slots: Readonly<Record<string, ReadonlyArray<ReturnType<typeof candidate>>>>) =>
  settings({
    slots: Object.entries(slots).map(([id, candidates]) => ({ id: id as never, candidates })),
    jobSlots: [],
  });

interface EndpointFixture {
  readonly id: string;
  readonly name: string;
  readonly models: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly images?: boolean;
  }>;
  readonly readiness?: "ready" | "degraded";
  readonly carriesTools?: boolean;
}

function instance(fixture: EndpointFixture): ProviderInstance {
  return {
    id: fixture.id,
    displayName: fixture.name,
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
}

function observed(fixture: EndpointFixture): ProviderObservedState {
  return {
    instanceId: fixture.id,
    readiness: fixture.readiness ?? "ready",
    processState: "running",
    models: fixture.models.map((model) => ({
      id: model.id,
      displayName: model.name,
      reasoning: "unsupported",
      inputModalities: model.images === true ? ["text", "image"] : ["text"],
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
      appManagedTools: fixture.carriesTools === false ? "unsupported" : "supported",
      citations: "unsupported",
    },
    observedAt: now,
  } as unknown as ProviderObservedState;
}

function endpoints(fixtures: ReadonlyArray<EndpointFixture>) {
  const groups = buildModelPickerGroups({
    instances: fixtures.map(instance),
    observedByInstance: new Map(
      fixtures.map((fixture) => [fixture.id as never, observed(fixture)] as const),
    ),
    mode: "chat",
  });
  const providers: ReadonlyArray<NativeHarnessProviderOption> = fixtures.map((fixture) => ({
    instanceId: fixture.id,
    label: fixture.name,
    modelCount: fixture.models.length,
  }));
  return { groups, providers };
}

const local: EndpointFixture = {
  id: endpointA,
  name: "Scribe Local",
  models: [
    { id: "scribe-2", name: "scribe-2" },
    { id: "scribe-2-mini", name: "scribe-2-mini" },
  ],
};
const router: EndpointFixture = {
  id: endpointB,
  name: "Model router",
  models: [
    { id: "router-text", name: "router-text" },
    { id: "router-vision", name: "router-vision", images: true },
  ],
};

function renderPanel(input: {
  readonly routing: () => Promise<NativeHarnessRoutingSettings>;
  readonly updateRouting?: ReturnType<typeof vi.fn>;
  readonly fixtures?: ReadonlyArray<EndpointFixture>;
  readonly onOpenModelEndpoints?: () => void;
  readonly onVerifyTools?: ReturnType<typeof vi.fn>;
}) {
  const { groups, providers } = endpoints(input.fixtures ?? []);
  const routing = vi.fn(input.routing);
  const updateRouting = input.updateRouting ?? vi.fn();
  render(
    <NativeHarnessRoutingPanel
      client={{ routing, updateRouting: updateRouting as never }}
      groups={groups}
      hostId={hostId}
      providers={providers}
      {...(input.onOpenModelEndpoints === undefined
        ? {}
        : { onOpenModelEndpoints: input.onOpenModelEndpoints })}
      {...(input.onVerifyTools === undefined
        ? {}
        : { onVerifyTools: input.onVerifyTools as never })}
    />,
  );
  return { routing, updateRouting };
}

const savedAs = (next: NativeHarnessRoutingSettings) =>
  vi.fn(async () => ({ kind: "routing-settings" as const, settings: next }));
const offerName = "Choose a main model to start";

describe("NativeHarnessRoutingPanel without endpoints", () => {
  it("explains how to add an endpoint instead of showing empty roles", async () => {
    const user = userEvent.setup();
    const onOpenModelEndpoints = vi.fn();
    renderPanel({ routing: async () => settings(), onOpenModelEndpoints });

    expect(await screen.findByText("No model endpoint yet")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Model roles" })).toBeVisible();
    expect(screen.queryByText(/Which job uses which role/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Save/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open Model endpoints" }));
    expect(onOpenModelEndpoints).toHaveBeenCalledOnce();
  });

  it("keeps a saved choice readable when no endpoint offers it", async () => {
    const user = userEvent.setup();
    const onOpenModelEndpoints = vi.fn();
    renderPanel({
      routing: async () => roles({ default: [candidate("missing-provider", "missing-model")] }),
      onOpenModelEndpoints,
    });

    expect(await screen.findByText("missing-model")).toBeVisible();
    expect(screen.queryByText("No model endpoint yet")).not.toBeInTheDocument();
    expect(screen.getByText("Not offered by a ready endpoint")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Add a model endpoint" }));
    expect(onOpenModelEndpoints).toHaveBeenCalledOnce();
  });

  it("names the endpoint that has no models yet rather than asking for one", async () => {
    renderPanel({
      routing: async () => settings(),
      fixtures: [{ id: endpointA, name: "Azure", models: [] }],
      onOpenModelEndpoints: vi.fn(),
    });

    expect(await screen.findByText("No models from Azure yet.")).toBeVisible();
    expect(screen.queryByText("No model endpoint yet")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Model endpoints" })).toBeVisible();
  });
});

describe("NativeHarnessRoutingPanel roles", () => {
  it("reads every unset role as the main model's, and the advisor as off", async () => {
    renderPanel({ routing: async () => settings(), fixtures: [local, router] });

    expect(await screen.findByRole("button", { name: "Main model model" })).toHaveTextContent(
      "Choose model",
    );
    for (const role of [
      "Planning",
      "Careful review",
      "Research and lookups",
      "Quick jobs",
      "Reading images",
    ]) {
      expect(screen.getByRole("button", { name: `${role} model` })).toHaveTextContent(
        "Same as main model",
      );
    }
    expect(screen.getByRole("button", { name: "Advisor model" })).toHaveTextContent("Off");
    expect(screen.getByRole("group", { name: "Main model setting" })).toHaveTextContent(
      "takes over when a thread's own model stops answering",
    );
    expect(screen.queryByText(/Leads each thread/)).not.toBeInTheDocument();
  });

  it("saves a chosen model at once, with the version it was read at", async () => {
    const user = userEvent.setup();
    const next = roles({ plan: [candidate(endpointB, "router-text")] });
    const updateRouting = savedAs(settings(next.configuration, 2));
    renderPanel({ routing: async () => settings(), updateRouting, fixtures: [local, router] });

    await user.click(await screen.findByRole("button", { name: "Planning model" }));
    await user.click(await screen.findByRole("option", { name: "router-text" }));

    expect(updateRouting).toHaveBeenCalledWith({
      configuration: next.configuration,
      expectedVersion: 1,
    });
    expect(screen.queryByRole("button", { name: /Save/ })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Planning model" })).toHaveTextContent(
        "router-text",
      ),
    );
    expect(screen.getByRole("group", { name: "Planning setting" })).toHaveTextContent(
      "Model router",
    );
  });

  it("says a change made elsewhere won, and reloads the roles", async () => {
    const user = userEvent.setup();
    const elsewhere = roles({ smol: [candidate(endpointA, "scribe-2-mini")] });
    let reads = 0;
    const updateRouting = vi.fn(async () => ({
      kind: "routing-refused" as const,
      reason: "stale-version" as const,
      message: "The routing table changed.",
    }));
    const { routing } = renderPanel({
      routing: async () => (reads++ === 0 ? settings() : settings(elsewhere.configuration, 5)),
      updateRouting,
      fixtures: [local, router],
    });

    await user.click(await screen.findByRole("button", { name: "Planning model" }));
    await user.click(await screen.findByRole("option", { name: "router-text" }));

    expect(
      await screen.findByText("Changed elsewhere. Reloaded; make your change again."),
    ).toBeVisible();
    expect(routing).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Quick jobs model" })).toHaveTextContent(
      "scribe-2-mini",
    );
    expect(screen.getByRole("button", { name: "Planning model" })).toHaveTextContent(
      "Same as main model",
    );
  });

  it("turns a role back to the main model, and the advisor off", async () => {
    const user = userEvent.setup();
    const both = roles({
      plan: [candidate(endpointA, "scribe-2")],
      advisor: [candidate(endpointA, "scribe-2-mini")],
    });
    const advisorOnly = roles({ advisor: [candidate(endpointA, "scribe-2-mini")] });
    const updateRouting = savedAs(advisorOnly);
    renderPanel({ routing: async () => both, updateRouting, fixtures: [local] });

    await user.click(await screen.findByRole("button", { name: "Planning: use main model" }));
    expect(updateRouting).toHaveBeenLastCalledWith({
      configuration: advisorOnly.configuration,
      expectedVersion: 1,
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Turn the advisor off" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Turn the advisor off" }));
    expect(updateRouting).toHaveBeenLastCalledWith({
      configuration: { slots: [], jobSlots: [] },
      expectedVersion: 1,
    });
  });

  it("keeps a role's own settings while its first choice changes", async () => {
    const user = userEvent.setup();
    const promotion = candidate(endpointB, "router-vision");
    const custom = settings({
      slots: [
        {
          id: "review-pass" as never,
          candidates: [candidate(endpointA, "scribe-2")],
          overflowPromotion: promotion,
        },
      ],
      jobSlots: [],
    });
    const updateRouting = savedAs(custom);
    renderPanel({ routing: async () => custom, updateRouting, fixtures: [local, router] });

    await user.click(await screen.findByRole("button", { name: "review-pass model" }));
    await user.click(await screen.findByRole("option", { name: "router-text" }));

    expect(updateRouting).toHaveBeenCalledWith({
      configuration: {
        slots: [
          {
            id: "review-pass",
            candidates: [candidate(endpointB, "router-text")],
            overflowPromotion: promotion,
          },
        ],
        jobSlots: [],
      },
      expectedVersion: 1,
    });
  });

  it("offers only models that accept images for reading images", async () => {
    const user = userEvent.setup();
    renderPanel({ routing: async () => settings(), fixtures: [local, router] });

    await user.click(await screen.findByRole("button", { name: "Reading images model" }));

    expect(await screen.findByRole("option", { name: "router-vision" })).toBeVisible();
    expect(screen.queryByRole("option", { name: "router-text" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "scribe-2" })).not.toBeInTheDocument();
  });

  it("says no model can read images when no ready endpoint reports image input", async () => {
    renderPanel({ routing: async () => settings(), fixtures: [local] });

    const row = await screen.findByRole("group", { name: "Reading images setting" });
    expect(row).toHaveTextContent("Same as main model");
    expect(row).toHaveTextContent("No ready model says it accepts images.");
    expect(screen.queryByRole("button", { name: "Reading images model" })).not.toBeInTheDocument();
  });
});

describe("NativeHarnessRoutingPanel backups", () => {
  const chain = roles({
    task: [candidate(endpointA, "scribe-2"), candidate(endpointB, "router-text")],
  });

  it("adds a backup in place and saves it after the first choice", async () => {
    const user = userEvent.setup();
    const one = roles({ task: [candidate(endpointA, "scribe-2")] });
    const updateRouting = savedAs(chain);
    renderPanel({ routing: async () => one, updateRouting, fixtures: [local, router] });

    await user.click(await screen.findByRole("button", { name: "Research and lookups backups" }));
    const editor = screen.getByRole("group", { name: "Research and lookups models" });
    await user.click(
      within(editor).getByRole("button", { name: "Add a backup for Research and lookups" }),
    );
    expect(updateRouting).not.toHaveBeenCalled();
    await user.click(
      within(editor).getByRole("button", { name: "Research and lookups, new backup" }),
    );
    await user.click(await screen.findByRole("option", { name: "router-text" }));

    expect(updateRouting).toHaveBeenCalledWith({
      configuration: chain.configuration,
      expectedVersion: 1,
    });
    await waitFor(() =>
      expect(screen.getByRole("group", { name: "Research and lookups setting" })).toHaveTextContent(
        "Backup: router-text",
      ),
    );
  });

  it("moves a backup up to first choice, and removes one", async () => {
    const user = userEvent.setup();
    const swapped = roles({
      task: [candidate(endpointB, "router-text"), candidate(endpointA, "scribe-2")],
    });
    const updateRouting = savedAs(swapped);
    renderPanel({ routing: async () => chain, updateRouting, fixtures: [local, router] });

    await user.click(await screen.findByRole("button", { name: "Research and lookups backups" }));
    expect(screen.getByRole("button", { name: "Move scribe-2 up" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Move router-text up" }));
    expect(updateRouting).toHaveBeenLastCalledWith({
      configuration: swapped.configuration,
      expectedVersion: 1,
    });

    const remove = "Remove scribe-2 from Research and lookups";
    await waitFor(() => expect(screen.getByRole("button", { name: remove })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: remove }));
    expect(updateRouting).toHaveBeenLastCalledWith({
      configuration: roles({ task: [candidate(endpointB, "router-text")] }).configuration,
      expectedVersion: 1,
    });
  });

  it("says a chosen model is Chat only and verifies its tools with one request", async () => {
    const user = userEvent.setup();
    const onVerifyTools = vi.fn(async () => "unsupported" as const);
    renderPanel({
      routing: async () => roles({ default: [candidate(endpointA, "scribe-2")] }),
      fixtures: [{ ...local, carriesTools: false }],
      onVerifyTools,
    });

    expect(
      await screen.findByText(/scribe-2 hasn't shown it can use Octant's tools/),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Verify tools for scribe-2 (1 request)" }));

    expect(onVerifyTools).toHaveBeenCalledWith(endpointA, "scribe-2");
    expect(await screen.findByText(/did not call the test tool/)).toBeVisible();
  });

  it("says nothing about tools for a model Octant already sends tools to", async () => {
    renderPanel({
      routing: async () => roles({ default: [candidate(endpointA, "scribe-2")] }),
      fixtures: [local],
      onVerifyTools: vi.fn(),
    });

    await screen.findByRole("button", { name: "Main model model" });
    expect(screen.queryByText(/hasn't shown it can use Octant's tools/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Verify tools/ })).not.toBeInTheDocument();
  });
});

describe("NativeHarnessRoutingPanel main model suggestion", () => {
  it("offers the one ready endpoint's model as the main model, and saves only when asked", async () => {
    const user = userEvent.setup();
    const next = roles({ default: [candidate(endpointA, "scribe-2")] });
    const updateRouting = savedAs(next);
    renderPanel({ routing: async () => settings(), updateRouting, fixtures: [local] });

    const offer = await screen.findByRole("group", { name: offerName });
    expect(offer).toHaveTextContent("Scribe Local has 2 models.");
    expect(updateRouting).not.toHaveBeenCalled();
    await user.click(within(offer).getByRole("button", { name: "Use scribe-2 as the main model" }));

    expect(updateRouting).toHaveBeenCalledWith({
      configuration: next.configuration,
      expectedVersion: 1,
    });
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: offerName })).not.toBeInTheDocument(),
    );
  });

  it("makes no offer when two endpoints are ready", async () => {
    renderPanel({ routing: async () => settings(), fixtures: [local, router] });
    await screen.findByRole("button", { name: "Main model model" });
    expect(screen.queryByRole("group", { name: offerName })).not.toBeInTheDocument();
  });

  it("makes no offer once a main model is set", async () => {
    renderPanel({
      routing: async () => roles({ default: [candidate(endpointA, "scribe-2-mini")] }),
      fixtures: [local],
    });
    await screen.findByRole("button", { name: "Main model model" });
    expect(screen.queryByRole("group", { name: offerName })).not.toBeInTheDocument();
  });

  it("makes no offer while the only endpoint is not ready", async () => {
    renderPanel({
      routing: async () => settings(),
      fixtures: [{ ...local, readiness: "degraded" }],
    });
    await screen.findByRole("button", { name: "Main model model" });
    expect(screen.queryByRole("group", { name: offerName })).not.toBeInTheDocument();
  });
});

describe("NativeHarnessRoutingPanel jobs", () => {
  it("folds the job list away, leaves the lead out, and saves a rebinding at once", async () => {
    const user = userEvent.setup();
    const next = settings({
      slots: [],
      jobSlots: [{ job: "reviewer", slotId: "default" as never }],
    });
    const updateRouting = savedAs(next);
    renderPanel({ routing: async () => settings(), updateRouting, fixtures: [local] });

    const summary = await screen.findByText("Which job uses which role · standard");
    const disclosure = summary.closest("details");
    expect(disclosure).not.toHaveAttribute("open");
    await user.click(summary);
    expect(disclosure).toHaveAttribute("open");
    expect(screen.queryByRole("combobox", { name: "Lead role" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("combobox", { name: / role$/ })).toHaveLength(11);

    await chooseSelectFieldOption(
      user,
      screen.getByRole("combobox", { name: "Reviewing finished work role" }),
      "Main model",
    );

    expect(updateRouting).toHaveBeenCalledWith({
      configuration: next.configuration,
      expectedVersion: 1,
    });
    expect(await screen.findByText("Which job uses which role · changed")).toBeVisible();
  });
});
