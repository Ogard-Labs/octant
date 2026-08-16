import { describe, expect, it, vi } from "vitest";
import type {
  ExtensionEffectiveSnapshot,
  ExtensionSnapshot,
} from "@octant/contracts/extension-rpc";
import {
  calculateExtensionPackageDigest,
  type ExtensionArchiveEntry,
  type InspectedExtensionPackage,
  type ResolvedExtensionPackage,
} from "./packageInspector";
import { ExtensionApiService } from "./extensionApiService";
import type { ExtensionLifecycleService } from "./extensionLifecycleService";
import { StandaloneSkillService } from "./standaloneSkillService";

const extensionId = "45000000-0000-4000-8000-000000000001";
const packageId = "45000000-0000-4000-8000-000000000002";

function resolvedPackage(): ResolvedExtensionPackage {
  const entries: ReadonlyArray<ExtensionArchiveEntry> = [
    {
      path: "private/runtime/main.mjs",
      kind: "file",
      content: new TextEncoder().encode("export default {}"),
      executable: true,
    },
  ];
  const manifest = {
    manifestVersion: 1,
    extensionId,
    packageId,
    slug: "api-fixture",
    displayName: "API fixture",
    version: "1.0.0",
    digest: `sha256:${"0".repeat(64)}`,
    source: { kind: "catalog", catalogId: "octant", entryId: "api-fixture" },
    provenance: {
      canonicalUrl: "https://example.com/api-fixture",
      publisher: "Example Publisher",
      reviewed: false,
    },
    license: { kind: "spdx", identifier: "MIT" },
    compatibility: { platforms: ["macos"], modes: ["code"], providerFamilies: [] },
    declaredCapabilities: ["mcp"],
    components: [
      {
        id: "server",
        kind: "mcp-server",
        displayName: "Server",
        declaredCapabilities: ["mcp"],
        entryPoint: "private/runtime/main.mjs",
      },
    ],
  };
  manifest.digest = calculateExtensionPackageDigest(manifest, entries);
  return {
    format: "zip",
    archiveBytes: 512,
    manifest,
    entries,
    expectedDigest: manifest.digest as never,
    appVersion: "1.0.0",
    platform: "darwin",
  };
}

const emptySnapshot: ExtensionSnapshot = {
  sequence: 0 as never,
  snapshotAt: "2026-07-28T12:00:00.000Z" as never,
  packages: [],
  collisions: [],
};

function lifecycle(captured: Array<InspectedExtensionPackage>): ExtensionLifecycleService {
  return {
    snapshot: () => emptySnapshot,
    install: async (inspection: InspectedExtensionPackage) => {
      captured.push(inspection);
      return emptySnapshot;
    },
    update: async (inspection: InspectedExtensionPackage) => {
      captured.push(inspection);
      return emptySnapshot;
    },
    rollback: async () => emptySnapshot,
    disable: async () => emptySnapshot,
    uninstall: async () => emptySnapshot,
    reconcileStartup: async () => emptySnapshot,
    setSourceTrust: async () => emptySnapshot,
    setPluginDesired: async () => emptySnapshot,
    setComponentDesired: async () => emptySnapshot,
  } as unknown as ExtensionLifecycleService;
}

