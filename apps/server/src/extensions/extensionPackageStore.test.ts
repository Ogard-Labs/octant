import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  calculateExtensionPackageDigest,
  inspectExtensionPackage,
  type ExtensionArchiveEntry,
} from "./packageInspector";
import { ExtensionPackageStore, ExtensionPackageStoreError } from "./extensionPackageStore";
import type { OutsideDriverRuntime } from "./extensionSupervisor";

const directories: Array<string> = [];
const extensionId = "42000000-0000-4000-8000-000000000001";
const packageId = "42000000-0000-4000-8000-000000000002";

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (directory) => {
      await makeWritable(directory);
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

async function makeWritable(directory: string): Promise<void> {
  await chmod(directory, 0o700).catch(() => undefined);
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) await makeWritable(join(directory, entry.name));
    else await chmod(join(directory, entry.name), 0o600).catch(() => undefined);
  }
}

function inspection(version = "1.0.0", body = "version one", includeDirectory = false) {
  const entries: ReadonlyArray<ExtensionArchiveEntry> = [
    ...(includeDirectory ? [{ path: "runtime", kind: "directory" as const }] : []),
    {
      path: "runtime/main.mjs",
      kind: "file",
      content: new TextEncoder().encode(body),
      executable: true,
    },
  ];
  const manifest = {
    manifestVersion: 1,
    extensionId,
    packageId,
    slug: "store-fixture",
    displayName: "Store fixture",
    version,
    digest: `sha256:${"0".repeat(64)}`,
    source: { kind: "catalog", catalogId: "octant", entryId: "store-fixture" },
    provenance: {
      canonicalUrl: "https://example.com/store-fixture",
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
        entryPoint: "runtime/main.mjs",
      },
    ],
  };
  manifest.digest = calculateExtensionPackageDigest(manifest, entries);
  return inspectExtensionPackage({
    format: "zip",
    archiveBytes: 512,
    manifest,
    entries,
    expectedDigest: manifest.digest as never,
    appVersion: "1.0.0",
    platform: "darwin",
  });
}

