import { describe, expect, it, vi } from "vitest";
import type { ExtensionSnapshot } from "@octant/contracts/extension-rpc";
import type { SkillMarketplaceEntry } from "@octant/contracts/extension-rpc";
import type { ExtensionPackageManifest, StandaloneSkillRecord } from "@octant/contracts/extensions";
import type { StandaloneSkillActivationState } from "@octant/contracts/shell";
import { admitApprovedProfileSkills } from "@octant/domain/agent-profile-policy";
import {
  resolveDraftExtensionReference,
  type ExtensionAddressingCatalog,
} from "@octant/plugin-host";
import {
  calculateExtensionPackageDigest,
  type ExtensionArchiveEntry,
  type InspectedExtensionPackage,
  type ResolvedExtensionPackage,
} from "./packageInspector";
import {
  StandaloneSkillService,
  type StandaloneSkillActivationStore,
} from "./standaloneSkillService";

const extensionId = "46000000-0000-4000-8000-000000000001";
const packageId = "46000000-0000-4000-8000-000000000002";
const digest = `sha256:${"0".repeat(64)}`;
const baseSnapshot: ExtensionSnapshot = {
  sequence: 0 as never,
  snapshotAt: "2026-07-28T12:00:00.000Z" as never,
  packages: [],
  collisions: [],
};

function resolvedPackage(): ResolvedExtensionPackage & {
  readonly manifest: ExtensionPackageManifest;
} {
  const entries: ReadonlyArray<ExtensionArchiveEntry> = [
    { path: "SKILL.md", kind: "file", content: new TextEncoder().encode("# review\n") },
  ];
  const manifestInput = {
    manifestVersion: 1,
    extensionId,
    packageId,
    slug: "review-skill",
    displayName: "Review skill",
    version: "1.0.0",
    digest,
    source: { kind: "catalog", catalogId: "skills", entryId: "review-skill" },
    provenance: {
      canonicalUrl: "https://example.com/review-skill",
      publisher: "Octant test publisher",
      reviewed: false,
    },
    license: { kind: "spdx", identifier: "MIT" },
    compatibility: { platforms: ["macos"], modes: ["chat"], providerFamilies: [] },
    declaredCapabilities: ["instructions"],
    components: [
      {
        id: "skill-review",
        kind: "skill-instructions",
        skillName: "review",
        displayName: "Review",
        declaredCapabilities: ["instructions"],
      },
    ],
  };
  const manifest = {
    ...manifestInput,
    digest: calculateExtensionPackageDigest(manifestInput, entries),
  } as unknown as ExtensionPackageManifest;
  return {
    format: "directory",
    archiveBytes: 64,
    manifest,
    entries,
    expectedDigest: manifest.digest as never,
    appVersion: "1.0.0",
    platform: "darwin",
  };
}

function marketplaceEntry(
  value: ResolvedExtensionPackage & { readonly manifest: ExtensionPackageManifest },
): SkillMarketplaceEntry {
  return {
    skill: {
      qualifiedId: `catalog:skills:skill-review:${value.manifest.digest}` as never,
      name: "review",
      sourceKind: "catalog",
      digest: value.manifest.digest as never,
      available: true,
    },
    source: value.manifest.source,
    version: value.manifest.version as never,
    displayName: "Review skill",
    provenance: value.manifest.provenance,
  };
}

