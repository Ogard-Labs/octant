import { render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_NATIVE_HARNESS_ROUTING_SETTINGS,
  type NativeHarnessRoutingConfiguration,
  type NativeHarnessRoutingSettings,
  type ProviderInstance,
  type ProviderObservedState,
} from "@octant/contracts";
import { buildModelPickerGroups } from "@octant/domain";
import { chooseSelectFieldOption } from "../test/chooseSelectFieldOption.test-support";
import { PlanUsageProvider } from "../usage/PlanUsageContext";
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
    readonly effort?: boolean;
  }>;
  readonly readiness?: "ready" | "degraded" | "unauthenticated";
  readonly carriesTools?: boolean;
  /** A provider that runs the model itself rather than through Octant's harness. */
  readonly driverKind?: "claude";
}

function instance(fixture: EndpointFixture): ProviderInstance {
  return {
    id: fixture.id,
    displayName: fixture.name,
    driverKind: fixture.driverKind ?? "openai-compatible",
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
      options:
        model.effort === true
          ? [{ id: "effort", displayName: "Effort", kind: "selection", values: ["low", "high"] }]
          : [],
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
    readiness: fixture.readiness ?? "ready",
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
const claudeId = "10000000-0000-4000-8000-0000000000c1";
const claude: EndpointFixture = {
  id: claudeId,
  name: "Claude",
  driverKind: "claude",
  models: [
    { id: "opus-5-5", name: "Opus 5.5", images: true },
    { id: "sonnet-5-5", name: "Sonnet 5.5", images: true },
    { id: "haiku-5-5", name: "Haiku 5.5", images: true },
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
  readonly wrap?: (panel: ReactNode) => ReactNode;
}) {
  const { groups, providers } = endpoints(input.fixtures ?? []);
  const routing = vi.fn(input.routing);
  const updateRouting = input.updateRouting ?? vi.fn();
  const panel = (
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
    />
  );
  render(input.wrap === undefined ? panel : input.wrap(panel));
  return { routing, updateRouting };
}

const savedAs = (next: NativeHarnessRoutingSettings) =>
  vi.fn(async () => ({ kind: "routing-settings" as const, settings: next }));
const offerName = "Choose a Builder to start";

describe("NativeHarnessRoutingPanel without endpoints", () => {
  it("explains how to add an endpoint instead of showing empty roles", async () => {
    const user = userEvent.setup();
    const onOpenModelEndpoints = vi.fn();
    // A fresh host stores the standard job bindings, which are not a choice.
    renderPanel({
      routing: async () => settings(DEFAULT_NATIVE_HARNESS_ROUTING_SETTINGS.configuration),
      onOpenModelEndpoints,
    });

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
    expect(screen.getByText("Not offered by a ready provider")).toBeVisible();
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

const openOtherRoles = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(await screen.findByText("Other roles"));

describe("NativeHarnessRoutingPanel roles", () => {
  it("lists the roles by their names, in the order the work gets harder, and reads an empty one as the Builder's", async () => {
    const user = userEvent.setup();
    renderPanel({ routing: async () => settings(), fixtures: [local, router] });

    expect(await screen.findByRole("button", { name: "Builder model" })).toHaveTextContent(
      "Choose model",
    );
    const names = screen
      .getAllByRole("group")
      .map((group) => group.getAttribute("aria-labelledby"))
      .filter((id): id is string => id?.startsWith("model-role-") === true)
      .map((id) => document.getElementById(id)?.textContent)
      .slice(0, 8);
    expect(names).toEqual([
      "Planner",
      "Scout",
      "Quick edit",
      "Builder",
      "Hard problems",
      "Reviewer",
      "Sees images",
      "Small jobs",
    ]);
    for (const role of [
      "Planner",
      "Scout",
      "Quick edit",
      "Hard problems",
      "Reviewer",
      "Small jobs",
    ]) {
      expect(screen.getByRole("button", { name: `${role} model` })).toHaveTextContent(
        "Same as Builder",
      );
    }
    expect(screen.getByRole("button", { name: "Sees images model" })).toHaveTextContent(
      "Same as Builder",
    );
    expect(screen.getByText(/Coordinator workers and helper agents use these roles/)).toBeVisible();
    await openOtherRoles(user);
    expect(screen.getByRole("button", { name: "Advisor model" })).toHaveTextContent("Off");
  });

  it("saves a chosen model at once, with the version it was read at", async () => {
    const user = userEvent.setup();
    const next = roles({ plan: [candidate(endpointB, "router-text")] });
    const updateRouting = savedAs(settings(next.configuration, 2));
    renderPanel({ routing: async () => settings(), updateRouting, fixtures: [local, router] });

    await user.click(await screen.findByRole("button", { name: "Planner model" }));
    await user.click(await screen.findByRole("option", { name: "Router Text" }));

    expect(updateRouting).toHaveBeenCalledWith({
      configuration: next.configuration,
      expectedVersion: 1,
    });
    expect(screen.queryByRole("button", { name: /Save/ })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Planner, main" })).toHaveTextContent(
        "Router Text",
      ),
    );
    expect(screen.getByText("No fallback")).toBeVisible();
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

    await user.click(await screen.findByRole("button", { name: "Planner model" }));
    await user.click(await screen.findByRole("option", { name: "Router Text" }));

    expect(
      await screen.findByText("Changed elsewhere. Reloaded; make your change again."),
    ).toBeVisible();
    expect(routing).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Small jobs, main" })).toHaveTextContent(
      "Scribe 2 Mini",
    );
    expect(screen.getByRole("button", { name: "Planner model" })).toHaveTextContent(
      "Same as Builder",
    );
  });

  it("turns a role back to the Builder by removing its only model, and the advisor off", async () => {
    const user = userEvent.setup();
    const both = roles({
      plan: [candidate(endpointA, "scribe-2")],
      advisor: [candidate(endpointA, "scribe-2-mini")],
    });
    const advisorOnly = roles({ advisor: [candidate(endpointA, "scribe-2-mini")] });
    const updateRouting = savedAs(advisorOnly);
    renderPanel({ routing: async () => both, updateRouting, fixtures: [local] });

    await user.click(await screen.findByRole("button", { name: "Remove scribe-2 from Planner" }));
    expect(updateRouting).toHaveBeenLastCalledWith({
      configuration: advisorOnly.configuration,
      expectedVersion: 1,
    });
    await openOtherRoles(user);
    const off = "Remove scribe-2-mini from Advisor";
    await waitFor(() => expect(screen.getByRole("button", { name: off })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: off }));
    expect(updateRouting).toHaveBeenLastCalledWith({
      configuration: { slots: [], jobSlots: [] },
      expectedVersion: 1,
    });
  });

  it("keeps a role's own settings while its main model changes", async () => {
    const user = userEvent.setup();
    const promotion = candidate(endpointB, "router-vision");
    const custom = settings({
      slots: [
        {
          id: "review-pass" as never,
          candidates: [candidate(endpointA, "scribe-2")],
          overflowPromotion: promotion,
          askBeforeUsing: true,
        },
      ],
      jobSlots: [],
    });
    const updateRouting = savedAs(custom);
    renderPanel({ routing: async () => custom, updateRouting, fixtures: [local, router] });

    await openOtherRoles(user);
    await user.click(await screen.findByRole("button", { name: "review-pass, main" }));
    await user.click(await screen.findByRole("option", { name: "Router Text" }));

    expect(updateRouting).toHaveBeenCalledWith({
      configuration: {
        slots: [
          {
            id: "review-pass",
            candidates: [candidate(endpointB, "router-text")],
            overflowPromotion: promotion,
            askBeforeUsing: true,
          },
        ],
        jobSlots: [],
      },
      expectedVersion: 1,
    });
  });

  it("offers only models that accept images to Sees images", async () => {
    const user = userEvent.setup();
    renderPanel({ routing: async () => settings(), fixtures: [local, router] });

    await user.click(await screen.findByRole("button", { name: "Sees images model" }));

    expect(await screen.findByRole("option", { name: "Router Vision" })).toBeVisible();
    expect(screen.queryByRole("option", { name: "Router Text" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Scribe 2" })).not.toBeInTheDocument();
  });

  it("says no model can read images when no ready endpoint reports image input", async () => {
    renderPanel({ routing: async () => settings(), fixtures: [local] });

    const row = await screen.findByRole("group", { name: "Sees images" });
    expect(row).toHaveTextContent("Same as Builder");
    expect(row).toHaveTextContent("No ready model says it accepts images.");
    expect(screen.queryByRole("button", { name: "Sees images model" })).not.toBeInTheDocument();
  });
});

describe("NativeHarnessRoutingPanel role choices", () => {
  const withReviewer = roles({ slow: [candidate(endpointA, "scribe-2")] });

  it("shows Ask before using off and Continue on the fallback on until a person changes them", async () => {
    renderPanel({ routing: async () => withReviewer, fixtures: [local] });

    const reviewer = await screen.findByRole("group", { name: "Reviewer" });
    expect(within(reviewer).getByRole("checkbox", { name: "Ask before using" })).not.toBeChecked();
    expect(
      within(reviewer).getByRole("checkbox", {
        name: "Continue on the fallback if the model stops",
      }),
    ).toBeChecked();
    // A role with no model has nothing to attach a choice to.
    expect(
      within(screen.getByRole("group", { name: "Planner" })).queryByRole("checkbox"),
    ).not.toBeInTheDocument();
  });

  it("saves each choice with the role, storing only what differs from the default", async () => {
    const user = userEvent.setup();
    const updateRouting = vi.fn(
      async (input: { readonly configuration: NativeHarnessRoutingConfiguration }) => ({
        kind: "routing-settings" as const,
        settings: settings(input.configuration, 2),
      }),
    );
    renderPanel({ routing: async () => withReviewer, updateRouting, fixtures: [local] });

    const reviewer = await screen.findByRole("group", { name: "Reviewer" });
    await user.click(within(reviewer).getByRole("checkbox", { name: "Ask before using" }));
    expect(updateRouting).toHaveBeenLastCalledWith({
      configuration: {
        slots: [
          { id: "slow", candidates: [candidate(endpointA, "scribe-2")], askBeforeUsing: true },
        ],
        jobSlots: [],
      },
      expectedVersion: 1,
    });
    await waitFor(() =>
      expect(
        within(screen.getByRole("group", { name: "Reviewer" })).getByRole("checkbox", {
          name: "Continue on the fallback if the model stops",
        }),
      ).toBeEnabled(),
    );
    await user.click(
      within(screen.getByRole("group", { name: "Reviewer" })).getByRole("checkbox", {
        name: "Continue on the fallback if the model stops",
      }),
    );
    expect(updateRouting.mock.lastCall?.[0].configuration.slots[0]).toEqual({
      id: "slow",
      candidates: [candidate(endpointA, "scribe-2")],
      askBeforeUsing: true,
      continueOnFallback: false,
    });
  });

  it("saves a reasoning level for one model of a role and clears it back to the default", async () => {
    const user = userEvent.setup();
    const effortModel: EndpointFixture = {
      ...local,
      models: [{ id: "scribe-2", name: "scribe-2", effort: true }],
    };
    const updateRouting = vi.fn(
      async (input: { readonly configuration: NativeHarnessRoutingConfiguration }) => ({
        kind: "routing-settings" as const,
        settings: settings(input.configuration, 2),
      }),
    );
    renderPanel({ routing: async () => withReviewer, updateRouting, fixtures: [effortModel] });

    await chooseSelectFieldOption(
      user,
      await screen.findByRole("combobox", { name: "scribe-2 reasoning" }),
      "Reasoning: high",
    );
    expect(updateRouting.mock.lastCall?.[0].configuration.slots[0]?.candidates[0]).toEqual({
      ...candidate(endpointA, "scribe-2"),
      reasoning: "high",
    });
  });
});

describe("NativeHarnessRoutingPanel fallbacks", () => {
  const chain = roles({
    task: [candidate(endpointA, "scribe-2"), candidate(endpointB, "router-text")],
  });

  it("adds a fallback in place and saves it after the choice", async () => {
    const user = userEvent.setup();
    const one = roles({ task: [candidate(endpointA, "scribe-2")] });
    const updateRouting = savedAs(chain);
    renderPanel({ routing: async () => one, updateRouting, fixtures: [local, router] });

    expect(await screen.findByText("No fallback")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Add a fallback for Scout" }));
    expect(updateRouting).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Scout, new fallback" }));
    await user.click(await screen.findByRole("option", { name: "Router Text" }));

    expect(updateRouting).toHaveBeenCalledWith({
      configuration: chain.configuration,
      expectedVersion: 1,
    });
    await waitFor(() => expect(screen.queryByText("No fallback")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Scout, fallback 1" })).toHaveTextContent(
      "Router Text",
    );
  });

  it("reorders and removes with the keyboard, not only a pointer", async () => {
    const user = userEvent.setup();
    const swapped = roles({
      task: [candidate(endpointB, "router-text"), candidate(endpointA, "scribe-2")],
    });
    const updateRouting = savedAs(swapped);
    renderPanel({ routing: async () => chain, updateRouting, fixtures: [local, router] });

    expect(await screen.findByRole("button", { name: "Move scribe-2 up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move router-text down" })).toBeDisabled();
    screen.getByRole("button", { name: "Move router-text up" }).focus();
    await user.keyboard("{Enter}");
    expect(updateRouting).toHaveBeenLastCalledWith({
      configuration: swapped.configuration,
      expectedVersion: 1,
    });

    const remove = "Remove scribe-2 from Scout";
    await waitFor(() => expect(screen.getByRole("button", { name: remove })).toBeEnabled());
    screen.getByRole("button", { name: remove }).focus();
    await user.keyboard(" ");
    expect(updateRouting).toHaveBeenLastCalledWith({
      configuration: roles({ task: [candidate(endpointB, "router-text")] }).configuration,
      expectedVersion: 1,
    });
  });
});

describe("NativeHarnessRoutingPanel model tags", () => {
  it("says a model reads images and is Chat only, and verifies its tools with one request", async () => {
    const user = userEvent.setup();
    const onVerifyTools = vi.fn(async () => "unsupported" as const);
    renderPanel({
      routing: async () =>
        roles({
          default: [candidate(endpointA, "scribe-2"), candidate(endpointB, "router-vision")],
        }),
      fixtures: [{ ...local, carriesTools: false }, router],
      onVerifyTools,
    });

    const builder = await screen.findByRole("group", { name: "Builder" });
    expect(within(builder).getByText("Reads images")).toBeVisible();
    expect(within(builder).getByText(/Chat only/)).toBeVisible();
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

    await screen.findByRole("button", { name: "Builder, main" });
    expect(screen.queryByText(/Chat only/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Verify tools/ })).not.toBeInTheDocument();
  });

  it("says when a model's account is not signed in", async () => {
    renderPanel({
      routing: async () => roles({ default: [candidate(endpointA, "scribe-2")] }),
      fixtures: [{ ...local, readiness: "unauthenticated" }],
    });

    expect(await screen.findByText("Not signed in")).toBeVisible();
  });

  it("says when a model's account is at its usage limit, and until when", async () => {
    const observedAt = new Date().toISOString();
    const resetsAt = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    const snapshot = {
      version: 1,
      refreshedAt: observedAt,
      entries: [
        {
          providerInstanceId: endpointA,
          status: "available",
          source: "provider-runtime",
          observedAt,
          limits: {
            providerInstanceId: endpointA,
            scope: "account",
            requests: { status: "unavailable" },
            tokens: { status: "unavailable" },
            concurrency: { status: "unavailable" },
            retry: { status: "inactive" },
            quota: "available",
            source: "observed-evidence",
            confidence: "high",
            updatedAt: observedAt,
            rateLimitWindows: [
              { window: "five_hour", status: "exhausted", utilization: 1, observedAt, resetsAt },
            ],
          },
        },
      ],
    };
    renderPanel({
      routing: async () => roles({ default: [candidate(endpointA, "scribe-2")] }),
      fixtures: [local],
      wrap: (panel) => (
        <PlanUsageProvider
          barStyle="smooth"
          client={{ list: vi.fn(async () => snapshot) } as never}
        >
          {panel}
        </PlanUsageProvider>
      ),
    });

    expect(await screen.findByText(/At usage limit until \d/)).toBeVisible();
  });

  it("says a model is not offered when no ready endpoint lists it", async () => {
    renderPanel({
      routing: async () => roles({ default: [candidate("missing-provider", "missing-model")] }),
      fixtures: [local],
    });
    expect(await screen.findByText("Not offered by a ready provider")).toBeVisible();
  });
});

describe("NativeHarnessRoutingPanel Builder suggestion", () => {
  it("offers the one ready endpoint's model as the Builder, and saves only when asked", async () => {
    const user = userEvent.setup();
    const next = roles({ default: [candidate(endpointA, "scribe-2")] });
    const updateRouting = savedAs(next);
    renderPanel({ routing: async () => settings(), updateRouting, fixtures: [local] });

    const offer = await screen.findByRole("group", { name: offerName });
    expect(offer).toHaveTextContent("Scribe Local has 2 models.");
    expect(updateRouting).not.toHaveBeenCalled();
    await user.click(within(offer).getByRole("button", { name: "Use scribe-2 as the Builder" }));

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
    await screen.findByRole("button", { name: "Builder model" });
    expect(screen.queryByRole("group", { name: offerName })).not.toBeInTheDocument();
  });

  it("makes no offer once a Builder is set", async () => {
    renderPanel({
      routing: async () => roles({ default: [candidate(endpointA, "scribe-2-mini")] }),
      fixtures: [local],
    });
    await screen.findByRole("button", { name: "Builder, main" });
    expect(screen.queryByRole("group", { name: offerName })).not.toBeInTheDocument();
  });

  it("makes no offer while the only endpoint is not ready", async () => {
    renderPanel({
      routing: async () => settings(),
      fixtures: [{ ...local, readiness: "degraded" }],
    });
    await screen.findByRole("button", { name: "Builder model" });
    expect(screen.queryByRole("group", { name: offerName })).not.toBeInTheDocument();
  });
});

describe("NativeHarnessRoutingPanel jobs", () => {
  it("folds the job list away, leaves the lead and the advisor out, and saves a rebinding at once", async () => {
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
    // The advisor runs only on its own role, so its Off cannot be bypassed here.
    expect(screen.queryByRole("combobox", { name: "Advisor role" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("combobox", { name: / role$/ })).toHaveLength(10);

    await chooseSelectFieldOption(
      user,
      screen.getByRole("combobox", { name: "Reviewing finished work role" }),
      "Builder",
    );

    expect(updateRouting).toHaveBeenCalledWith({
      configuration: next.configuration,
      expectedVersion: 1,
    });
    expect(await screen.findByText("Which job uses which role · changed")).toBeVisible();
  });
});

describe("NativeHarnessRoutingPanel with providers that are not harness endpoints", () => {
  it("shows the roles when only a provider that runs its own models is connected", async () => {
    renderPanel({ routing: async () => settings(), fixtures: [claude] });
    expect(await screen.findByRole("button", { name: "Builder model" })).toBeVisible();
    expect(screen.queryByText("No model endpoint yet")).not.toBeInTheDocument();
  });

  it("previews a suggestion for every role and saves nothing until Use these", async () => {
    const user = userEvent.setup();
    const updateRouting = vi.fn(async () => ({
      kind: "routing-settings" as const,
      settings: settings(),
    }));
    renderPanel({ routing: async () => settings(), updateRouting, fixtures: [claude, local] });

    await user.click(await screen.findByRole("button", { name: "Suggest roles" }));
    const dialog = await screen.findByRole("dialog", { name: "Suggested models" });
    const lines = within(dialog).getByRole("list", { name: "Suggested models" });
    expect(lines).toHaveTextContent(/Builder → Sonnet 5.5 \(Claude\)/);
    expect(lines).toHaveTextContent(/Hard problems → Opus 5.5 \(Claude\)/);
    // A role that runs no tools takes its fallback from the other provider; the
    // endpoint's models have no proven tools, so the others stay on Claude.
    expect(lines).toHaveTextContent(/Fallback: scribe-2-mini \(Scribe Local\)/);
    expect(lines).not.toHaveTextContent(/Builder → scribe/);
    expect(updateRouting).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Suggested models" })).not.toBeInTheDocument();
    expect(updateRouting).not.toHaveBeenCalled();
  });

  it("saves the suggestion through the versioned command and keeps a role's flags", async () => {
    const user = userEvent.setup();
    const updateRouting = vi.fn(async () => ({
      kind: "routing-settings" as const,
      settings: settings(),
    }));
    const saved = settings(
      {
        slots: [
          {
            id: "default" as never,
            candidates: [candidate(endpointA, "scribe-2")],
            askBeforeUsing: true,
          },
        ],
        jobSlots: [],
      },
      4,
    );
    renderPanel({ routing: async () => saved, updateRouting, fixtures: [claude, local] });

    await user.click(await screen.findByRole("button", { name: "Suggest roles" }));
    await user.click(await screen.findByRole("button", { name: "Use these" }));

    await waitFor(() => expect(updateRouting).toHaveBeenCalledOnce());
    const sent = updateRouting.mock.calls[0] as unknown as readonly [
      { configuration: NativeHarnessRoutingConfiguration; expectedVersion: number },
    ];
    expect(sent[0].expectedVersion).toBe(4);
    const builder = sent[0].configuration.slots.find((slot) => String(slot.id) === "default");
    expect(String(builder?.candidates[0]?.modelId)).toBe("sonnet-5-5");
    expect(builder?.askBeforeUsing).toBe(true);
    const planner = sent[0].configuration.slots.find((slot) => String(slot.id) === "plan");
    expect(String(planner?.candidates[0]?.modelId)).toBe("opus-5-5");
  });

  it("previews one role from its own Suggest button and leaves the others alone", async () => {
    const user = userEvent.setup();
    renderPanel({ routing: async () => settings(), fixtures: [claude] });

    await user.click(await screen.findByRole("button", { name: "Suggest a model for Scout" }));
    const dialog = await screen.findByRole("dialog", { name: "Suggested models" });
    expect(dialog).toHaveTextContent(/Scout → Haiku 5.5 \(Claude\)/);
    expect(dialog).not.toHaveTextContent(/Planner/);
  });

  it("says why a role stays empty when no connected model fits it", async () => {
    const user = userEvent.setup();
    renderPanel({ routing: async () => settings(), fixtures: [local] });

    await user.click(
      await screen.findByRole("button", { name: "Suggest a model for Sees images" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Suggested models" });
    expect(dialog).toHaveTextContent(/Sees images stays as it is/);
    expect(within(dialog).getByRole("button", { name: "Use these" })).toBeDisabled();
  });
});
