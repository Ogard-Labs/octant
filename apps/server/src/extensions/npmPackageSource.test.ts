import { generateKeyPairSync, createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionCommandResult, ExtensionSnapshot } from "@octant/contracts/extension-rpc";
import { signOutsideDriverPackage } from "@octant/provider-sdk/outside-driver-sign";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { rebuildProjection } from "../persistence/projection";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import {
  AGENT_PLUGIN_TEST_SCHEMA,
  buildGzipTar,
  demoSkill,
  type TarFixtureEntry,
} from "./agentPluginCatalogTestFixtures";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import { CodexPluginPackageResolver } from "./codexPluginResolver";
import {
  createLocalExtensionActivationPolicy,
  ExtensionActivationService,
} from "./extensionActivationService";
import { ExtensionApiService } from "./extensionApiService";
import { ExtensionLifecycleService, NOOP_EXTENSION_SUPERVISOR } from "./extensionLifecycleService";
import { ExtensionPackageStore } from "./extensionPackageStore";
import { NpmPackageSource } from "./npmPackageSource";
import type { NpmRegistryConfigSources } from "./npmRegistryConfig";

const now = "2026-10-31T12:00:00.000Z";
const directories: Array<string> = [];
const servers: Array<Server> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  await Promise.all(
    directories.splice(0).map(async (directory) => {
      await makeWritable(directory);
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

/** The package store keeps what it installs read-only, so make it removable first. */
async function makeWritable(directory: string): Promise<void> {
  await chmod(directory, 0o700).catch(() => undefined);
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) await makeWritable(join(directory, entry.name));
    else await chmod(join(directory, entry.name), 0o600).catch(() => undefined);
  }
}

interface FakeRelease {
  readonly version: string;
  readonly tarball: Uint8Array;
  /** Published integrity; `null` leaves it out. Defaults to the SHA-512 of `tarball`. */
  readonly integrity?: string | null;
  /** Published shasum, for a registry that offers nothing stronger. */
  readonly shasum?: string;
  /** Bytes actually served for the download when they differ from what was published. */
  readonly served?: Uint8Array;
  /** Where the metadata says to download from, instead of the registry's own address. */
  readonly tarballUrl?: string;
}

interface FakePackage {
  readonly releases: ReadonlyArray<FakeRelease>;
  readonly distTags?: Readonly<Record<string, string>>;
}

interface FakeRegistry {
  readonly url: string;
  readonly requests: Array<{ readonly path: string; readonly headers: IncomingHttpHeaders }>;
  publish(name: string, pack: FakePackage): void;
  /** Answers every request with this status, as a registry that needs a login would. */
  refuseWith(status: number): void;
}

/** A registry on a loopback port. No test reaches the real npm registry. */
async function startFakeRegistry(): Promise<FakeRegistry> {
  const packages = new Map<string, FakePackage>();
  const requests: FakeRegistry["requests"] = [];
  let refusal: number | undefined;
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://registry.test").pathname;
    requests.push({ path, headers: request.headers });
    if (refusal !== undefined) {
      response.writeHead(refusal).end();
      return;
    }
    const download = /^\/tarballs\/(.+)@([^@/]+)\.tgz$/.exec(decodeURIComponent(path));
    if (download !== null) {
      const release = packages
        .get(download[1] ?? "")
        ?.releases.find((candidate) => candidate.version === download[2]);
      if (release === undefined) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(Buffer.from(release.served ?? release.tarball));
      return;
    }
    const name = decodeURIComponent(path.slice(1));
    const pack = packages.get(name);
    if (pack === undefined) {
      response.writeHead(404).end();
      return;
    }
    const latest = pack.releases.at(-1)?.version;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        name,
        "dist-tags": pack.distTags ?? (latest === undefined ? {} : { latest }),
        versions: Object.fromEntries(
          pack.releases.map((release) => [
            release.version,
            {
              name,
              version: release.version,
              dist: {
                tarball:
                  release.tarballUrl ??
                  `${address()}/tarballs/${encodeURIComponent(`${name}@${release.version}`)}.tgz`,
                ...(release.integrity === null
                  ? {}
                  : {
                      integrity:
                        release.integrity ??
                        `sha512-${createHash("sha512").update(release.tarball).digest("base64")}`,
                    }),
                ...(release.shasum === undefined ? {} : { shasum: release.shasum }),
              },
            },
          ]),
        ),
      }),
    );
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: address(),
    requests,
    publish: (name, pack) => void packages.set(name, pack),
    refuseWith: (status) => {
      refusal = status;
    },
  };
}