describe("standalone skill marketplace service", () => {
  it("forwards request cancellation to marketplace search and preview resolution", async () => {
    const resolved = resolvedPackage();
    const search = vi.fn(async () => ({ entries: [marketplaceEntry(resolved)] }));
    const resolve = vi.fn(async () => resolved);
    const service = new StandaloneSkillService({
      discovery: {
        snapshot: () => ({ skills: [], collisions: [] }),
        reconcile: async () => ({ skills: [], collisions: [] }),
      },
      marketplace: { search, resolve },
      lifecycle: {
        snapshot: () => baseSnapshot,
        install: async () => baseSnapshot,
        update: async () => baseSnapshot,
        uninstall: async () => baseSnapshot,
      },
    });
    const controller = new AbortController();

    await service.execute({ kind: "search-skills", query: "review" }, controller.signal);
    await service.execute(
      { kind: "preview-skill", source: resolved.manifest.source },
      controller.signal,
    );

    expect(search).toHaveBeenCalledWith("review", undefined, controller.signal);
    expect(resolve).toHaveBeenCalledWith(resolved.manifest.source, controller.signal);
  });

  it("publishes the public skill name instead of its internal component id", () => {
    const resolved = resolvedPackage();
    const activation = {
      installed: true,
      trusted: true,
      pluginDesired: true,
      componentDesired: true,
      compatible: true,
      policyAllowed: true,
      quarantined: false,
      draining: false,
      broken: false,
      unavailable: false,
      interrupted: false,
      waiting: false,
    } as const;
    const snapshot = {
      ...baseSnapshot,
      packages: [
        {
          extensionId: resolved.manifest.extensionId,
          packageId: resolved.manifest.packageId,
          source: resolved.manifest.source,
          version: resolved.manifest.version,
          digest: resolved.manifest.digest,
          activation,
          components: [
            {
              component: resolved.manifest.components[0],
              activation,
              effectiveState: { kind: "effective" },
            },
          ],
        },
      ],
    } as unknown as ExtensionSnapshot;
    const service = new StandaloneSkillService({
      discovery: {
        snapshot: () => ({ skills: [], collisions: [] }),
        reconcile: async () => ({ skills: [], collisions: [] }),
      },
      lifecycle: {
        snapshot: () => snapshot,
        install: async () => snapshot,
        update: async () => snapshot,
        uninstall: async () => snapshot,
      },
    });

    expect(
      service.snapshot(snapshot).skills?.find((skill) => skill.source.kind === "catalog")?.skill
        .name,
    ).toBe("review");
  });

  it("refreshes discovery watchers after reconciling newly added Project roots", async () => {
    const reconcile = vi.fn(async () => ({ skills: [], collisions: [] }));
    const startWatching = vi.fn(async () => undefined);
    const service = new StandaloneSkillService({
      discovery: {
        snapshot: () => ({ skills: [], collisions: [] }),
        reconcile,
        startWatching,
      },
      lifecycle: {
        snapshot: () => baseSnapshot,
        install: async () => baseSnapshot,
        update: async () => baseSnapshot,
        uninstall: async () => baseSnapshot,
      },
    });

    await service.reconcile();

    expect(reconcile).toHaveBeenCalledOnce();
    expect(startWatching).toHaveBeenCalledOnce();
    expect(reconcile.mock.invocationCallOrder[0]).toBeLessThan(
      startWatching.mock.invocationCallOrder[0]!,
    );
  });

  it("searches and previews without activation, then installs through the shared lifecycle", async () => {
    const resolved = resolvedPackage();
    const inspected: InspectedExtensionPackage[] = [];
    const service = new StandaloneSkillService({
      discovery: {
        snapshot: () => ({ skills: [], collisions: [] }),
        reconcile: async () => ({ skills: [], collisions: [] }),
      },
      marketplace: {
        search: async () => ({ entries: [marketplaceEntry(resolved)] }),
        resolve: async () => resolved,
      },
      lifecycle: {
        snapshot: () => baseSnapshot,
        install: async (value) => {
          inspected.push(value);
          return baseSnapshot;
        },
        update: async (value) => {
          inspected.push(value);
          return baseSnapshot;
        },
        uninstall: async () => baseSnapshot,
      },
    });

    await service.reconcile();
    expect(await service.execute({ kind: "search-skills", query: "review" })).toMatchObject({
      kind: "skill-search-results",
    });
    const preview = await service.execute({
      kind: "preview-skill",
      source: resolved.manifest.source,
    });
    expect(preview).toMatchObject({
      kind: "skill-package-preview",
      preview: {
        license: { kind: "spdx", identifier: "MIT" },
        instructions: "# review",
      },
    });
    expect(JSON.stringify(preview)).toContain("# review");
    expect(
      await service.execute({
        kind: "install-skill",
        extensionId: extensionId as never,
        packageId: packageId as never,
        version: "1.0.0" as never,
        digest: resolved.manifest.digest,
      }),
    ).toMatchObject({ kind: "extension-state-updated" });
    expect(inspected).toHaveLength(1);
    expect(
      service
        .snapshot(baseSnapshot)
        .skills?.filter((skill) => skill.source.kind !== "bundled")
        .every((skill) => skill.desiredEnabled === false),
    ).toBe(true);
    expect(
      service
        .snapshot(baseSnapshot)
        .skills?.some(
          (skill) => skill.skill.name === "review-in-parallel" && skill.source.kind === "bundled",
        ),
    ).toBe(true);
  });
});

