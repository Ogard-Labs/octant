import {
  decodeProject,
  decodeProviderInstance,
  decodeProviderModel,
  type CodeProject,
  type ProviderInstance,
  type ProviderModel,
} from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  assertProviderAllowedByProjectPolicy,
  isProviderAllowedByProjectPolicy,
  ProjectProviderPolicyRejected,
} from "./projectProviderPolicy";

const project: CodeProject = decodeProject({
  id: "80000000-0000-4000-8000-000000000001",
  type: "code",
  name: "Code",
  lifecycle: "active",
  pinned: false,
  rank: "0/1",
  version: 1,
  createdAt: "2026-07-14T10:00:00.000Z",
  updatedAt: "2026-07-14T10:00:00.000Z",
  binding: { canonicalRoot: "/tmp/code" },
  bindingHistory: [
    {
      revisionId: "80000000-0000-4000-8000-000000000002",
      revision: 1,
      currentBinding: { canonicalRoot: "/tmp/code" },
      actor: { kind: "local-user", actorId: "80000000-0000-4000-8000-000000000003" },
      changedAt: "2026-07-14T10:00:00.000Z",
    },
  ],
  codeAccessPersistence: "current-session",
  providerPolicy: { mode: "all", providerInstanceIds: [] },
}) as CodeProject;

const provider: ProviderInstance = decodeProviderInstance({
  id: "80000000-0000-4000-8000-000000000010",
  displayName: "Gateway",
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
  createdAt: "2026-07-14T10:00:00.000Z",
  updatedAt: "2026-07-14T10:00:00.000Z",
});

const model: ProviderModel = decodeProviderModel({
  id: "model",
  displayName: "Model",
  source: "manual",
  verification: "unverified",
  reasoning: "supported",
  inputModalities: ["text"],
  options: [],
});

describe("project provider policy", () => {
  it("allows projects without a policy by default", () => {
    const legacy = { ...project, providerPolicy: undefined } as CodeProject;
    expect(isProviderAllowedByProjectPolicy(legacy, provider, model)).toBe(true);
  });

  it("requires an EU or ZDR tag in the residency mode", () => {
    const restricted = {
      ...project,
      providerPolicy: { mode: "eu-zdr" as const, providerInstanceIds: [] },
    };
    expect(isProviderAllowedByProjectPolicy(restricted, provider, model)).toBe(false);
    expect(
      isProviderAllowedByProjectPolicy(restricted, { ...provider, dataTags: ["eu"] }, model),
    ).toBe(true);
    expect(
      isProviderAllowedByProjectPolicy(restricted, provider, { ...model, dataTags: ["zdr"] }),
    ).toBe(true);
  });

  it("allows only explicitly listed providers in whitelist mode", () => {
    const restricted = {
      ...project,
      providerPolicy: { mode: "whitelist" as const, providerInstanceIds: [provider.id] },
    };
    expect(isProviderAllowedByProjectPolicy(restricted, provider, model)).toBe(true);
    expect(
      isProviderAllowedByProjectPolicy(
        restricted,
        { ...provider, id: "80000000-0000-4000-8000-000000000011" as ProviderInstance["id"] },
        model,
      ),
    ).toBe(false);
  });

  it("returns an actionable refusal for a disallowed follow-up", () => {
    const restricted = {
      ...project,
      providerPolicy: { mode: "eu-zdr" as const, providerInstanceIds: [] },
    };
    expect(() => assertProviderAllowedByProjectPolicy(restricted, provider, model)).toThrow(
      ProjectProviderPolicyRejected,
    );
  });
});
