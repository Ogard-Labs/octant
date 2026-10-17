import {
  decodeProject,
  decodeProviderInstance,
  decodeProviderModel,
  type Project,
  type ProviderInstance,
  type ProviderModel,
} from "@octant/contracts";
import { isProviderAllowedByProjectPolicy } from "@octant/domain";
import { describe, expect, it } from "vitest";
import { agentRunEligibleTargets } from "./agentRunDelegation";

const timestamp = "2026-07-14T09:00:00.000Z";
const binding = { canonicalRoot: "/Users/example/Atlas" } as const;
const boundProject = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Atlas",
  lifecycle: "active",
  pinned: false,
  rank: "0/1",
  version: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
  binding,
  bindingHistory: [
    {
      revisionId: "66666666-6666-4666-8666-666666666666",
      revision: 1,
      currentBinding: binding,
      actor: { kind: "local-user", actorId: "88888888-8888-4888-8888-888888888888" },
      changedAt: timestamp,
    },
  ],
} as const;

const provider = (id: string, displayName: string): ProviderInstance =>
  decodeProviderInstance({
    id,
    displayName,
    driverKind: "openai-compatible",
    configuration: {
      kind: "openai-compatible-http",
      baseUrl: "https://gateway.example/v1/",
      authentication: "bearer",
      protocol: "auto",
      manualModelIds: ["model"],
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  });

const model = (id: string, dataTags?: ReadonlyArray<"eu" | "zdr">): ProviderModel =>
  decodeProviderModel({
    id,
    displayName: id,
    source: "manual",
    verification: "unverified",
    reasoning: "supported",
    inputModalities: ["text"],
    options: [],
    ...(dataTags === undefined ? {} : { dataTags }),
  });

const resident = provider("80000000-0000-4000-8000-000000000010", "Resident");
const other = provider("80000000-0000-4000-8000-000000000011", "Other");
const modelsByProvider = new Map<string, ReadonlyArray<ProviderModel>>([
  [String(resident.id), [model("resident-eu", ["eu"]), model("resident-plain")]],
  [String(other.id), [model("other-plain")]],
]);

// The same check the host applies: the provider and its catalog model.
const allowedByProjectPolicy = (
  project: Exclude<Project, { readonly type: "chat" }>,
  providerInstanceId: ProviderInstance["id"],
  modelId: ProviderModel["id"],
): boolean => {
  const instance = [resident, other].find(
    (candidate) => String(candidate.id) === String(providerInstanceId),
  );
  const catalogModel = modelsByProvider
    .get(String(providerInstanceId))
    ?.find((candidate) => String(candidate.id) === String(modelId));
  return (
    instance !== undefined && isProviderAllowedByProjectPolicy(project, instance, catalogModel)
  );
};

const targetsFor = (
  project: Project | undefined,
  isTargetAllowed: typeof allowedByProjectPolicy = allowedByProjectPolicy,
) =>
  agentRunEligibleTargets({
    project,
    instances: [resident, other],
    observedState: (instanceId) => ({
      readiness: "ready",
      models: modelsByProvider.get(String(instanceId)) ?? [],
      verifiedToolModelIds: (modelsByProvider.get(String(instanceId)) ?? []).map(
        (candidate) => candidate.id,
      ),
    }),
    isTargetAllowed,
  }).map((target) => ({ provider: target.displayName, models: target.modelIds }));

const everyTarget = [
  { provider: "Resident", models: ["resident-eu", "resident-plain"] },
  { provider: "Other", models: ["other-plain"] },
];

describe("agentRunEligibleTargets", () => {
  it("offers only whitelisted providers to a Work Project's delegates", () => {
    const project = decodeProject({
      ...boundProject,
      type: "work",
      providerPolicy: { mode: "whitelist", providerInstanceIds: [resident.id] },
    });
    expect(targetsFor(project)).toEqual([
      { provider: "Resident", models: ["resident-eu", "resident-plain"] },
    ]);
  });

  it("offers only EU or ZDR models to delegates of a residency-restricted Work Project", () => {
    const project = decodeProject({
      ...boundProject,
      type: "work",
      providerPolicy: { mode: "eu-zdr", providerInstanceIds: [] },
    });
    expect(targetsFor(project)).toEqual([{ provider: "Resident", models: ["resident-eu"] }]);
  });

  it("keeps every ready target for a Chat Project, which carries no provider policy", () => {
    const { binding: _binding, bindingHistory: _history, ...virtual } = boundProject;
    const project = decodeProject({ ...virtual, type: "chat" });
    expect(targetsFor(project, () => false)).toEqual(everyTarget);
    expect(targetsFor(undefined, () => false)).toEqual(everyTarget);
  });

  it("still applies a Code Project's provider policy to its delegates", () => {
    const project = decodeProject({
      ...boundProject,
      type: "code",
      codeAccessPersistence: "current-session",
      providerPolicy: { mode: "whitelist", providerInstanceIds: [other.id] },
    });
    expect(targetsFor(project)).toEqual([{ provider: "Other", models: ["other-plain"] }]);
  });

  describe("direct endpoint models", () => {
    const foundry = decodeProviderInstance({
      id: "80000000-0000-4000-8000-000000000012",
      displayName: "Foundry",
      driverKind: "azure-foundry",
      configuration: {
        kind: "azure-foundry-openai-http",
        baseUrl: "https://example.services.ai.azure.com/openai/v1/",
        authentication: "api-key",
        protocol: "auto",
        manualModelIds: ["deepseek-flash", "other-deployment"],
      },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const targetsOf = (readiness: "ready" | "degraded", verified: ReadonlyArray<string>) =>
      agentRunEligibleTargets({
        project: undefined,
        instances: [foundry],
        observedState: () => ({
          readiness,
          models: [model("deepseek-flash"), model("other-deployment")],
          verifiedToolModelIds: verified.map((id) => model(id).id),
        }),
        isTargetAllowed: () => true,
      }).map((target) => target.modelIds);

    it("offers a tool-verified endpoint model even when its models route listed no deployment", () => {
      expect(targetsOf("degraded", ["deepseek-flash"])).toEqual([["deepseek-flash"]]);
      expect(targetsOf("ready", ["deepseek-flash"])).toEqual([["deepseek-flash"]]);
    });

    it("withholds an endpoint model whose tools were never verified", () => {
      expect(targetsOf("degraded", [])).toEqual([]);
      expect(targetsOf("ready", [])).toEqual([]);
    });
  });
});