function discoveredSkill(
  name = "test-skill",
  content = "# Test skill instructions",
): StandaloneSkillRecord {
  const digest = `sha256:${"1".repeat(64)}` as never;
  const qualifiedId = `agents-skills-directory:user-global:${name}:${digest}` as never;
  return {
    skill: {
      qualifiedId,
      name,
      sourceKind: "agents-skills-directory",
      digest,
      available: true,
    },
    source: { kind: "agents-skills-directory", sourceRef: "user-global" as never },
    displayName: name,
    contentBytes: content.length,
    instructions: content,
    provenance: { reviewed: false },
    reviewed: false,
    desiredEnabled: false,
    effectiveState: { kind: "blocked", reason: "review-required" },
  };
}

function memoryActivationStore(
  initial: Readonly<Record<string, StandaloneSkillActivationState>> = {},
): {
  store: StandaloneSkillActivationStore;
  current: () => Readonly<Record<string, StandaloneSkillActivationState>>;
} {
  let activations: Readonly<Record<string, StandaloneSkillActivationState>> = initial;
  return {
    current: () => activations,
    store: {
      async read() {
        return activations;
      },
      async write(next) {
        activations = next;
      },
    },
  };
}

describe("standalone skill activation", () => {
  it("keeps discovered skills unavailable until reviewed, trusted, and enabled", async () => {
    const skill = discoveredSkill();
    const { store, current } = memoryActivationStore();
    const service = new StandaloneSkillService({
      discovery: {
        snapshot: () => ({ skills: [skill], collisions: [] }),
        reconcile: async () => ({ skills: [skill], collisions: [] }),
      },
      lifecycle: {
        snapshot: () => baseSnapshot,
        install: async () => baseSnapshot,
        update: async () => baseSnapshot,
        uninstall: async () => baseSnapshot,
      },
      activationStore: store,
    });

    await service.reconcile();
    const qualifiedId = String(skill.skill.qualifiedId);

    const blocked = service
      .snapshot(baseSnapshot)
      .skills?.find((candidate) => String(candidate.skill.qualifiedId) === qualifiedId);
    expect(blocked?.effectiveState).toEqual({ kind: "blocked", reason: "untrusted" });

    await service.execute({ kind: "review-skill", qualifiedId, digest: skill.skill.digest });
    expect(
      service
        .snapshot(baseSnapshot)
        .skills?.find((candidate) => String(candidate.skill.qualifiedId) === qualifiedId)?.reviewed,
    ).toBe(true);

    await service.execute({
      kind: "trust-skill-source",
      qualifiedId,
      digest: skill.skill.digest,
      trusted: true,
    });
    await service.execute({
      kind: "set-skill-desired",
      qualifiedId,
      digest: skill.skill.digest,
      desired: true,
    });

    const effective = service
      .snapshot(baseSnapshot)
      .skills?.find((candidate) => String(candidate.skill.qualifiedId) === qualifiedId);
    expect(effective?.effectiveState).toEqual({ kind: "effective" });
    expect(current()[qualifiedId]).toEqual({
      reviewed: true,
      trusted: true,
      desiredEnabled: true,
    });
  });

  it("revokes activation when the skill content changes and the digest no longer matches", async () => {
    const skill = discoveredSkill();
    const { store, current } = memoryActivationStore();
    const makeService = (skills: ReadonlyArray<StandaloneSkillRecord>) =>
      new StandaloneSkillService({
        discovery: {
          snapshot: () => ({ skills, collisions: [] }),
          reconcile: async () => ({ skills, collisions: [] }),
        },
        lifecycle: {
          snapshot: () => baseSnapshot,
          install: async () => baseSnapshot,
          update: async () => baseSnapshot,
          uninstall: async () => baseSnapshot,
        },
        activationStore: store,
      });
    const service = makeService([skill]);

    await service.reconcile();
    const qualifiedId = String(skill.skill.qualifiedId);
    await service.execute({ kind: "review-skill", qualifiedId, digest: skill.skill.digest });
    await service.execute({
      kind: "trust-skill-source",
      qualifiedId,
      digest: skill.skill.digest,
      trusted: true,
    });
    await service.execute({
      kind: "set-skill-desired",
      qualifiedId,
      digest: skill.skill.digest,
      desired: true,
    });

    const newDigest = `sha256:${"2".repeat(64)}` as never;
    const changedSkill: StandaloneSkillRecord = {
      ...skill,
      skill: {
        ...skill.skill,
        digest: newDigest,
        qualifiedId: `agents-skills-directory:user-global:test-skill:${newDigest}` as never,
      },
      instructions: "# changed",
    };
    const changedService = makeService([changedSkill]);
    await changedService.reconcile();

    const afterChange = changedService
      .snapshot(baseSnapshot)
      .skills?.find(
        (candidate) => String(candidate.skill.qualifiedId) === changedSkill.skill.qualifiedId,
      );
    expect(afterChange?.effectiveState).toEqual({ kind: "blocked", reason: "untrusted" });
    expect(current()[qualifiedId]).toEqual({
      reviewed: true,
      trusted: true,
      desiredEnabled: true,
    });
  });

  it("resolves name collisions by selecting exactly one source", async () => {
    const userSkill = discoveredSkill("colliding", "# user");
    const projectSkill: StandaloneSkillRecord = {
      ...discoveredSkill("colliding", "# project"),
      source: { kind: "agents-skills-directory", sourceRef: "project:project-1:working" as never },
      skill: {
        ...discoveredSkill("colliding", "# project").skill,
        qualifiedId:
          `agents-skills-directory:project:project-1:working:colliding:${"3".repeat(64)}` as never,
      },
    };
    const { store } = memoryActivationStore();
    const service = new StandaloneSkillService({
      discovery: {
        snapshot: () => ({ skills: [userSkill, projectSkill], collisions: [] }),
        reconcile: async () => ({ skills: [userSkill, projectSkill], collisions: [] }),
      },
      lifecycle: {
        snapshot: () => baseSnapshot,
        install: async () => baseSnapshot,
        update: async () => baseSnapshot,
        uninstall: async () => baseSnapshot,
      },
      activationStore: store,
    });

    await service.reconcile();
    expect(service.snapshot(baseSnapshot).collisions).toHaveLength(1);

    const qualifiedId = String(userSkill.skill.qualifiedId);
    await service.execute({
      kind: "select-skill-collision",
      name: "colliding",
      qualifiedId,
    });

    const snapshot = service.snapshot(baseSnapshot);
    expect(snapshot.collisions).toHaveLength(0);
    const selected = snapshot.skills?.find(
      (candidate) => String(candidate.skill.qualifiedId) === qualifiedId,
    );
    const superseded = snapshot.skills?.find(
      (candidate) => String(candidate.skill.qualifiedId) !== qualifiedId,
    );
    expect(selected?.effectiveState).toEqual({ kind: "effective" });
    expect(superseded?.effectiveState).toEqual({ kind: "blocked", reason: "superseded" });

    const projectQualifiedId = String(projectSkill.skill.qualifiedId);
    await service.execute({
      kind: "select-skill-collision",
      name: "colliding",
      qualifiedId: projectQualifiedId,
    });

    const switched = service.snapshot(baseSnapshot);
    const newlySelected = switched.skills?.find(
      (candidate) => String(candidate.skill.qualifiedId) === projectQualifiedId,
    );
    const previouslySelected = switched.skills?.find(
      (candidate) => String(candidate.skill.qualifiedId) === qualifiedId,
    );
    expect(newlySelected?.desiredEnabled).toBe(true);
    expect(newlySelected?.effectiveState).toEqual({ kind: "effective" });
    expect(previouslySelected?.desiredEnabled).toBe(false);
    expect(previouslySelected?.effectiveState).toEqual({ kind: "blocked", reason: "superseded" });
  });

  it("disables the first same-named skill when a second project root is enabled so Chat/Work, Code, and Canvas see only one", async () => {
    const agentsDigest = `sha256:${"3".repeat(64)}` as never;
    const claudeDigest = `sha256:${"4".repeat(64)}` as never;
    const agentsSkill: StandaloneSkillRecord = {
      ...discoveredSkill("deploy", "# agents deploy"),
      displayName: "Agents deploy",
      source: { kind: "agents-skills-directory", sourceRef: "project:project-1:working" as never },
      skill: {
        ...discoveredSkill("deploy", "# agents deploy").skill,
        digest: agentsDigest,
        qualifiedId:
          `agents-skills-directory:project:project-1:working:deploy:${agentsDigest}` as never,
      },
    };
    const claudeSkill: StandaloneSkillRecord = {
      ...discoveredSkill("deploy", "# claude deploy"),
      displayName: "Secondary deploy",
      source: {
        kind: "agents-skills-directory",
        sourceRef: "project:project-1:claude:working" as never,
      },
      skill: {
        ...discoveredSkill("deploy", "# claude deploy").skill,
        digest: claudeDigest,
        qualifiedId:
          `agents-skills-directory:project:project-1:claude:working:deploy:${claudeDigest}` as never,
      },
    };
    const { store } = memoryActivationStore();
    const service = new StandaloneSkillService({
      discovery: {
        snapshot: () => ({ skills: [agentsSkill, claudeSkill], collisions: [] }),
        reconcile: async () => ({ skills: [agentsSkill, claudeSkill], collisions: [] }),
      },
      lifecycle: {
        snapshot: () => baseSnapshot,
        install: async () => baseSnapshot,
        update: async () => baseSnapshot,
        uninstall: async () => baseSnapshot,
      },
      activationStore: store,
    });

    await service.reconcile();
    const agentsId = String(agentsSkill.skill.qualifiedId);
    const claudeId = String(claudeSkill.skill.qualifiedId);

    // Both start disabled behind the activation ladder.
    expect(
      service
        .snapshot(baseSnapshot)
        .skills?.filter((candidate) => candidate.skill.name === "deploy")
        .map((candidate) => candidate.effectiveState),
    ).toEqual([
      { kind: "blocked", reason: "untrusted" },
      { kind: "blocked", reason: "untrusted" },
    ]);

    // Enable the first skill through the activation ladder.
    await service.execute({ kind: "review-skill", qualifiedId: agentsId, digest: agentsDigest });
    await service.execute({
      kind: "trust-skill-source",
      qualifiedId: agentsId,
      digest: agentsDigest,
      trusted: true,
    });
    await service.execute({
      kind: "set-skill-desired",
      qualifiedId: agentsId,
      digest: agentsDigest,
      desired: true,
    });

    const firstEnabled = service.snapshot(baseSnapshot);
    expect(
      firstEnabled.skills?.find((candidate) => String(candidate.skill.qualifiedId) === agentsId)
        ?.effectiveState,
    ).toEqual({ kind: "effective" });

    // Enabling the second same-named skill disables the first.
    await service.execute({ kind: "review-skill", qualifiedId: claudeId, digest: claudeDigest });
    await service.execute({
      kind: "trust-skill-source",
      qualifiedId: claudeId,
      digest: claudeDigest,
      trusted: true,
    });
    await service.execute({
      kind: "set-skill-desired",
      qualifiedId: claudeId,
      digest: claudeDigest,
      desired: true,
    });

    const secondEnabled = service.snapshot(baseSnapshot);
    const skills = secondEnabled.skills ?? [];
    const firstAfter = skills.find((candidate) => String(candidate.skill.qualifiedId) === agentsId);
    const secondAfter = skills.find(
      (candidate) => String(candidate.skill.qualifiedId) === claudeId,
    );
    expect(firstAfter?.desiredEnabled).toBe(false);
    expect(firstAfter?.effectiveState).toEqual({ kind: "blocked", reason: "superseded" });
    expect(secondAfter?.desiredEnabled).toBe(true);
    expect(secondAfter?.effectiveState).toEqual({ kind: "effective" });

    // Chat/Work resolveDraftExtensionReference (resolveSkill) sees only the active skill.
    const addressingCatalog: ExtensionAddressingCatalog = {
      epoch: `sha256:${"e".repeat(64)}` as never,
      plugins: [],
      skills: skills.map((candidate) => ({
        skillId: candidate.skill.qualifiedId,
        name: candidate.skill.name,
        label: candidate.displayName,
        packageDigest: candidate.skill.digest,
        effectiveState: candidate.effectiveState,
      })),
    };
    expect(
      resolveDraftExtensionReference("$deploy", addressingCatalog, "draft-deploy"),
    ).toMatchObject({
      kind: "selected",
      label: "Secondary deploy",
      selection: {
        kind: "skill",
        skillId: claudeId,
        packageDigest: claudeDigest,
      },
    });

    // Code admitApprovedProfileSkills sees only the active skill.
    expect(
      admitApprovedProfileSkills({
        approvedSkillIds: ["deploy"],
        skills: skills.map((candidate) => ({
          qualifiedId: String(candidate.skill.qualifiedId),
          name: candidate.skill.name,
          displayName: candidate.displayName,
          effective: candidate.effectiveState.kind === "effective",
        })),
      }),
    ).toEqual([
      {
        qualifiedId: claudeId,
        name: "deploy",
        displayName: "Secondary deploy",
      },
    ]);

    // Canvas refresh skill list sees only the active deploy skill.
    const canvasSkills = skills.filter(
      (candidate) =>
        candidate.skill.name === "deploy" &&
        candidate.desiredEnabled &&
        candidate.effectiveState.kind === "effective",
    );
    expect(canvasSkills.map((candidate) => String(candidate.skill.qualifiedId))).toEqual([
      claudeId,
    ]);

    // A stale command for a nonexistent digest/key fails as stale without disabling the live skill.
    const staleDigest = `sha256:${"9".repeat(64)}` as never;
    const staleId = `agents-skills-directory:project:project-1:working:deploy:${staleDigest}`;
    await expect(
      service.execute({
        kind: "set-skill-desired",
        qualifiedId: staleId,
        digest: staleDigest,
        desired: true,
      }),
    ).resolves.toEqual({
      kind: "extension-command-failed",
      failure: { category: "stale", message: "Skill state is out of date." },
    });
    expect(
      service
        .snapshot(baseSnapshot)
        .skills?.find((candidate) => String(candidate.skill.qualifiedId) === claudeId)
        ?.effectiveState,
    ).toEqual({ kind: "effective" });
  });

  it("turns a built-in skill off when a discovered skill of the same name is turned on", async () => {
    const bundledName = "review-in-parallel";
    const discovered = discoveredSkill(bundledName, "# discovered review");
    const { store, current } = memoryActivationStore();
    const service = activationService([discovered], store);
    await service.reconcile();
    const bundledId = String(
      service
        .snapshot(baseSnapshot)
        .skills?.find(
          (candidate) =>
            candidate.skill.name === bundledName && candidate.source.kind === "bundled",
        )?.skill.qualifiedId,
    );

    await enable(service, discovered);

    const after = service.snapshot(baseSnapshot).skills ?? [];
    const bundled = after.find((candidate) => String(candidate.skill.qualifiedId) === bundledId);
    expect(bundled?.desiredEnabled).toBe(false);
    expect(bundled?.effectiveState).toEqual({ kind: "blocked", reason: "superseded" });
    expect(
      after.filter(
        (candidate) =>
          candidate.skill.name === bundledName && candidate.effectiveState.kind === "effective",
      ),
    ).toHaveLength(1);
    // The built-in skill keeps its own review and trust when it is turned off.
    expect(current()[bundledId]).toEqual({ reviewed: true, trusted: true, desiredEnabled: false });
  });

  it("reads an activation file that left two same-named skills on as neither on until one is chosen", async () => {
    const userSkill = discoveredSkill("deploy", "# user deploy");
    const projectSkill = scopedSkill("deploy", "5", "project:project-a:root", {
      projectScope: { mode: "code", projectId: "project-a" as never },
    });
    const on = { reviewed: true, trusted: true, desiredEnabled: true } as const;
    const { store, current } = memoryActivationStore({
      [String(userSkill.skill.qualifiedId)]: on,
      [String(projectSkill.skill.qualifiedId)]: on,
    });
    const service = activationService([userSkill, projectSkill], store);

    await service.reconcile();

    const snapshot = service.snapshot(baseSnapshot);
    const deploys = (snapshot.skills ?? []).filter(
      (candidate) => candidate.skill.name === "deploy",
    );
    expect(deploys.map((candidate) => candidate.effectiveState.kind)).toEqual([
      "blocked",
      "blocked",
    ]);
    expect(deploys.map((candidate) => candidate.desiredEnabled)).toEqual([false, false]);
    expect(snapshot.collisions.map((collision) => collision.name)).toEqual(["deploy"]);
    expect(current()[String(userSkill.skill.qualifiedId)]?.desiredEnabled).toBe(false);
    expect(current()[String(projectSkill.skill.qualifiedId)]?.desiredEnabled).toBe(false);
  });

  it("keeps each Project's same-named skill to itself while a shared one gives way to both", async () => {
    const userSkill = discoveredSkill("deploy", "# user deploy");
    const alphaSkill = scopedSkill("deploy", "6", "project:project-a:root", {
      projectScope: { mode: "code", projectId: "project-a" as never },
    });
    const betaSkill = scopedSkill("deploy", "7", "project:project-b:claude:root", {
      projectScope: { mode: "code", projectId: "project-b" as never },
    });
    const { store } = memoryActivationStore();
    const service = activationService([userSkill, alphaSkill, betaSkill], store);
    await service.reconcile();

    await enable(service, userSkill);
    await enable(service, alphaSkill);

    const afterAlpha = byId(service.snapshot(baseSnapshot));
    expect(afterAlpha(userSkill)?.desiredEnabled).toBe(false);
    expect(afterAlpha(userSkill)?.effectiveState).toEqual({
      kind: "blocked",
      reason: "superseded",
    });
    expect(afterAlpha(alphaSkill)?.effectiveState).toEqual({ kind: "effective" });
    // Another Project's skill is neither changed nor labelled as given way.
    expect(afterAlpha(betaSkill)?.effectiveState).toEqual({ kind: "blocked", reason: "untrusted" });

    await enable(service, betaSkill);

    const snapshot = service.snapshot(baseSnapshot);
    const afterBeta = byId(snapshot);
    expect(afterBeta(alphaSkill)?.desiredEnabled).toBe(true);
    expect(afterBeta(alphaSkill)?.effectiveState).toEqual({ kind: "effective" });
    expect(afterBeta(betaSkill)?.effectiveState).toEqual({ kind: "effective" });
    expect(afterBeta(userSkill)?.effectiveState).toEqual({
      kind: "blocked",
      reason: "superseded",
    });
    expect(snapshot.collisions).toEqual([]);

    await service.execute({
      kind: "select-skill-collision",
      name: "deploy",
      qualifiedId: String(userSkill.skill.qualifiedId),
    });

    const afterUser = byId(service.snapshot(baseSnapshot));
    expect(afterUser(userSkill)?.effectiveState).toEqual({ kind: "effective" });
    expect(afterUser(alphaSkill)?.desiredEnabled).toBe(false);
    expect(afterUser(betaSkill)?.desiredEnabled).toBe(false);
  });

  it("refuses a skill switch for an installed skill and says where it is switched", async () => {
    const resolved = resolvedPackage();
    const snapshot = installedSnapshot(resolved);
    const service = new StandaloneSkillService({
      discovery: {
        snapshot: () => ({ skills: [], collisions: [] }),
        reconcile: async () => ({ skills: [], collisions: [] }),
      },
      lifecycle: {
        snapshot: () => snapshot,
        install: async () => snapshot,
        update: async () => snapshot,
        uninstall: async () => snapshot,
      },
    });
    const installed = service
      .snapshot(snapshot)
      .skills?.find((skill) => skill.source.kind === "catalog");
    if (installed === undefined) throw new Error("The installed skill is missing.");

    await expect(
      service.execute({
        kind: "set-skill-desired",
        qualifiedId: String(installed.skill.qualifiedId),
        digest: installed.skill.digest,
        desired: false,
      }),
    ).resolves.toEqual({
      kind: "extension-command-failed",
      failure: {
        category: "blocked",
        message:
          "An installed skill is switched on and off with its package in Extension packages.",
      },
    });
  });
});

