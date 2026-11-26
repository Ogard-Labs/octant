import { describe, expect, it } from "vitest";
import {
  automationPromptDigest,
  revalidateAutomationAuthority,
  type AutomationAuthorityLiveFacts,
} from "./automationAuthorityRevalidation";
import {
  AUTOMATION_TEST_IDS,
  automationDefinitionFixture,
  automationRunForDefinition,
} from "./automationTestFixtures";

function facts(
  overrides: Partial<AutomationAuthorityLiveFacts> = {},
): AutomationAuthorityLiveFacts {
  const definition = automationDefinitionFixture();
  return {
    hostId: "local",
    project: {
      id: definition.projectId,
      type: "work",
      lifecycle: "active",
      version: definition.projectVersion,
      binding: { canonicalRoot: "/tmp/project" },
      bindingHistory: [
        {
          revisionId: AUTOMATION_TEST_IDS.bindingRevision,
          currentBinding: { canonicalRoot: "/tmp/project" },
        },
      ],
    } as never,
    providerInstance: {
      id: AUTOMATION_TEST_IDS.providerInstance,
      enabled: true,
    } as never,
    providerSupportsModel: true,
    executionProfileMatches: true,
    authorityDigestMatches: true,
    extensionTrustMatches: true,
    codeBindingMatches: true,
    workBindingMatches: true,
    ...overrides,
  };
}