describe("extension inspection and lifecycle API service", () => {
  it("includes bounded bundled skill instructions in the pre-trust package preview", async () => {
    const instructions = "Never disclose secrets. Review every change before applying it.";
    const entries: ReadonlyArray<ExtensionArchiveEntry> = [
      {
        path: "skills/review/SKILL.md",
        kind: "file",
        content: new TextEncoder().encode(instructions),
      },
    ];
    const manifest = {
      manifestVersion: 1,
      extensionId,
      packageId,
      slug: "review-skill",
      displayName: "Review skill",
      version: "1.0.0",
      digest: `sha256:${"0".repeat(64)}`,
      source: { kind: "local-folder", sourceRef: "local-review" },
      provenance: {
        canonicalUrl: "https://example.test/local-review",
        publisher: "Local",
        reviewed: false,
      },
      license: { kind: "spdx", identifier: "MIT" },
      compatibility: { platforms: ["macos"], modes: ["chat"], providerFamilies: [] },
      declaredCapabilities: ["instructions"],
      components: [
        {
          id: "review",
          kind: "skill-instructions",
          displayName: "Review",
          declaredCapabilities: ["instructions"],
          contentReference: "skills/review/SKILL.md",
        },
      ],
    };
    manifest.digest = calculateExtensionPackageDigest(manifest, entries);
    const resolved = {
      format: "directory",
      archiveBytes: instructions.length,
      manifest,
      entries,
      expectedDigest: manifest.digest as never,
      appVersion: "1.0.0",
      platform: "darwin" as const,
    };
    const service = new ExtensionApiService({
      lifecycle: lifecycle([]),
      resolver: {
        resolve: async () => resolved,
      },
    });

    const result = await service.execute({
      kind: "preview-package",
      source: manifest.source,
    } as never);
    if (result.kind === "extension-command-failed") throw new Error(JSON.stringify(result.failure));

    expect(result).toMatchObject({
      kind: "package-preview",
      preview: {
        review: {
          components: [{ id: "review", instructions }],
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("skills/review/SKILL.md");
  });

  it("keeps raw entry paths private and installs only the exact inspected target", async () => {
    const captured: Array<InspectedExtensionPackage> = [];
    const resolved = resolvedPackage();
    const service = new ExtensionApiService({
      lifecycle: lifecycle(captured),
      resolver: { resolve: async () => resolved },
    });
    const inspected = await service.execute({
      kind: "inspect-package",
      source: { kind: "catalog", catalogId: "octant", entryId: "api-fixture" },
      expectedDigest: resolved.expectedDigest,
    } as never);
    expect(JSON.stringify(inspected)).not.toContain("private/runtime");

    const installed = await service.execute({
      kind: "install-package",
      extensionId,
      packageId,
      version: "1.0.0",
      digest: resolved.expectedDigest,
    } as never);
    expect(installed.kind).toBe("extension-state-updated");
    expect(captured[0]?.entryPoints).toEqual({ server: "private/runtime/main.mjs" });
    expect(captured[0]?.manifest.components[0]?.entryPoint).toBe("entry:server");
  });

  it("fails closed when lifecycle targets were not inspected or source resolution throws private details", async () => {
    const service = new ExtensionApiService({
      lifecycle: lifecycle([]),
      resolver: {
        resolve: async () => {
          throw new Error("/Users/private/archive.zip token=secret");
        },
      },
    });
    const missing = await service.execute({
      kind: "install-package",
      extensionId,
      packageId,
      version: "1.0.0",
      digest: `sha256:${"a".repeat(64)}`,
    } as never);
    expect(missing).toEqual({
      kind: "extension-command-failed",
      failure: { category: "stale", message: "Package inspection is required." },
    });

    const failed = await service.execute({
      kind: "inspect-package",
      source: { kind: "catalog", catalogId: "octant", entryId: "api-fixture" },
    } as never);
    const serialized = JSON.stringify(failed);
    expect(serialized).toBe(
      '{"kind":"extension-command-failed","failure":{"category":"unavailable","message":"Package source is unavailable."}}',
    );
    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain("secret");
  });

  it("dispatches versioned desired-state commands and scoped effective-state queries", async () => {
    const state = lifecycle([]);
    const setSourceTrust = vi.spyOn(state, "setSourceTrust");
    const setPluginDesired = vi.spyOn(state, "setPluginDesired");
    const setComponentDesired = vi.spyOn(state, "setComponentDesired");
    const effective = {
      ...emptySnapshot,
      scope: {
        hostId: "local",
        mode: "code",
        projectId: null,
        threadId: null,
        providerFamily: "ollama",
      },
      catalogEpoch: `sha256:${"b".repeat(64)}`,
      catalogStatus: "offline",
      stale: false,
    } as unknown as ExtensionEffectiveSnapshot;
    const activation = { resolve: vi.fn(() => effective) };
    const service = new ExtensionApiService({
      lifecycle: state,
      resolver: { resolve: async () => resolvedPackage() },
      activation,
    });

    const commands = [
      {
        kind: "set-source-trust",
        commandVersion: 1,
        extensionId,
        trusted: true,
        expectedStateVersion: 2,
      },
      {
        kind: "set-plugin-desired",
        commandVersion: 1,
        extensionId,
        desired: true,
        expectedStateVersion: 3,
      },
      {
        kind: "set-component-desired",
        commandVersion: 1,
        extensionId,
        componentId: "server",
        desired: true,
        expectedStateVersion: 4,
      },
    ] as const;
    for (const command of commands) {
      expect((await service.execute(command as never)).kind).toBe("extension-state-updated");
    }
    const query = {
      kind: "query-effective-state",
      commandVersion: 1,
      scope: effective.scope,
    } as const;
    expect(await service.execute(query as never)).toEqual({
      kind: "extension-effective-state",
      snapshot: effective,
    });
    expect(setSourceTrust).toHaveBeenCalledWith(commands[0]);
    expect(setPluginDesired).toHaveBeenCalledWith(commands[1]);
    expect(setComponentDesired).toHaveBeenCalledWith(commands[2]);
    expect(activation.resolve).toHaveBeenCalledWith(emptySnapshot, { scope: effective.scope });
  });

  it("reconciles lifecycle snapshots returned by standalone skill commands", async () => {
    const removedSnapshot = {
      ...emptySnapshot,
      sequence: 1 as never,
      snapshotAt: "2026-08-09T02:00:00.000Z" as never,
    };
    const state = lifecycle([]);
    state.uninstall = vi.fn(async () => removedSnapshot);
    const skills = new StandaloneSkillService({
      discovery: {
        snapshot: () => ({ skills: [], collisions: [] }),
        reconcile: async () => ({ skills: [], collisions: [] }),
      },
      lifecycle: state,
    });
    const onStateChanged = vi.fn(async () => undefined);
    const service = new ExtensionApiService({
      lifecycle: state,
      resolver: { resolve: async () => resolvedPackage() },
      skills,
      onStateChanged,
    });

    const result = await service.execute({ kind: "remove-skill", extensionId } as never);

    expect(result).toMatchObject({
      kind: "extension-state-updated",
      snapshot: { sequence: removedSnapshot.sequence, packages: [] },
    });
    if (result.kind !== "extension-state-updated") throw new Error("Expected state update.");
    expect(onStateChanged).toHaveBeenCalledWith(result.snapshot);
  });

  it("forwards route cancellation to standalone skill marketplace commands", async () => {
    const execute = vi.fn(async () => ({
      kind: "skill-search-results" as const,
      entries: [],
    }));
    const skills = { execute, snapshot: () => emptySnapshot };
    const service = new ExtensionApiService({
      lifecycle: lifecycle([]),
      resolver: { resolve: async () => resolvedPackage() },
      skills: skills as never,
    });
    const controller = new AbortController();

    await service.execute({ kind: "search-skills", query: "review" } as never, controller.signal);

    expect(execute).toHaveBeenCalledWith(
      { kind: "search-skills", query: "review" },
      controller.signal,
    );
  });
});