function scopedSkill(
  name: string,
  digestCharacter: string,
  sourceRef: string,
  scope: Pick<StandaloneSkillRecord, "scope" | "projectScope">,
): StandaloneSkillRecord {
  const base = discoveredSkill(name, `# ${sourceRef}`);
  const digest = `sha256:${digestCharacter.repeat(64)}` as never;
  return {
    ...base,
    ...scope,
    source: { kind: "agents-skills-directory", sourceRef: sourceRef as never },
    skill: {
      ...base.skill,
      digest,
      qualifiedId: `agents-skills-directory:${sourceRef}:${name}:${digest}` as never,
    },
  };
}

function activationService(
  skills: ReadonlyArray<StandaloneSkillRecord>,
  store: StandaloneSkillActivationStore,
): StandaloneSkillService {
  return new StandaloneSkillService({
    discovery: {
      snapshot: () => ({ skills, collisions: [] }),
      reconcile: async () => ({ skills, collisions: [] }),
    },
    lifecycle: {
      snapshot: () => baseSnapshot,
      install: async () => baseSnapshot,
      update: async () => baseSnapshot,
      uninstall: async () => baseSnapshot,
    },
    activationStore: store,
  });
}

async function enable(service: StandaloneSkillService, skill: StandaloneSkillRecord) {
  const qualifiedId = String(skill.skill.qualifiedId);
  const digest = skill.skill.digest;
  await service.execute({ kind: "review-skill", qualifiedId, digest });
  await service.execute({ kind: "trust-skill-source", qualifiedId, digest, trusted: true });
  await service.execute({ kind: "set-skill-desired", qualifiedId, digest, desired: true });
}

function byId(snapshot: ExtensionSnapshot) {
  return (skill: StandaloneSkillRecord) =>
    snapshot.skills?.find(
      (candidate) => String(candidate.skill.qualifiedId) === String(skill.skill.qualifiedId),
    );
}

function installedSnapshot(resolved: ReturnType<typeof resolvedPackage>): ExtensionSnapshot {
  const activation = {
    installed: true,
    trusted: true,
    pluginDesired: true,
    componentDesired: true,
    compatible: true,
    policyAllowed: true,
    quarantined: false,
    draining: false,
    broken: false,
    unavailable: false,
    interrupted: false,
    waiting: false,
  } as const;
  return {
    ...baseSnapshot,
    packages: [
      {
        extensionId: resolved.manifest.extensionId,
        packageId: resolved.manifest.packageId,
        source: resolved.manifest.source,
        version: resolved.manifest.version,
        digest: resolved.manifest.digest,
        activation,
        components: [
          {
            component: resolved.manifest.components[0],
            activation,
            effectiveState: { kind: "effective" },
          },
        ],
      },
    ],
  } as unknown as ExtensionSnapshot;
}
