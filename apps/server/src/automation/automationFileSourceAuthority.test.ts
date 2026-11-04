import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { CodexProviderInstance, WorkProject } from "@octant/contracts";
import { captureAutomationDefinitionSnapshot } from "./automationRunIdentity";
import { automationDefinitionFixture, AUTOMATION_TEST_IDS } from "./automationTestFixtures";
import { resolveAutomationFileSourceAuthority } from "./automationFileSourceAuthority";

function fixture() {
  const definition = automationDefinitionFixture({
    trigger: {
      kind: "file-arrival",
      directory: "Inbox",
      includeExtensions: [],
      excludeDirectories: [],
      settleSeconds: 2,
      automaticStartLimit: 8,
    },
    nextDueAt: null,
  });
  let project = Schema.decodeUnknownSync(WorkProject)({
    id: definition.projectId,
    name: "Inputs",
    type: "work",
    lifecycle: "active",
    pinned: false,
    rank: "0/1",
    version: 1,
    createdAt: definition.createdAt,
    updatedAt: definition.updatedAt,
    binding: { canonicalRoot: "/project" },
    bindingHistory: [
      {
        revisionId: AUTOMATION_TEST_IDS.bindingRevision,
        revision: 1,
        currentBinding: { canonicalRoot: "/project" },
        actor: { kind: "local-user", actorId: AUTOMATION_TEST_IDS.actor },
        changedAt: definition.createdAt,
      },
    ],
  });
  let provider = Schema.decodeUnknownSync(CodexProviderInstance)({
    id: AUTOMATION_TEST_IDS.providerInstance,
    displayName: "Fixture configured provider",
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: definition.createdAt,
    updatedAt: definition.updatedAt,
    driverKind: "codex",
    configuration: { kind: "codex-cli", binaryPath: "/fixture/codex" },
  });
  let profileVersion = 1;
  let model = true;
  const deps = {
    hostId: "local",
    readProject: () => project,
    readProviderInstance: () => provider,
    providerSupportsModel: () => model,
    readExecutionProfileVersion: () => ({
      version: profileVersion,
      executionPolicy: "approval-gated",
    }),
    readCodeCheckoutAvailable: () => false,
  };
  const captured = resolveAutomationFileSourceAuthority(
    deps,
    captureAutomationDefinitionSnapshot(definition),
    definition.createdAt,
  );
  return {
    captured,
    mutations: {
      archived: () => {
        project = Schema.decodeUnknownSync(WorkProject)({
          ...project,
          lifecycle: "archived",
          version: 2,
        });
      },
      root: () => {
        project = Schema.decodeUnknownSync(WorkProject)({
          ...project,
          binding: { canonicalRoot: "/replacement" },
        });
      },
      binding: () => {
        project = Schema.decodeUnknownSync(WorkProject)({
          ...project,
          bindingHistory: [
            { ...project.bindingHistory[0], revisionId: "11111111-1111-4111-8111-111111111111" },
          ],
        });
      },
      profile: () => {
        profileVersion = 2;
      },
      provider: () => {
        provider = { ...provider, enabled: false };
      },
      model: () => {
        model = false;
      },
      policy: () => {
        project = Schema.decodeUnknownSync(WorkProject)({
          ...project,
          version: 2,
          providerPolicy: { mode: "whitelist", providerInstanceIds: [] },
        });
      },
    },
  };
}

describe("file source uses ordinary routine authority", () => {
  it("captures only the current main local Work root and exact binding", () => {
    const { captured } = fixture();
    expect(captured?.canonicalRoot).toBe("/project");
    expect(captured?.current()).toBe(true);
    expect(captured?.bindingIdentity).toContain(AUTOMATION_TEST_IDS.bindingRevision);
  });
  it.each(["archived", "root", "binding", "profile", "provider", "model", "policy"] as const)(
    "invalidates the retained source after %s changes without a provider probe",
    (change) => {
      const { captured, mutations } = fixture();
      expect(captured?.current()).toBe(true);
      mutations[change]();
      expect(captured?.current()).toBe(false);
    },
  );
});