describe("revalidateAutomationAuthority", () => {
  it("accepts matching live host facts", () => {
    const definition = automationDefinitionFixture();
    const run = automationRunForDefinition(definition);
    expect(revalidateAutomationAuthority({ definition, run, facts: facts() })).toEqual({
      kind: "ok",
    });
  });

  it("fails closed on host, project, binding, profile, provider, and digest mismatches", () => {
    const definition = automationDefinitionFixture();
    const run = automationRunForDefinition(definition);
    expect(
      revalidateAutomationAuthority({
        definition,
        run,
        facts: facts({ hostId: "other-host" }),
      }).kind,
    ).toBe("blocked");
    expect(
      revalidateAutomationAuthority({
        definition,
        run,
        facts: facts({ project: undefined }),
      }),
    ).toMatchObject({ kind: "blocked", reason: "project-mismatch" });
    expect(
      revalidateAutomationAuthority({
        definition,
        run,
        facts: facts({ workBindingMatches: false }),
      }),
    ).toMatchObject({ kind: "blocked", reason: "binding-mismatch" });
    expect(
      revalidateAutomationAuthority({
        definition,
        run,
        facts: facts({ executionProfileMatches: false }),
      }),
    ).toMatchObject({ kind: "blocked", reason: "execution-profile-mismatch" });
    expect(
      revalidateAutomationAuthority({
        definition,
        run,
        facts: facts({ providerSupportsModel: false }),
      }),
    ).toMatchObject({ kind: "blocked", reason: "provider-capability-mismatch" });
    expect(
      revalidateAutomationAuthority({
        definition,
        run,
        facts: facts({ authorityDigestMatches: false }),
      }),
    ).toMatchObject({ kind: "blocked", reason: "authority-mismatch" });
    expect(
      revalidateAutomationAuthority({
        definition,
        run,
        facts: facts({ extensionTrustMatches: false }),
      }),
    ).toMatchObject({ kind: "blocked", reason: "authority-mismatch" });
  });

  it("never runs a Work routine saved without the shell and Git every Work turn now holds", () => {
    const withoutShell = {
      filesystem: true,
      shell: false,
      git: false,
      network: false,
      tools: true,
      subagents: false,
      executionPolicy: "approval-gated",
      permissionPersistence: "current-session",
    } as const;
    const definition = automationDefinitionFixture({
      authorityProfile: {
        profileId: AUTOMATION_TEST_IDS.authorityProfile,
        profileVersion: 1,
        requested: withoutShell,
        effective: withoutShell,
        effectiveAuthorityDigest: "automation-authority-digest",
      },
    } as never);
    const run = automationRunForDefinition(definition);
    expect(revalidateAutomationAuthority({ definition, run, facts: facts() })).toMatchObject({
      kind: "blocked",
      reason: "authority-mismatch",
    });

    // Saved again under a profile that grants them, it runs.
    const saved = automationDefinitionFixture();
    expect(
      revalidateAutomationAuthority({
        definition: saved,
        run: automationRunForDefinition(saved),
        facts: facts(),
      }),
    ).toMatchObject({ kind: "ok" });
  });

  it("rejects Full access snapshots", () => {
    const definition = automationDefinitionFixture({
      authorityProfile: {
        profileId: AUTOMATION_TEST_IDS.authorityProfile,
        profileVersion: 1,
        requested: {
          filesystem: true,
          shell: false,
          git: false,
          network: false,
          tools: true,
          subagents: false,
          executionPolicy: "full-access",
          permissionPersistence: "current-session",
        },
        effective: {
          filesystem: true,
          shell: false,
          git: false,
          network: false,
          tools: true,
          subagents: false,
          executionPolicy: "full-access",
          permissionPersistence: "current-session",
        },
        effectiveAuthorityDigest: "automation-authority-digest",
      },
    } as never);
    // Full-access definitions fail contract decode; assert via mutated run snapshot.
    const run = automationRunForDefinition(automationDefinitionFixture());
    const poisoned = {
      ...run,
      authoritySnapshot: {
        ...run.authoritySnapshot,
        requested: { ...run.authoritySnapshot.requested, executionPolicy: "full-access" as const },
        effective: { ...run.authoritySnapshot.effective, executionPolicy: "full-access" as const },
      },
    };
    expect(
      revalidateAutomationAuthority({
        definition: automationDefinitionFixture(),
        run: poisoned as never,
        facts: facts(),
      }),
    ).toMatchObject({ kind: "blocked", reason: "full-access-ineligible" });
    void definition;
  });

  it("keeps an Antigravity routine's sources watched, leaving its runs to be refused at dispatch", () => {
    const definition = automationDefinitionFixture();
    const run = automationRunForDefinition(definition);
    // Source polling and file arming read the same revalidation; refusing
    // here would stop them silently, with no run to say why.
    expect(
      revalidateAutomationAuthority({
        definition,
        run,
        facts: facts({
          providerInstance: {
            id: AUTOMATION_TEST_IDS.providerInstance,
            enabled: true,
            driverKind: "antigravity",
          } as never,
        }),
      }),
    ).toEqual({ kind: "ok" });
  });

  it("blocks an occurrence of a webhook routine whose stored definition reaches above Ask first", () => {
    const definition = automationDefinitionFixture();
    const run = automationRunForDefinition(definition);
    const webhook = {
      kind: "integration-event",
      integrationId: "octant.webhooks",
      sourceId: "endpoint",
      filters: { endpoint: "AAAAAAAAAAAAAAAAAAAAAA" },
      pollMinutes: 1,
      automaticStartLimit: 8,
    };
    for (const levels of [{ projectLevel: "opted-in" }, { runLevel: "auto" }]) {
      // Such a definition fails contract decode; this is the stored copy a
      // run carries, checked again before every occurrence.
      const poisoned = {
        ...run,
        definitionSnapshot: { ...run.definitionSnapshot, trigger: webhook, ...levels },
      };
      expect(
        revalidateAutomationAuthority({ definition, run: poisoned as never, facts: facts() }),
      ).toMatchObject({ kind: "blocked", reason: "full-access-ineligible" });
    }
  });

  it("digests the task prompt stably", () => {
    expect(automationPromptDigest("Summarize the Project's open work.")).toEqual(
      automationPromptDigest("Summarize the Project's open work."),
    );
    expect(automationPromptDigest("a")).not.toEqual(automationPromptDigest("b"));
  });
});
