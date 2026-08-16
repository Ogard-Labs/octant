import { describe, expect, it, vi } from "vitest";
import type { ExtensionSnapshot } from "@octant/contracts/extension-rpc";
import type { SkillMarketplaceEntry } from "@octant/contracts/extension-rpc";
import type { ExtensionPackageManifest } from "@octant/contracts/extensions";
import {
  calculateExtensionPackageDigest,
  type ExtensionArchiveEntry,
  type InspectedExtensionPackage,
  type ResolvedExtensionPackage,
} from "./packageInspector";
import { StandaloneSkillService } from "./standaloneSkillService";

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