function instructionInspection() {
  const entries: ReadonlyArray<ExtensionArchiveEntry> = [
    {
      path: "skills/review/SKILL.md",
      kind: "file",
      content: new TextEncoder().encode("Use the verified review instructions."),
      executable: false,
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
    source: { kind: "catalog", catalogId: "octant", entryId: "review-skill" },
    provenance: {
      canonicalUrl: "https://example.com/review-skill",
      publisher: "Example Publisher",
      reviewed: true,
    },
    license: { kind: "spdx", identifier: "MIT" },
    compatibility: { platforms: ["macos"], modes: ["chat"], providerFamilies: [] },
    declaredCapabilities: ["instructions"],
    components: [
      {
        id: "review",
        kind: "skill-instructions",
        displayName: "Review instructions",
        declaredCapabilities: ["instructions"],
        contentReference: "skills/review/SKILL.md",
      },
    ],
  };
  manifest.digest = calculateExtensionPackageDigest(manifest, entries);
  return inspectExtensionPackage({
    format: "directory",
    archiveBytes: 128,
    manifest,
    entries,
    expectedDigest: manifest.digest as never,
    appVersion: "1.0.0",
    platform: "darwin",
  });
}

function configuredServerInspection() {
  const entries: ReadonlyArray<ExtensionArchiveEntry> = [
    {
      path: "mcp.json",
      kind: "file",
      content: new TextEncoder().encode("{}"),
      executable: false,
    },
  ];
  const manifest = {
    manifestVersion: 1,
    extensionId,
    packageId,
    slug: "configured-server",
    displayName: "Configured server",
    version: "1.0.0",
    digest: `sha256:${"0".repeat(64)}`,
    source: { kind: "catalog", catalogId: "octant", entryId: "configured-server" },
    provenance: {
      canonicalUrl: "https://example.com/configured-server",
      publisher: "Example Publisher",
      reviewed: false,
    },
    license: { kind: "spdx", identifier: "MIT" },
    compatibility: { platforms: ["macos"], modes: ["chat"], providerFamilies: [] },
    declaredCapabilities: ["mcp", "shell"],
    components: [
      {
        id: "server",
        kind: "mcp-server",
        displayName: "Server",
        declaredCapabilities: ["mcp", "shell"],
        configurationReference: "mcp.json",
      },
    ],
  };
  manifest.digest = calculateExtensionPackageDigest(manifest, entries);
  return inspectExtensionPackage({
    format: "directory",
    archiveBytes: 128,
    manifest,
    entries,
    expectedDigest: manifest.digest as never,
    appVersion: "1.0.0",
    platform: "darwin",
  });
}

function driverInspection() {
  const entries: ReadonlyArray<ExtensionArchiveEntry> = [
    {
      path: "driver/main.mjs",
      kind: "file",
      content: new TextEncoder().encode("export {};\n"),
      executable: false,
    },
  ];
  const manifest = {
    manifestVersion: 1,
    extensionId,
    packageId,
    slug: "loopback-driver",
    displayName: "Loopback driver",
    version: "0.1.0",
    digest: `sha256:${"0".repeat(64)}`,
    source: { kind: "local-folder", sourceRef: "folder-1" },
    provenance: {
      canonicalUrl: "https://example.com/loopback-driver",
      publisher: "Example Publisher",
      reviewed: false,
    },
    license: { kind: "spdx", identifier: "MIT" },
    compatibility: { platforms: ["macos"], modes: ["chat", "work", "code"], providerFamilies: [] },
    declaredCapabilities: [],
    components: [
      {
        id: "driver",
        kind: "provider-driver",
        displayName: "Loopback driver",
        declaredCapabilities: [],
        entryPoint: "driver/main.mjs",
      },
    ],
  };
  manifest.digest = calculateExtensionPackageDigest(manifest, entries);
  return inspectExtensionPackage({
    format: "zip",
    archiveBytes: 512,
    manifest,
    entries,
    expectedDigest: manifest.digest as never,
    appVersion: "1.0.0",
    platform: "darwin",
  });
}

async function setup(options: { readonly outsideDriverRuntime?: OutsideDriverRuntime } = {}) {
  const dataDirectory = await mkdtemp(join(tmpdir(), "octant-extension-store-"));
  directories.push(dataDirectory);
  let next = 0;
  const ids = [
    "42000000-0000-4000-8000-000000000010",
    "42000000-0000-4000-8000-000000000011",
    "42000000-0000-4000-8000-000000000012",
  ];
  const store = new ExtensionPackageStore({
    dataDirectory,
    uuid: () => ids[next++]!,
    ...options,
  });
  await store.initialize();
  return { store, dataDirectory };
}

describe("host-private immutable extension package store", () => {
  it("authorizes a reviewed host executable for a configuration-backed server", async () => {
    const { store, dataDirectory } = await setup();
    const target = await store.promote(await store.stage(configuredServerInspection()));
    const contentRoot = join(
      dataDirectory,
      "extensions",
      "versions",
      target.extensionId,
      target.packageId,
      `${target.version}--${target.digest.slice("sha256:".length)}`,
      "content",
    );
    await expect(
      store.authorizeRuntimeLaunch({
        ...target,
        componentId: "server",
        entryPoint: join(contentRoot, "mcp.json"),
        command: "/usr/bin/env",
        cwd: contentRoot,
      }),
    ).resolves.toBe(true);
  });

  it("stages privately, promotes atomically, and hardens immutable permissions", async () => {
    const { store } = await setup();
    const staged = await store.stage(inspection());
    expect((await store.inventory()).find((item) => item.kind === "staging")).toMatchObject({
      opaqueId: staged.transactionId,
      readable: true,
    });

    const target = await store.promote(staged);
    expect(await store.verifyVersion(target)).toBe(true);
    const permissions = await store.auditPermissions(target);
    expect(permissions).toEqual({
      rootMode: 0o700,
      stagingMode: 0o700,
      versionsMode: 0o700,
      quarantineMode: 0o700,
      metadataMode: 0o700,
      versionMode: 0o500,
      fileModes: [0o500, 0o400],
    });
  });

  it("keeps canonical verification stable when an archive contains explicit directory entries", async () => {
    const { store } = await setup();
    const target = await store.promote(await store.stage(inspection("1.0.0", "version one", true)));

    expect(await store.verifyVersion(target)).toBe(true);
  });

  it("loads only exact component text after re-verifying the immutable package", async () => {
    const { store } = await setup();
    const target = await store.promote(await store.stage(instructionInspection()));

    await expect(store.readVerifiedComponentText(target, "review")).resolves.toBe(
      "Use the verified review instructions.",
    );
    await expect(store.readVerifiedComponentText(target, "missing")).rejects.toMatchObject({
      category: "invalid",
    });
  });

  it("never overwrites an immutable version and retains earlier verified versions", async () => {
    const { store } = await setup();
    const first = await store.promote(await store.stage(inspection("1.0.0", "first")));
    const second = await store.promote(await store.stage(inspection("2.0.0", "second")));

    expect(await store.verifyVersion(first)).toBe(true);
    expect(await store.verifyVersion(second)).toBe(true);
    await expect(
      store.promote(await store.stage(inspection("1.0.0", "first"))),
    ).rejects.toBeInstanceOf(ExtensionPackageStoreError);
    expect((await store.inventory()).filter((item) => item.kind === "version")).toHaveLength(2);
  });

  it("detects tampering, quarantines corrupt versions, and removes only explicit versions", async () => {
    const { store, dataDirectory } = await setup();
    const first = await store.promote(await store.stage(inspection("1.0.0", "first")));
    const second = await store.promote(await store.stage(inspection("2.0.0", "second")));
    const contentPath = join(
      dataDirectory,
      "extensions",
      "versions",
      second.extensionId,
      second.packageId,
      `${second.version}--${second.digest.slice("sha256:".length)}`,
      "content",
      "runtime",
      "main.mjs",
    );
    await chmod(contentPath, 0o600);
    await writeFile(contentPath, "tampered");

    expect(await store.verifyVersion(first)).toBe(true);
    expect(await store.verifyVersion(second)).toBe(false);
    await store.quarantineVersion(second, "integrity-mismatch");
    expect((await store.inventory()).some((item) => item.kind === "quarantine")).toBe(true);
    expect(await store.verifyVersion(first)).toBe(true);

    await store.removeVersion(first);
    expect((await store.inventory()).filter((item) => item.kind === "version")).toHaveLength(0);
  });

  it("quarantines interrupted staging without making a version visible", async () => {
    const { store } = await setup();
    const staged = await store.stage(inspection());
    await store.quarantineStage(staged.transactionId, "interrupted");

    const inventory = await store.inventory();
    expect(inventory.filter((item) => item.kind === "version")).toHaveLength(0);
    expect(inventory.filter((item) => item.kind === "staging")).toHaveLength(0);
    expect(inventory.filter((item) => item.kind === "quarantine")).toHaveLength(1);
  });

  it.each([
    { kind: "bun", path: "/opt/octant/bin/bun" },
    { kind: "electron-node", path: "/Applications/Octant.app/Contents/MacOS/Octant" },
  ] as const)(
    "runs an outside driver's entry only on the host's $kind runtime, in its package root, with nothing else",
    async (runtime) => {
      const { store } = await setup({ outsideDriverRuntime: runtime });
      const target = await store.promote(await store.stage(driverInspection()));
      const contentRoot = store.contentRoot(target);
      const entryPoint = join(contentRoot, "driver", "main.mjs");
      const launch = {
        ...target,
        componentId: "driver",
        entryPoint,
        command: runtime.path,
        args: [entryPoint],
        cwd: contentRoot,
        sandbox: {
          kind: "outside-driver" as const,
          runtime: runtime.kind,
          instanceId: "instance-a",
          packageRoot: contentRoot,
          temporaryDirectory: join(tmpdir(), "octant-driver-instance-a"),
        },
      };
      const other =
        runtime.kind === "bun"
          ? ({
              kind: "electron-node",
              path: "/Applications/Octant.app/Contents/MacOS/Octant",
            } as const)
          : ({ kind: "bun", path: "/opt/octant/bin/bun" } as const);

      await expect(store.authorizeRuntimeLaunch(launch)).resolves.toBe(true);
      for (const refused of [
        { ...launch, command: entryPoint },
        { ...launch, command: "/usr/bin/env" },
        { ...launch, command: other.path },
        // The process port sets the environment by the runtime the launch
        // names, so a launch must name the host's own.
        { ...launch, sandbox: { ...launch.sandbox, runtime: other.kind } },
        { ...launch, args: [entryPoint, "--inspect"] },
        { ...launch, args: ["-e", "process.exit()"] },
        { ...launch, cwd: join(contentRoot, "driver") },
        { ...launch, cwd: store.pluginDataRoot() },
        { ...launch, entryPoint: "/tmp/attacker.mjs", args: ["/tmp/attacker.mjs"] },
        // Only the driver profile confines it, bound to this package's own root.
        { ...launch, sandbox: undefined },
        { ...launch, sandbox: { ...launch.sandbox, packageRoot: "/" } },
        {
          ...launch,
          sandbox: {
            kind: "macos-seatbelt" as const,
            scope: {
              hostId: "local",
              mode: "chat" as const,
              projectId: null,
              threadId: null,
              providerFamily: "claude",
            },
            allowRead: [],
            allowWrite: [],
            allowNetwork: true,
          },
        },
      ]) {
        await expect(store.authorizeRuntimeLaunch(refused)).resolves.toBe(false);
      }
    },
  );

  it("authorizes no outside driver launch on a server with no driver runtime", async () => {
    const runtime: OutsideDriverRuntime = { kind: "bun", path: "/opt/octant/bin/bun" };
    const { store: withoutRuntime } = await setup();
    const installed = await withoutRuntime.promote(await withoutRuntime.stage(driverInspection()));
    const root = withoutRuntime.contentRoot(installed);
    const entry = join(root, "driver", "main.mjs");
    await expect(
      withoutRuntime.authorizeRuntimeLaunch({
        ...installed,
        componentId: "driver",
        entryPoint: entry,
        command: runtime.path,
        args: [entry],
        cwd: root,
        sandbox: {
          kind: "outside-driver",
          runtime: runtime.kind,
          instanceId: "instance-a",
          packageRoot: root,
          temporaryDirectory: join(tmpdir(), "octant-driver-instance-a"),
        },
      }),
    ).resolves.toBe(false);
  });

  it("authorizes only the verified package-owned executable and content root", async () => {
    const { store, dataDirectory } = await setup();
    const installed = inspection();
    const target = await store.promote(await store.stage(installed));
    const versionDirectory = join(
      dataDirectory,
      "extensions",
      "versions",
      target.extensionId,
      target.packageId,
      `${target.version}--${target.digest.slice("sha256:".length)}`,
    );
    const contentRoot = join(versionDirectory, "content");
    const entryPoint = join(contentRoot, "runtime", "main.mjs");

    await expect(
      store.authorizeRuntimeLaunch({
        ...target,
        componentId: "server",
        entryPoint,
        command: entryPoint,
        cwd: contentRoot,
      }),
    ).resolves.toBe(true);
    await expect(
      store.authorizeRuntimeLaunch({
        ...target,
        componentId: "server",
        entryPoint: "/tmp/attacker.mjs",
        command: "/tmp/attacker.mjs",
        cwd: "/tmp",
      }),
    ).resolves.toBe(false);
  });

  it("authorizes contained plugin and data working directories for a package-owned executable", async () => {
    const { store, dataDirectory } = await setup();
    const target = await store.promote(await store.stage(inspection()));
    const contentRoot = join(
      dataDirectory,
      "extensions",
      "versions",
      target.extensionId,
      target.packageId,
      `${target.version}--${target.digest.slice("sha256:".length)}`,
      "content",
    );
    const entryPoint = join(contentRoot, "runtime", "main.mjs");

    const pluginData = join(store.pluginDataRoot(), `${target.extensionId}-${target.packageId}`);
    for (const cwd of [join(contentRoot, "subdir"), pluginData]) {
      await expect(
        store.authorizeRuntimeLaunch({
          ...target,
          componentId: "server",
          entryPoint,
          command: entryPoint,
          cwd,
        }),
      ).resolves.toBe(true);
    }
    await expect(
      store.authorizeRuntimeLaunch({
        ...target,
        componentId: "server",
        entryPoint,
        command: entryPoint,
        cwd: join(store.pluginDataRoot(), "another-plugin"),
      }),
    ).resolves.toBe(false);
  });

  it("rejects a declared entry point whose immutable receipt is not executable", async () => {
    const { store, dataDirectory } = await setup();
    const installed = inspection();
    const target = await store.promote(await store.stage(installed));
    const receiptPath = join(
      dataDirectory,
      "extensions",
      "versions",
      target.extensionId,
      target.packageId,
      `${target.version}--${target.digest.slice("sha256:".length)}`,
      "receipt.json",
    );
    await chmod(receiptPath, 0o600);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as {
      files: Array<{ path: string; executable: boolean }>;
    };
    receipt.files[0]!.executable = false;
    await writeFile(receiptPath, JSON.stringify(receipt));
    await chmod(receiptPath, 0o400);

    await expect(
      store.authorizeRuntimeLaunch({
        ...target,
        componentId: "server",
        entryPoint: join(
          dataDirectory,
          "extensions",
          "versions",
          target.extensionId,
          target.packageId,
          `${target.version}--${target.digest.slice("sha256:".length)}`,
          "content",
          "runtime",
          "main.mjs",
        ),
        command: join(
          dataDirectory,
          "extensions",
          "versions",
          target.extensionId,
          target.packageId,
          `${target.version}--${target.digest.slice("sha256:".length)}`,
          "content",
          "runtime",
          "main.mjs",
        ),
        cwd: join(
          dataDirectory,
          "extensions",
          "versions",
          target.extensionId,
          target.packageId,
          `${target.version}--${target.digest.slice("sha256:".length)}`,
          "content",
        ),
      }),
    ).resolves.toBe(false);
  });
});