function agentPluginTarball(
  name: string,
  version: string,
  extra: ReadonlyArray<TarFixtureEntry> = [],
): Uint8Array {
  return buildGzipTar([
    {
      path: "package/plugin.json",
      content: JSON.stringify({
        $schema: AGENT_PLUGIN_TEST_SCHEMA,
        name,
        version,
        description: "Demo Agent Plugin.",
        license: "MIT",
      }),
    },
    { path: "package/skills/demo", kind: "directory" },
    { path: "package/skills/demo/SKILL.md", content: demoSkill() },
    ...extra,
  ]);
}

const DRIVER_NPM_NAME = "@example/loopback-chat";

function driverDocument(version: string) {
  return {
    driverKind: "outside-harness-endpoint",
    protocolVersions: ["harness-endpoint/1"],
    manifest: {
      manifestVersion: 1,
      slug: "loopback-chat",
      displayName: "Loopback chat",
      version,
      provenance: {
        publisher: "Example Author",
        canonicalUrl: "https://example.test/loopback-chat",
      },
      license: { kind: "spdx", identifier: "MIT" },
      compatibility: {
        platforms: ["macos"],
        modes: ["chat", "work", "code"],
        providerFamilies: [],
      },
      declaredCapabilities: [],
      primaryComponentId: "driver",
      components: [
        {
          id: "driver",
          kind: "provider-driver",
          displayName: "Loopback chat",
          declaredCapabilities: [],
          entryPoint: "dist/driver.mjs",
        },
      ],
    },
  };
}

/**
 * A provider driver as `npm pack` would carry it: a folder written to disk,
 * signed by a throwaway key under the name given, then packed under `package/`.
 */
async function driverTarball(
  version: string,
  options: {
    readonly signedAs?: string | "unsigned";
    readonly packageJson?: Record<string, unknown>;
  } = {},
): Promise<Uint8Array> {
  const root = await mkdtemp(join(tmpdir(), "octant-npm-driver-"));
  directories.push(root);
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(
    join(root, "octant-provider-driver.json"),
    JSON.stringify(driverDocument(version)),
  );
  await writeFile(join(root, "dist/driver.mjs"), "export default {};\n");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: DRIVER_NPM_NAME, version, ...options.packageJson }),
  );
  if (options.signedAs !== "unsigned") {
    await signOutsideDriverPackage({
      root,
      privateKeyPem: generateKeyPairSync("ed25519")
        .privateKey.export({ format: "pem", type: "pkcs8" })
        .toString(),
      name: options.signedAs ?? DRIVER_NPM_NAME,
    });
  }
  const entries: Array<TarFixtureEntry> = [];
  const visit = async (directory: string): Promise<void> => {
    for (const child of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, child.name);
      if (child.isDirectory()) await visit(absolute);
      else {
        entries.push({
          path: `package/${relative(root, absolute).split(sep).join("/")}`,
          content: await readFile(absolute),
          mode: (await stat(absolute)).mode & 0o777,
        });
      }
    }
  };
  await visit(root);
  return buildGzipTar(entries);
}

async function setup(options: { readonly fetchesAllowed?: () => boolean } = {}) {
  const registry = await startFakeRegistry();
  const dataDirectory = await mkdtemp(join(tmpdir(), "octant-npm-source-host-"));
  directories.push(dataDirectory);
  const connection = openSqlite(join(dataDirectory, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
  const store = new ExtensionPackageStore({ dataDirectory, uuid: randomUUID });
  await store.initialize();
  const lifecycle = new ExtensionLifecycleService({
    connection,
    journal,
    store,
    supervisor: NOOP_EXTENSION_SUPERVISOR,
    uuid: randomUUID,
    clock: () => now,
  });
  // The person's npm settings, as the next lookup will read them.
  let config: NpmRegistryConfigSources = { env: { npm_config_registry: registry.url } };
  const source = new NpmPackageSource({
    appVersion: "1.0.0",
    platform: "darwin",
    ...(options.fetchesAllowed === undefined
      ? {}
      : { isMarketplaceFetchAllowed: options.fetchesAllowed }),
    readRegistryConfig: async () => config,
  });
  const api = new ExtensionApiService({
    lifecycle,
    resolver: new CodexPluginPackageResolver({ platform: "darwin" }),
    npmSource: source,
    activation: new ExtensionActivationService({
      policy: createLocalExtensionActivationPolicy(
        {
          project: (scope) => ({ allowed: scope.projectId === null, revision: 0 }),
          thread: (scope) => ({ allowed: scope.threadId === null, revision: 0 }),
        },
        "darwin",
      ),
      catalogStatus: () => "available",
    }),
  });
  const resolve = (packageName: string, range?: string, updateOf?: string) =>
    api.execute({
      kind: "resolve-npm-package",
      packageName,
      ...(range === undefined ? {} : { range }),
      ...(updateOf === undefined ? {} : { updateOf: updateOf as never }),
    });
  const useConfig = (next: NpmRegistryConfigSources) => {
    config = next;
  };
  const install = async (result: ExtensionCommandResult) => {
    if (result.kind !== "package-inspected") throw new Error("expected an inspected package");
    const { entry } = result.preview;
    return api.execute({
      kind: "install-package",
      extensionId: entry.extensionId,
      packageId: entry.packageId,
      version: entry.version,
      digest: entry.digest,
    });
  };
  const packages = (): ExtensionSnapshot["packages"] => lifecycle.snapshot().packages;
  return {
    registry,
    connection,
    runtime,
    journal,
    lifecycle,
    source,
    api,
    resolve,
    useConfig,
    install,
    packages,
  };
}

function failureOf(result: ExtensionCommandResult) {
  return result.kind === "extension-command-failed" ? result.failure : undefined;
}

describe("installing a plugin from an npm registry", () => {
  it("downloads the tarball, records its package, version and integrity, and waits in quarantine", async () => {
    const context = await setup();
    const tarball = agentPluginTarball("demo-plugin", "1.0.0");
    context.registry.publish("demo-plugin", { releases: [{ version: "1.0.0", tarball }] });
    const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;

    const resolved = await context.resolve("demo-plugin");

    expect(resolved.kind).toBe("package-inspected");
    if (resolved.kind !== "package-inspected") return;
    expect(resolved.preview.review.provenance.npm).toEqual({
      packageName: "demo-plugin",
      version: "1.0.0",
      registry: context.registry.url,
      integrity,
    });
    // Looking a package up installs nothing.
    expect(context.packages()).toEqual([]);

    const installed = await context.install(resolved);
    expect(installed.kind).toBe("extension-state-updated");
    const [pack] = context.packages();
    expect(pack?.npm).toEqual(resolved.preview.review.provenance.npm);
    // Installed is not trusted, switched on, or active.
    expect(pack?.activation).toMatchObject({ installed: true, trusted: false });
    expect(pack?.components.map((component) => component.effectiveState.kind)).toEqual(["blocked"]);

    // The record is in the journal: replaying it restores the same source.
    const projection = context.runtime.projections.get("extensions");
    if (projection === undefined) throw new Error("expected the extension projection");
    rebuildProjection({
      connection: context.connection,
      journal: context.journal,
      projection,
      clock: () => now,
    });
    expect(context.packages()[0]?.npm).toEqual(pack?.npm);
  });

  it("keeps an installed npm package in the scoped effective state, blocked until it is trusted", async () => {
    const context = await setup();
    context.registry.publish("demo-plugin", {
      releases: [{ version: "1.0.0", tarball: agentPluginTarball("demo-plugin", "1.0.0") }],
    });
    await context.install(await context.resolve("demo-plugin"));

    const effective = await context.api.execute({
      kind: "query-effective-state",
      commandVersion: 1 as never,
      scope: {
        hostId: LOCAL_HOST_ID,
        mode: "chat",
        projectId: null,
        threadId: null,
        providerFamily: "openai-compatible" as never,
      },
    });

    expect(effective.kind).toBe("extension-effective-state");
    if (effective.kind !== "extension-effective-state") return;
    expect(effective.snapshot.packages).toHaveLength(1);
    expect(
      effective.snapshot.packages[0]?.components.map((component) => component.effectiveState.kind),
    ).toEqual(["blocked"]);
  });

  it("sends no login and no cookie to the registry", async () => {
    const context = await setup();
    context.registry.publish("demo-plugin", {
      releases: [{ version: "1.0.0", tarball: agentPluginTarball("demo-plugin", "1.0.0") }],
    });

    await context.resolve("demo-plugin");

    expect(context.registry.requests.length).toBeGreaterThanOrEqual(2);
    for (const request of context.registry.requests) {
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers.cookie).toBeUndefined();
    }
  });

  it("refuses a download whose bytes do not match the integrity the registry published", async () => {
    const context = await setup();
    const tarball = agentPluginTarball("demo-plugin", "1.0.0");
    context.registry.publish("demo-plugin", {
      releases: [
        {
          version: "1.0.0",
          tarball,
          served: agentPluginTarball("demo-plugin", "1.0.0", [
            { path: "package/extra.txt", content: "tampered" },
          ]),
        },
      ],
    });

    const result = await context.resolve("demo-plugin");

    expect(failureOf(result)).toEqual({
      category: "invalid",
      message:
        "The download does not match the integrity the registry published. Octant discarded it and installed nothing.",
    });
    expect(context.packages()).toEqual([]);
  });

  it.each([
    ["no integrity at all", { integrity: null }],
    ["only a SHA-1 checksum", { integrity: null, shasum: "a".repeat(40) }],
    ["only a SHA-1 integrity", { integrity: `sha1-${Buffer.alloc(20).toString("base64")}` }],
  ] as const)("refuses a version the registry publishes with %s", async (_label, release) => {
    const context = await setup();
    context.registry.publish("demo-plugin", {
      releases: [
        { version: "1.0.0", tarball: agentPluginTarball("demo-plugin", "1.0.0"), ...release },
      ],
    });

    const result = await context.resolve("demo-plugin");

    expect(failureOf(result)?.message).toBe(
      "The registry published no SHA-256, SHA-384 or SHA-512 integrity for that version, so Octant cannot check the download.",
    );
    expect(context.registry.requests.map((request) => request.path)).toEqual(["/demo-plugin"]);
  });

  it("refuses a download address outside the registry's own", async () => {
    const context = await setup();
    context.registry.publish("demo-plugin", {
      releases: [
        {
          version: "1.0.0",
          tarball: agentPluginTarball("demo-plugin", "1.0.0"),
          tarballUrl: "http://127.0.0.1:9/demo-plugin.tgz",
        },
      ],
    });

    const result = await context.resolve("demo-plugin");

    expect(failureOf(result)?.message).toBe(
      "The registry pointed at a download outside its own address. Octant did not fetch it.",
    );
    expect(context.registry.requests.map((request) => request.path)).toEqual(["/demo-plugin"]);
  });

  it("never runs an install script from the package", async () => {
    const context = await setup();
    const directory = await mkdtemp(join(tmpdir(), "octant-npm-marker-"));
    directories.push(directory);
    const marker = join(directory, "ran");
    const script = `node -e "require('node:fs').writeFileSync('${marker}','ran')"`;
    context.registry.publish("scripted-plugin", {
      releases: [
        {
          version: "1.0.0",
          tarball: agentPluginTarball("scripted-plugin", "1.0.0", [
            {
              path: "package/package.json",
              content: JSON.stringify({
                name: "scripted-plugin",
                version: "1.0.0",
                scripts: {
                  preinstall: script,
                  install: script,
                  postinstall: script,
                  prepare: script,
                },
              }),
            },
          ]),
        },
      ],
    });

    const resolved = await context.resolve("scripted-plugin");
    const installed = await context.install(resolved);

    expect(installed.kind).toBe("extension-state-updated");
    await expect(access(marker)).rejects.toThrow();
  });

  it("refuses a package that holds neither an Agent Plugin nor a provider driver description", async () => {
    const context = await setup();
    context.registry.publish("plain-library", {
      releases: [
        {
          version: "1.0.0",
          tarball: buildGzipTar([
            { path: "package/package.json", content: '{"name":"plain-library","version":"1.0.0"}' },
            { path: "package/index.js", content: "module.exports = {};\n" },
          ]),
        },
      ],
    });
    context.registry.publish("wrong-schema", {
      releases: [
        {
          version: "1.0.0",
          tarball: buildGzipTar([
            {
              path: "package/plugin.json",
              content: JSON.stringify({ name: "wrong-schema", version: "1.0.0" }),
            },
          ]),
        },
      ],
    });

    for (const name of ["plain-library", "wrong-schema"]) {
      const result = await context.resolve(name);
      expect(failureOf(result)).toEqual({
        category: "invalid",
        message:
          "This npm package is not one Octant can install: it has neither an Agent Plugin description nor a provider driver description.",
      });
    }
    expect(context.packages()).toEqual([]);
  });

  it("refuses an archive with a link in it", async () => {
    const context = await setup();
    context.registry.publish("linked-plugin", {
      releases: [
        {
          version: "1.0.0",
          tarball: agentPluginTarball("linked-plugin", "1.0.0", [
            { path: "package/escape", kind: "symlink", linkTarget: "../../etc/passwd" },
          ]),
        },
      ],
    });

    const result = await context.resolve("linked-plugin");

    expect(failureOf(result)?.message).toBe(
      "The download is not a package archive Octant can read. Links, special files and unsafe paths are refused.",
    );
  });

  it("says plainly when the package, the version, the registry, or the network is missing", async () => {
    const context = await setup();
    context.registry.publish("demo-plugin", {
      releases: [{ version: "1.0.0", tarball: agentPluginTarball("demo-plugin", "1.0.0") }],
    });

    expect(failureOf(await context.resolve("absent-plugin"))).toEqual({
      category: "unavailable",
      message: "The npm registry has no package with that name.",
    });
    expect(failureOf(await context.resolve("demo-plugin", "^2.0.0"))?.message).toBe(
      "The registry has no published version of that package that matches.",
    );
    expect(failureOf(await context.resolve("Not A Name"))?.message).toBe(
      "That is not an npm package name. Use a lowercase name, with its @scope before a slash when it has one.",
    );
    expect(failureOf(await context.resolve("demo-plugin", "^^1"))?.message).toContain(
      "could not read that version",
    );
    context.registry.refuseWith(401);
    expect(failureOf(await context.resolve("demo-plugin"))?.message).toBe(
      "The npm registry refused the request. Octant sends no login, so a registry that needs one cannot be used.",
    );

    const unreachable = new NpmPackageSource({
      appVersion: "1.0.0",
      platform: "darwin",
      readRegistryConfig: async () => ({ env: { npm_config_registry: "http://127.0.0.1:1" } }),
    });
    expect(await unreachable.resolve({ packageName: "demo-plugin" })).toEqual({
      status: "refused",
      reason: "network-refused",
    });
  });

  it("fetches nothing while marketplace fetches are turned off", async () => {
    const context = await setup({ fetchesAllowed: () => false });
    context.registry.publish("demo-plugin", {
      releases: [{ version: "1.0.0", tarball: agentPluginTarball("demo-plugin", "1.0.0") }],
    });

    const result = await context.resolve("demo-plugin");

    expect(failureOf(result)).toEqual({
      category: "blocked",
      message: "Marketplace fetches are turned off in Settings.",
    });
    expect(context.registry.requests).toEqual([]);
  });

  it("picks the newest version a range allows, an exact version, or a tag", async () => {
    const context = await setup();
    context.registry.publish("demo-plugin", {
      distTags: { latest: "2.0.0", beta: "1.5.0" },
      releases: ["1.0.0", "1.2.0", "1.5.0", "2.0.0"].map((version) => ({
        version,
        tarball: agentPluginTarball("demo-plugin", version),
      })),
    });
    const versionFor = async (range?: string) => {
      const result = await context.resolve("demo-plugin", range);
      return result.kind === "package-inspected" ? result.preview.entry.version : result;
    };

    expect(await versionFor()).toBe("2.0.0");
    expect(await versionFor("^1.0.0")).toBe("1.5.0");
    expect(await versionFor("~1.0")).toBe("1.0.0");
    expect(await versionFor("1.2.0")).toBe("1.2.0");
    expect(await versionFor("beta")).toBe("1.5.0");
  });

  it("offers a newer version without installing it, and updates only when asked", async () => {
    const context = await setup();
    context.registry.publish("demo-plugin", {
      releases: [{ version: "1.0.0", tarball: agentPluginTarball("demo-plugin", "1.0.0") }],
    });
    const first = await context.resolve("demo-plugin");
    await context.install(first);
    const extensionId = context.packages()[0]?.extensionId;
    if (extensionId === undefined) throw new Error("expected an installed package");

    expect(await context.api.execute({ kind: "check-npm-update", extensionId })).toMatchObject({
      kind: "npm-update-checked",
      installedVersion: "1.0.0",
    });
    const unchanged = await context.api.execute({ kind: "check-npm-update", extensionId });
    expect(unchanged.kind === "npm-update-checked" && unchanged.available).toBeFalsy();

    context.registry.publish("demo-plugin", {
      releases: [
        { version: "1.0.0", tarball: agentPluginTarball("demo-plugin", "1.0.0") },
        { version: "1.1.0", tarball: agentPluginTarball("demo-plugin", "1.1.0") },
      ],
    });
    const checked = await context.api.execute({ kind: "check-npm-update", extensionId });
    expect(checked).toMatchObject({ kind: "npm-update-checked", available: "1.1.0" });
    // Checking is not installing.
    expect(context.packages()[0]?.version).toBe("1.0.0");
    expect(context.packages()[0]?.npm?.version).toBe("1.0.0");

    const next = await context.resolve("demo-plugin", "1.1.0");
    if (next.kind !== "package-inspected") throw new Error("expected an inspected package");
    expect(next.preview.entry.extensionId).toBe(extensionId);
    const updated = await context.api.execute({
      kind: "update-package",
      extensionId,
      packageId: next.preview.entry.packageId,
      version: next.preview.entry.version,
      digest: next.preview.entry.digest,
    });
    expect(updated.kind).toBe("extension-state-updated");
    expect(context.packages()[0]?.npm?.version).toBe("1.1.0");
  });

  it("compares an update with the npm version that was installed, not the plugin's own version", async () => {
    const context = await setup();
    // The plugin says 0.5.0 inside; the registry's release that carries it is 1.0.0.
    const inner = (version: string) =>
      buildGzipTar([
        {
          path: "package/plugin.json",
          content: JSON.stringify({
            $schema: AGENT_PLUGIN_TEST_SCHEMA,
            name: "demo-plugin",
            version: "0.5.0",
            description: "Demo Agent Plugin.",
            license: "MIT",
          }),
        },
        { path: "package/skills/demo", kind: "directory" },
        { path: "package/skills/demo/SKILL.md", content: `${demoSkill()}${version}\n` },
      ]);
    context.registry.publish("demo-plugin", {
      releases: [{ version: "1.0.0", tarball: inner("1.0.0") }],
    });
    await context.install(await context.resolve("demo-plugin"));
    const extensionId = context.packages()[0]?.extensionId;
    if (extensionId === undefined) throw new Error("expected an installed package");

    // The newest release is the one installed: nothing to offer, though 1.0.0 > 0.5.0.
    expect(await context.api.execute({ kind: "check-npm-update", extensionId })).toEqual({
      kind: "npm-update-checked",
      extensionId,
      installedVersion: "1.0.0",
    });

    // A release newer than the installed one is offered though the plugin says it is older.
    context.registry.publish("demo-plugin", {
      releases: [
        { version: "1.0.0", tarball: inner("1.0.0") },
        { version: "1.0.1", tarball: inner("1.0.1") },
      ],
    });
    expect(await context.api.execute({ kind: "check-npm-update", extensionId })).toEqual({
      kind: "npm-update-checked",
      extensionId,
      installedVersion: "1.0.0",
      available: "1.0.1",
    });
  });

  it("resolves an update from the registry the package was installed from, not the current settings", async () => {
    const context = await setup();
    const other = await startFakeRegistry();
    context.registry.publish("demo-plugin", {
      releases: [
        { version: "1.0.0", tarball: agentPluginTarball("demo-plugin", "1.0.0") },
        { version: "1.1.0", tarball: agentPluginTarball("demo-plugin", "1.1.0") },
      ],
    });
    other.publish("demo-plugin", {
      releases: [{ version: "9.9.9", tarball: agentPluginTarball("demo-plugin", "9.9.9") }],
    });
    const first = await context.resolve("demo-plugin", "1.0.0");
    await context.install(first);
    const installed = context.packages()[0];
    if (installed === undefined) throw new Error("expected an installed package");

    // The person's npm settings now name another registry.
    context.useConfig({ env: { npm_config_registry: other.url } });
    const registryRequestsBefore = context.registry.requests.length;
    const next = await context.resolve("demo-plugin", "1.1.0", installed.extensionId);

    expect(other.requests).toEqual([]);
    expect(context.registry.requests.length).toBeGreaterThan(registryRequestsBefore);
    if (next.kind !== "package-inspected") throw new Error("expected an inspected package");
    expect(next.preview.entry.extensionId).toBe(installed.extensionId);
    expect(next.preview.review.provenance.npm?.registry).toBe(context.registry.url);
    const updated = await context.api.execute({
      kind: "update-package",
      extensionId: installed.extensionId,
      packageId: next.preview.entry.packageId,
      version: next.preview.entry.version,
      digest: next.preview.entry.digest,
    });
    expect(updated.kind).toBe("extension-state-updated");
    expect(context.packages()).toHaveLength(1);
    expect(context.packages()[0]?.npm?.version).toBe("1.1.0");

    // Without the installed package named, the same words follow the new settings
    // and give a different package, which is why an update must name its target.
    const elsewhere = await context.resolve("demo-plugin");
    if (elsewhere.kind !== "package-inspected") throw new Error("expected an inspected package");
    expect(elsewhere.preview.entry.extensionId).not.toBe(installed.extensionId);
  });

  it("refuses to resolve an update for a package that is not the one installed from npm", async () => {
    const context = await setup();
    context.registry.publish("demo-plugin", {
      releases: [{ version: "1.0.0", tarball: agentPluginTarball("demo-plugin", "1.0.0") }],
    });
    context.registry.publish("other-plugin", {
      releases: [{ version: "1.0.0", tarball: agentPluginTarball("other-plugin", "1.0.0") }],
    });
    await context.install(await context.resolve("demo-plugin"));
    const installed = context.packages()[0];
    if (installed === undefined) throw new Error("expected an installed package");
    const before = context.registry.requests.length;

    expect(
      failureOf(await context.resolve("other-plugin", undefined, installed.extensionId)),
    ).toEqual({
      category: "invalid",
      message: "That is not the package this plugin came from.",
    });
    expect(failureOf(await context.resolve("demo-plugin", undefined, randomUUID()))).toEqual({
      category: "invalid",
      message: "This package did not come from an npm registry.",
    });
    expect(context.registry.requests.length).toBe(before);
  });

  it("refuses a lookup, before any request, when the person's npm settings cannot be read", async () => {
    const context = await setup();
    context.registry.publish("private-plugin", {
      releases: [{ version: "1.0.0", tarball: agentPluginTarball("private-plugin", "1.0.0") }],
    });
    context.useConfig({ env: {}, userConfigUnreadable: true });

    const result = await context.resolve("private-plugin");

    expect(failureOf(result)).toEqual({
      category: "invalid",
      message:
        "Octant could not read the registry address from your npm configuration, so it fetched nothing rather than guess. An address that uses an environment variable is not read, and neither is a configuration file Octant cannot open.",
    });
    expect(context.registry.requests).toEqual([]);
  });

  it("answers a check on a package that did not come from npm", async () => {
    const context = await setup();
    const result = await context.api.execute({
      kind: "check-npm-update",
      extensionId: randomUUID() as never,
    });
    expect(failureOf(result)?.message).toBe("This package did not come from an npm registry.");
  });
});

describe("installing a provider driver from an npm registry", () => {
  it("accepts a driver signed under its npm name and holds it until it is trusted", async () => {
    const context = await setup();
    context.registry.publish(DRIVER_NPM_NAME, {
      releases: [{ version: "0.1.0", tarball: await driverTarball("0.1.0") }],
    });

    const resolved = await context.resolve(DRIVER_NPM_NAME);

    expect(failureOf(resolved)).toBeUndefined();
    expect(resolved.kind).toBe("package-inspected");
    if (resolved.kind !== "package-inspected") return;
    expect(resolved.preview.review.provenance.npm?.packageName).toBe(DRIVER_NPM_NAME);
    expect(resolved.preview.review.provenance.publisherKey).toMatch(/^ed25519:[0-9a-f]{64}$/);
    await context.install(resolved);
    expect(context.packages()[0]?.activation).toMatchObject({
      installed: true,
      trusted: false,
      quarantined: true,
    });
  });

  it("refuses an unsigned driver", async () => {
    const context = await setup();
    context.registry.publish(DRIVER_NPM_NAME, {
      releases: [
        { version: "0.1.0", tarball: await driverTarball("0.1.0", { signedAs: "unsigned" }) },
      ],
    });

    expect(failureOf(await context.resolve(DRIVER_NPM_NAME))?.message).toBe(
      "This provider driver is not signed by its publisher; Octant installs a provider driver from this source only when it is.",
    );
  });

  it("refuses a driver whose signature names another package", async () => {
    const context = await setup();
    context.registry.publish(DRIVER_NPM_NAME, {
      releases: [
        { version: "0.1.0", tarball: await driverTarball("0.1.0", { signedAs: "loopback-chat" }) },
      ],
    });

    expect(failureOf(await context.resolve(DRIVER_NPM_NAME))?.message).toBe(
      "This provider driver's signature does not match its files, name, or version, or does not verify.",
    );
  });

  it("refuses a driver that declares an install script", async () => {
    const context = await setup();
    context.registry.publish(DRIVER_NPM_NAME, {
      releases: [
        {
          version: "0.1.0",
          tarball: await driverTarball("0.1.0", {
            packageJson: { scripts: { postinstall: "node setup.js" } },
          }),
        },
      ],
    });

    expect(failureOf(await context.resolve(DRIVER_NPM_NAME))?.message).toBe(
      "This provider driver has an install script; Octant runs no install step for a provider driver.",
    );
  });

  it("refuses a driver whose declared version is not the npm version that carries it", async () => {
    const context = await setup();
    context.registry.publish(DRIVER_NPM_NAME, {
      releases: [{ version: "0.2.0", tarball: await driverTarball("0.1.0") }],
    });

    expect(failureOf(await context.resolve(DRIVER_NPM_NAME))?.message).toBe(
      "This provider driver declares a different version from the npm version that carries it.",
    );
  });

  it("refuses a driver that ships a program, whatever its tar mode says", async () => {
    const context = await setup();
    const signedTarball = await driverTarball("0.1.0");
    // Re-pack the same signed files with an execute bit on the entry module.
    const entries: Array<TarFixtureEntry> = [];
    const { extractAgentPluginEntriesFromTarball } = await import("./npmAgentPluginMarketplace");
    for (const entry of extractAgentPluginEntriesFromTarball(signedTarball)) {
      if (entry.kind !== "file") continue;
      entries.push({
        path: `package/${entry.path}`,
        content: entry.content ?? "",
        mode: entry.path === "dist/driver.mjs" ? 0o755 : 0o644,
      });
    }
    context.registry.publish(DRIVER_NPM_NAME, {
      releases: [{ version: "0.1.0", tarball: buildGzipTar(entries) }],
    });

    expect(failureOf(await context.resolve(DRIVER_NPM_NAME))?.message).toBe(
      "This provider driver ships a program; a provider driver is JavaScript modules and data only.",
    );
  });
});
