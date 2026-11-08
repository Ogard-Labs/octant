import { Effect, Schema } from "effect";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:net";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { decodeWindowId } from "@octant/contracts";
import { createRemoteConnection } from "../packages/client-runtime/src/remoteConnection";
import {
  Persistence,
  makePersistenceLive,
} from "../apps/server/src/persistence/persistenceService";
import { ShellService } from "../apps/server/src/shellService";
import { PairingDeviceLifecycleService } from "../apps/server/src/remote/pairingDeviceLifecycleService";
import { createPrivateListenerSetting } from "../apps/server/src/remote/privateListenerSetting";
import { resolvePrivateListenerHostIdentity } from "../apps/server/src/remote/privateListenerHostIdentity";
import { realpath } from "node:fs/promises";
import {
  CanvasPublicSharePublished,
  CanvasPublicShareRecordUpdated,
} from "@octant/contracts/canvas-public-share";
import { CanvasExportRecorded } from "@octant/contracts/canvas-export";
import { deriveHostRuntimeHostId } from "../packages/host-runtime/src/paths";
import {
  makeKeychainCredentialStore,
  makeKeychainCredentialPurgeStore,
} from "../apps/desktop/src/keychainCredentialStore";
import { startShareService } from "../apps/share/src/server";
import { readShareConfig } from "../apps/share/src/config";
import { openReadOnlySqlite } from "../apps/server/src/persistence/sqlitePort";
import { createQuitAppleScript } from "./package-desktop";
import {
  cleanupPackagedProcess,
  runBoundedCommand,
  sanitizedPackagedEnvironment,
  spawnPackagedApplication,
  stagePackagedAppBundle,
  waitForProcessCleanup,
} from "./packaged-smoke-process";

const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const PackageProvenance = Schema.Struct({
  version: Schema.Literal(1),
  productionBase: Schema.String,
  builderInputs: Schema.String,
  image: Schema.String,
  architecture: Schema.String,
  bun: Schema.String,
  electron: Schema.String,
  productionMatchesBase: Schema.Boolean,
  producerHead: Schema.String,
  checksum: Schema.String,
});

async function freePort(hostname = "127.0.0.1"): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, hostname, resolve);
  });
  const address = listener.address();
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error === undefined ? resolve() : reject(error))),
  );
  if (address === null || typeof address === "string") throw Error("No fixture port.");
  return address.port;
}

async function exited(child: ChildProcess, milliseconds: number): Promise<boolean> {
  const until = Date.now() + milliseconds;
  while (child.exitCode === null && child.signalCode === null && Date.now() < until)
    await pause(50);
  return child.exitCode !== null || child.signalCode !== null;
}

function groupProcesses(group: number): ReadonlyArray<number> {
  return execFileSync("/bin/ps", ["-axo", "pid=,pgid="], {
    encoding: "utf8",
    timeout: 3000,
  })
    .trim()
    .split("\n")
    .flatMap((line) => {
      const [pid, pgid] = line.trim().split(/\s+/).map(Number);
      return pid !== undefined && pgid === group ? [pid] : [];
    });
}

// API-seeded pairing is fixture setup, never evidence of native pairing UI.
// The production packaged gateway still verifies host identity, pinned TLS,
// session challenge and a fresh signed proof for every product request.
async function seedPairedFixture(dataDirectory: string, projectId: string, signal: AbortSignal) {
  const hostname = Object.values(networkInterfaces())
    .flat()
    .find((entry) => {
      if (entry === undefined || entry.internal || entry.family !== "IPv4") return false;
      const octets = entry.address.split(".").map(Number);
      return (
        octets[0] === 10 ||
        (octets[0] === 192 && octets[1] === 168) ||
        (octets[0] === 172 && octets[1] !== undefined && octets[1] >= 16 && octets[1] <= 31)
      );
    })?.address;
  if (hostname === undefined) throw Error("No isolated-runner RFC1918 interface for real pairing.");
  const port = await freePort(hostname);
  const origin = `https://${hostname}:${port}`;
  const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicKeyPem = String(keys.publicKey.export({ format: "pem", type: "spki" }));
  const fingerprint = createHash("sha256")
    .update(keys.publicKey.export({ format: "der", type: "spki" }))
    .digest("hex");
  const knownDevice = await Effect.runPromise(
    Effect.flatMap(Persistence, (persistence) =>
      Effect.sync(() => {
        const identity = resolvePrivateListenerHostIdentity({
          connection: persistence.connection,
          dataDirectory,
        });
        const lifecycle = new PairingDeviceLifecycleService({
          hostId: identity.hostId,
          journal: persistence.journal,
          connection: persistence.connection,
        });
        const device = lifecycle.admitIntroducedDevice({
          devicePublicKey: publicKeyPem,
          deviceLabel: "Owned Canvas acceptance client",
          origin,
          sourceClass: "lan-private",
        });
        const shell = new ShellService({
          persistence,
          uuid: randomUUID,
          clock: () => new Date().toISOString(),
        });
        const windowId = decodeWindowId(String(device.deviceId));
        shell.bootstrap(windowId);
        shell.execute({
          kind: "apply-workspace-operation",
          windowId,
          expectedVersion: 0,
          operation: {
            kind: "switch-project-surface",
            mode: "chat",
            surface: {
              kind: "project",
              id: randomUUID(),
              projectId,
              mode: "chat",
              title: "Canvas fixtures",
            },
          },
        });
        return {
          hostId: String(device.hostId),
          deviceId: String(device.deviceId),
          credentialGeneration: device.credentialGeneration,
          hostKeyFingerprint: identity.signing.hostKeyFingerprint,
        };
      }),
    ).pipe(
      Effect.provide(makePersistenceLive({ environment: { OCTANT_DATA_DIR: dataDirectory } })),
    ),
  );
  createPrivateListenerSetting(dataDirectory).save({ hostname, port, origin, tls: "self-made" });
  const certificatePath = join(dataDirectory, "remote", "private-listener-tls-cert.pem");
  const pinnedFetch: typeof globalThis.fetch = Object.assign(
    async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1],
    ) => {
      const request = new Request(input, init);
      const destination = new URL(request.url);
      if (destination.origin !== origin)
        throw Error("The paired fixture requested another origin.");
      const certificate = await readFile(certificatePath);
      const body = Buffer.from(await request.arrayBuffer());
      return new Promise<Response>((resolve, reject) => {
        const connection = httpsRequest(
          destination,
          {
            method: request.method,
            headers: Object.fromEntries(request.headers),
            ca: certificate,
            rejectUnauthorized: true,
            servername: "",
            timeout: 8000,
            signal: AbortSignal.any([request.signal, signal]),
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.once("error", reject);
            response.once("aborted", () => reject(Error("The owned paired response was aborted.")));
            response.once("end", () => {
              const headers = new Headers();
              for (const [key, value] of Object.entries(response.headers)) {
                if (Array.isArray(value)) for (const item of value) headers.append(key, item);
                else if (value !== undefined) headers.set(key, value);
              }
              const bytes = Buffer.concat(chunks);
              resolve(
                new Response(bytes.length === 0 ? null : bytes, {
                  status: response.statusCode ?? 500,
                  headers,
                }),
              );
            });
          },
        );
        connection.once("timeout", () =>
          connection.destroy(Error("Owned paired request timed out.")),
        );
        connection.once("error", reject);
        connection.end(body.length === 0 ? undefined : body);
      });
    },
    { preconnect: () => undefined },
  );
  const connection = createRemoteConnection({
    origin,
    webBuildVersion: "0.1.0",
    fetch: pinnedFetch,
    knownDevice,
    deviceKey: {
      loadOrCreate: async () => ({ publicKeyPem, fingerprint }),
      current: async () => ({ publicKeyPem, fingerprint }),
      sign: async (payload) =>
        sign("sha256", Buffer.from(payload), {
          key: keys.privateKey,
          dsaEncoding: "ieee-p1363",
        }).toString("base64url"),
      clear: async () => undefined,
    },
  });
  return { connection, origin };
}

async function main(): Promise<void> {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw Error("Packaged native Canvas validation requires Apple Silicon macOS.");
  const nativeControllerPath = process.env.OCTANT_QA_NATIVE_CONTROLLER;
  if (nativeControllerPath === undefined) throw Error("Supply the built owned native controller.");
  await runBoundedCommand(nativeControllerPath, ["preflight"], process.env, 5000);
  const artifacts = resolve(process.env.OCTANT_QA_OUTPUT ?? "/tmp/octant-packaged-canvas-native");
  const root = await mkdtemp(join(tmpdir(), "octant-canvas-native."));
  let bundle: string | undefined;
  let app: ReturnType<typeof spawnPackagedApplication> | undefined;
  let watchdog: ChildProcess | undefined;
  let shareService: ReturnType<typeof startShareService> | undefined;
  let packageProvenance: typeof PackageProvenance.Type | undefined;
  let pairedFixture: Awaited<ReturnType<typeof seedPairedFixture>> | undefined;
  let fixtureDataDirectory: string | undefined;
  let scratchHostScope: string | undefined;
  let ownerSecretStore: ReturnType<typeof makeKeychainCredentialStore> | undefined;
  let publishedCredentialRef: string | undefined;
  let ownerSecretCleanupFailed = false;
  let ownerSecretCleanupVerified = false;
  const controller = new AbortController();
  const interrupted = () => controller.abort();
  process.once("SIGTERM", interrupted);
  process.once("SIGINT", interrupted);
  const timer = setTimeout(interrupted, 300_000);
  let verified = false;
  let cleanupVerified = false;
  let pid: number | undefined;
  let port: number | undefined;
  try {
    await mkdir(artifacts, { recursive: true });
    if (process.env.OCTANT_QA_CACHED_PACKAGE !== undefined) {
      packageProvenance = Schema.decodeUnknownSync(PackageProvenance)(
        JSON.parse(await readFile(resolve("out/native-package-provenance.json"), "utf8")),
      );
      await writeFile(
        join(artifacts, "package-provenance.json"),
        JSON.stringify(
          {
            ...packageProvenance,
            cachedPackage: process.env.OCTANT_QA_CACHED_PACKAGE === "true",
            testHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
          },
          null,
          2,
        ),
      );
    }
    await mkdir(join(root, "home"));
    await mkdir(join(root, "tmp"));
    port = await freePort();
    bundle = stagePackagedAppBundle(resolve("out/Octant.app"));
    const executable = join(bundle, "Contents/MacOS/Octant");
    const env = {
      ...sanitizedPackagedEnvironment(
        { HOME: join(root, "home"), TMPDIR: join(root, "tmp") },
        join(root, "data"),
      ),
      OCTANT_SERVER_PORT: String(port),
      ...(process.env.RUNNER_TRACKING_ID === undefined
        ? {}
        : { RUNNER_TRACKING_ID: process.env.RUNNER_TRACKING_ID }),
    };
    const seed = await runBoundedCommand(
      process.execPath,
      [
        "scripts/seed-canvas-fixtures.ts",
        "--data-dir",
        join(root, "data"),
        "--fixture",
        "document",
      ],
      { ...env, OCTANT_DATA_DIR: join(root, "seed-controller") },
      30_000,
    );
    await writeFile(join(artifacts, "seeded-canvas.txt"), seed);
    const projectId = /Chat Project Canvas fixtures: ([0-9a-f-]{36})/.exec(seed)?.[1];
    if (projectId === undefined) throw Error("The owned Canvas Project seed is missing.");
    fixtureDataDirectory = await realpath(join(root, "data"));
    if (fixtureDataDirectory !== join(await realpath(root), "data"))
      throw Error("The unique fixture data directory is not confined to its created root.");
    scratchHostScope = deriveHostRuntimeHostId(fixtureDataDirectory);
    pairedFixture = await seedPairedFixture(fixtureDataDirectory, projectId, controller.signal);
    const shareConfig = readShareConfig({
      OCTANT_SHARE_HOST: "127.0.0.1",
      OCTANT_SHARE_PORT: "0",
      OCTANT_SHARE_USERCONTENT_PORT: "0",
      OCTANT_SHARE_DATA_DIR: join(root, "share"),
    });
    if (shareConfig.status !== "ok") throw Error("The owned share fixture configuration refused.");
    shareService = startShareService(shareConfig.config);
    const ownService = shareService;
    if (!(await fetch(`${ownService.publicUrl}/healthz`)).ok)
      throw Error("The owned share fixture is unavailable.");
    await writeFile(
      join(artifacts, "service-origins.json"),
      JSON.stringify({
        public: ownService.publicUrl,
        content: ownService.usercontentUrl,
      }),
    );
    app = spawnPackagedApplication({ executable, env });
    pid = app.child.pid;
    if (pid === undefined) throw Error("No owned packaged application process.");
    const ownPid = pid;
    // The app is detached. A second finite owner stops its exact process group
    // if this controller crashes before its normal finally block can run.
    watchdog = spawn(
      process.execPath,
      [
        "-e",
        String.raw`
const owner = Number(process.env.OCTANT_SMOKE_OWNER_PID);
const group = Number(process.env.OCTANT_SMOKE_APP_PID);
const deadline = Date.now() + 330000;
if (!Number.isSafeInteger(owner) || owner < 2 || !Number.isSafeInteger(group) || group < 2) process.exit(1);
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error?.code !== "ESRCH"; } };
const signal = value => { try { process.kill(-group, value); } catch {} };
const timer = setInterval(() => {
  if (alive(owner) && alive(group) && alive(-group) && Date.now() < deadline) return;
  clearInterval(timer);
  if (!alive(-group)) process.exit(0);
  signal("SIGTERM");
  setTimeout(() => { signal("SIGKILL"); process.exit(0); }, 1000);
}, 100);
`,
      ],
      {
        detached: true,
        env: {
          ...env,
          OCTANT_SMOKE_OWNER_PID: String(process.pid),
          OCTANT_SMOKE_APP_PID: String(ownPid),
        },
        stdio: "ignore",
      },
    );
    const nativeInput = (stage: string, mode: string, label: string, value?: string) =>
      runBoundedCommand(
        nativeControllerPath,
        [
          mode,
          String(ownPid),
          join(artifacts, `${stage}.png`),
          label,
          ...(value === undefined ? [] : [value]),
        ],
        process.env,
        8000,
      );
    const Snapshot = Schema.Struct({
      pid: Schema.Number,
      windowId: Schema.Number,
      texts: Schema.Array(Schema.Struct({ text: Schema.String })),
    });
    const decodeSnapshot = Schema.decodeUnknownSync(Snapshot);
    const hasText = (snapshot: typeof Snapshot.Type, value: string) =>
      snapshot.texts.some((row) => row.text.toLowerCase().includes(value.toLowerCase()));
    const hasExactText = (snapshot: typeof Snapshot.Type, value: string) =>
      snapshot.texts.some((row) => row.text.trim().toLowerCase() === value.toLowerCase());
    const observeUntil = async (
      stage: string,
      accept: (snapshot: typeof Snapshot.Type) => boolean,
    ) => {
      let lastNativeError = "";
      const deadline = Date.now() + 20_000;
      while (!controller.signal.aborted && Date.now() < deadline) {
        try {
          const raw = await runBoundedCommand(
            nativeControllerPath,
            ["observe", String(ownPid), join(artifacts, `${stage}.png`), stage],
            process.env,
            8000,
          );
          await writeFile(join(artifacts, `${stage}.json`), raw);
          const snapshot = decodeSnapshot(JSON.parse(raw));
          if (snapshot.pid !== ownPid) throw Error("The observation belongs to another process.");
          lastNativeError = "";
          if (accept(snapshot)) {
            console.log(`Observed native stage: ${stage}`);
            return snapshot;
          }
        } catch (error) {
          lastNativeError =
            error instanceof Error ? error.message.slice(-1200) : "Native observation failed.";
        }
        await pause(150);
      }
      await writeFile(
        join(artifacts, "native-controller-diagnostic.txt"),
        lastNativeError || `The latest owned image did not contain the expected ${stage} state.`,
      );
      throw Error(`The real packaged ${stage} state was not observed.`);
    };
    await observeUntil("primary-window", (snapshot) => hasText(snapshot, "Welcome to Octant"));
    await runBoundedCommand(
      nativeControllerPath,
      ["click", String(ownPid), join(artifacts, "skip-setup-target.png"), "Skip setup"],
      process.env,
      8000,
    );
    await observeUntil(
      "after-skip",
      (snapshot) => snapshot.texts.length > 0 && !hasText(snapshot, "Welcome to Octant"),
    );
    await runBoundedCommand(
      nativeControllerPath,
      ["settings", String(ownPid), join(artifacts, "before-settings.png"), "Settings"],
      process.env,
      8000,
    );
    await observeUntil(
      "settings",
      (snapshot) =>
        hasText(snapshot, "Settings") &&
        hasText(snapshot, "Choose app-wide defaults, updates, and network behavior."),
    );
    await runBoundedCommand(
      nativeControllerPath,
      ["click", String(ownPid), join(artifacts, "back-to-app-target.png"), "Back to app"],
      process.env,
      8000,
    );
    await observeUntil("fixture-project", (snapshot) => hasText(snapshot, "Canvas fixtures"));
    await runBoundedCommand(
      nativeControllerPath,
      ["click", String(ownPid), join(artifacts, "fixture-project-target.png"), "Canvas fixtures"],
      process.env,
      8000,
    );
    await observeUntil(
      "fixture-canvas",
      (snapshot) =>
        hasText(snapshot, "Worth watching") &&
        hasText(snapshot, "Signups grew for the third week running."),
    );
    await runBoundedCommand(
      nativeControllerPath,
      ["settings", String(ownPid), join(artifacts, "canvas-before-settings.png"), "Settings"],
      process.env,
      8000,
    );
    await observeUntil("canvas-settings", (snapshot) => hasText(snapshot, "Search settings"));
    await runBoundedCommand(
      nativeControllerPath,
      [
        "fill",
        String(ownPid),
        join(artifacts, "service-search-target.png"),
        "Search settings",
        "Service address",
      ],
      process.env,
      8000,
    );
    await observeUntil("service-search", (snapshot) => hasText(snapshot, "in Permissions"));
    await runBoundedCommand(
      nativeControllerPath,
      ["enter", String(ownPid), join(artifacts, "service-search-result.png"), "Service address"],
      process.env,
      8000,
    );
    await observeUntil(
      "public-link-settings",
      (snapshot) =>
        hasText(snapshot, "Service address") &&
        hasText(snapshot, "Where public links are published"),
    );
    const SettingsRow = Schema.Struct({ payload_json: Schema.String });
    const Settings = Schema.Struct({ enabled: Schema.Boolean, serviceUrl: Schema.String });
    const waitForSettings = (enabled: boolean) =>
      waitForProcessCleanup(
        async () => {
          const connection = openReadOnlySqlite(join(root, "data", "octant.sqlite3"));
          try {
            const row = connection.all(
              "SELECT payload_json FROM event_journal WHERE event_name = 'canvas.public-link-settings-changed@1' ORDER BY global_sequence DESC LIMIT 1",
            )[0];
            if (row === undefined)
              throw Error("Native settings input has not reached the journal.");
            const payload = Schema.decodeUnknownSync(SettingsRow)(row).payload_json;
            const settings = Schema.decodeUnknownSync(Settings)(JSON.parse(payload));
            if (settings.enabled !== enabled || settings.serviceUrl !== ownService.publicUrl)
              throw Error("The journal has not confirmed the exact owned share settings.");
          } finally {
            connection.close();
          }
        },
        { timeoutMs: 5000 },
      );
    await runBoundedCommand(
      nativeControllerPath,
      [
        "fill",
        String(ownPid),
        join(artifacts, "service-address-target.png"),
        "Service address",
        ownService.publicUrl,
      ],
      process.env,
      8000,
    );
    await observeUntil("service-address-entered", (snapshot) =>
      hasText(snapshot, ownService.publicUrl),
    );
    await runBoundedCommand(
      nativeControllerPath,
      ["click", String(ownPid), join(artifacts, "save-address-target.png"), "Save address"],
      process.env,
      8000,
    );
    await waitForSettings(false);
    // The label focuses its associated input. Shift+Tab reaches the immediately
    // preceding Public links switch; the journal, not the key event, proves it.
    await runBoundedCommand(
      nativeControllerPath,
      [
        "toggle-before-field",
        String(ownPid),
        join(artifacts, "public-links-toggle-target.png"),
        "Service address",
      ],
      process.env,
      8000,
    );
    await waitForSettings(true);
    await observeUntil("public-links-configured", (snapshot) =>
      hasText(snapshot, ownService.publicUrl),
    );
    if ((await readdir(join(root, "share", "shares"))).length !== 0)
      throw Error("Configuring the service unexpectedly published content.");
    await runBoundedCommand(
      nativeControllerPath,
      ["click", String(ownPid), join(artifacts, "configured-back-to-app.png"), "Back to app"],
      process.env,
      8000,
    );
    await observeUntil("configured-canvas", (snapshot) => hasText(snapshot, "Worth watching"));
    await runBoundedCommand(
      nativeControllerPath,
      ["scroll-top", String(ownPid), join(artifacts, "canvas-scroll-target.png"), "Worth watching"],
      process.env,
      8000,
    );
    await observeUntil("canvas-start", (snapshot) => hasText(snapshot, "Signups this week"));
    await runBoundedCommand(
      nativeControllerPath,
      [
        "focus-before-text",
        String(ownPid),
        join(artifacts, "canvas-open-focus-target.png"),
        "Signups this week",
      ],
      process.env,
      8000,
    );
    await observeUntil("canvas-open-control", (snapshot) => hasText(snapshot, "Open Canvas"));
    await runBoundedCommand(
      nativeControllerPath,
      ["enter", String(ownPid), join(artifacts, "canvas-open-tab-target.png"), "Open Canvas"],
      process.env,
      8000,
    );
    await observeUntil(
      "canvas-tab",
      (snapshot) => hasText(snapshot, "v1") && hasText(snapshot, "Signups this week"),
    );
    await runBoundedCommand(
      nativeControllerPath,
      [
        "focus-before-text",
        String(ownPid),
        join(artifacts, "canvas-actions-focus-target.png"),
        "Signups this week",
      ],
      process.env,
      8000,
    );
    await runBoundedCommand(
      nativeControllerPath,
      [
        "enter",
        String(ownPid),
        join(artifacts, "canvas-actions-menu-target.png"),
        "Signups this week",
      ],
      process.env,
      8000,
    );
    await observeUntil("canvas-actions", (snapshot) => hasText(snapshot, "Export"));
    await runBoundedCommand(
      nativeControllerPath,
      [
        "choose-native-menu-item",
        String(ownPid),
        join(artifacts, "canvas-export-target.png"),
        "Export",
        "Export…",
      ],
      process.env,
      8000,
    );
    await observeUntil(
      "canvas-export",
      (snapshot) => hasText(snapshot, "Review export") && hasText(snapshot, "Public link"),
    );
    // This is the selected trigger actually observed in the first export
    // panel. Opening its native menu grants nothing; only the exact owned
    // Public link card below is eligible for approval.
    await nativeInput("destination-trigger", "click", "sharehtml.org — Ready");
    await observeUntil("destination-native-menu", (snapshot) =>
      hasExactText(snapshot, "Public link — Ready"),
    );
    await nativeInput(
      "destination-public-link",
      "choose-native-menu-item",
      "Public link — Ready",
      "Public link — Ready",
    );
    await observeUntil("destination-public-link-selected", (snapshot) =>
      hasText(snapshot, "Canvas page"),
    );
    await runBoundedCommand(
      nativeControllerPath,
      ["click", String(ownPid), join(artifacts, "review-export-target.png"), "Review export"],
      process.env,
      8000,
    );
    await observeUntil(
      "owned-publish-card",
      (snapshot) =>
        hasText(snapshot, "Export to Public link") &&
        hasExactText(snapshot, `Posts as ${new URL(ownService.publicUrl).host}`) &&
        hasText(snapshot, "Canvas page") &&
        hasText(snapshot, "Anyone with the link can open it"),
    );
    if ((await readdir(join(root, "share", "shares"))).length !== 0)
      throw Error("Preparing the native approval card unexpectedly published content.");
    const journalPayload = (event: "published" | "updated" | "export" | "settled") => {
      const name = {
        published: "canvas.public-share-published@1",
        updated: "canvas.public-share-updated@1",
        export: "canvas.export@1",
        settled: "canvas.public-share-revocation-settled@1",
      }[event];
      const connection = openReadOnlySqlite(join(root, "data", "octant.sqlite3"));
      try {
        const row = connection.all(
          `SELECT payload_json FROM event_journal WHERE event_name = '${name}' ORDER BY global_sequence DESC LIMIT 1`,
        )[0];
        if (row === undefined) throw Error(`The native ${event} result was not journaled.`);
        return JSON.parse(Schema.decodeUnknownSync(SettingsRow)(row).payload_json);
      } finally {
        connection.close();
      }
    };
    ownerSecretStore = makeKeychainCredentialStore(
      join(bundle, "Contents/Resources/native/octant-keychain-helper"),
      {
        storeScope: scratchHostScope,
        namespace: "canvas-public-share-secret",
        serviceFamily: "octant",
        timeoutMs: 5000,
      },
    );
    await nativeInput("approve-owned-export", "click", "Approve export");
    await observeUntil("native-published", (snapshot) => hasText(snapshot, "Exported."));
    const published = Schema.decodeUnknownSync(CanvasPublicSharePublished)(
      journalPayload("published"),
    );
    publishedCredentialRef = published.credentialRef;
    const publishedUrl = published.record.url;
    if (
      new URL(publishedUrl).origin !== ownService.publicUrl ||
      published.record.serviceUrl !== ownService.publicUrl
    )
      throw Error("The native export did not name the exact owned service.");
    const exportRecord = Schema.decodeUnknownSync(CanvasExportRecorded)(journalPayload("export"));
    if (
      exportRecord.targetId !== "public-link" ||
      exportRecord.format !== "share-document" ||
      String(exportRecord.canvasId) !== String(published.record.canvasId) ||
      exportRecord.outcome.kind !== "receipt" ||
      exportRecord.outcome.receipt.kind !== "link" ||
      exportRecord.outcome.receipt.href !== publishedUrl
    )
      throw Error("The native export receipt does not match the approved public-link target.");
    if (!(await ownerSecretStore.has(publishedCredentialRef)))
      throw Error(
        "The native link owner credential was not present in its scoped Keychain namespace.",
      );
    const viewer = await fetch(publishedUrl);
    const html = await viewer.text();
    if (
      !viewer.ok ||
      !html.includes("Signups this week") ||
      !html.includes("Referral page") ||
      viewer.headers.get("referrer-policy") !== "no-referrer" ||
      !viewer.headers.get("x-robots-tag")?.includes("noindex") ||
      !viewer.headers.get("content-security-policy")?.includes("script-src 'none'")
    )
      throw Error(
        "The actual native publication did not produce the expected private viewer response.",
      );
    await pairedFixture.connection.connect();
    if (pairedFixture.connection.state() !== "ready")
      throw Error("The actual packaged paired session is unavailable.");
    const pairedLinks = await pairedFixture.connection.authenticatedFetch({
      method: "GET",
      path: "/api/canvas/public-shares",
      query: `?canvasId=${encodeURIComponent(String(published.record.canvasId))}`,
    });
    const pairedList = await pairedLinks.text();
    if (!pairedLinks.ok || !pairedList.includes(publishedUrl))
      throw Error("The genuine paired read did not expose the owned published URL.");
    for (const path of [
      "/api/canvas/export-prepare",
      "/api/canvas/export-decide",
      "/api/canvas/public-share-revoke",
    ]) {
      const refused = await pairedFixture.connection.authenticatedFetch({
        method: "POST",
        path,
        body: "{}",
        contentType: "application/json",
      });
      if (refused.status !== 403)
        throw Error("A genuine paired client was not refused owner export authority.");
    }
    const showPublicLinks = async (stage: string, closeLabel = "Export", active = true) => {
      await nativeInput(`${stage}-close-export`, "escape", closeLabel);
      await observeUntil(
        `${stage}-canvas-tab`,
        (snapshot) => hasText(snapshot, "v1") && hasText(snapshot, "Signups this week"),
      );
      await nativeInput(`${stage}-focus-actions`, "focus-before-text", "Signups this week");
      await nativeInput(`${stage}-open-actions`, "enter", "Signups this week");
      await observeUntil(`${stage}-actions`, (snapshot) => hasText(snapshot, "Share"));
      await nativeInput(`${stage}-share`, "choose-native-menu-item", "Share", "Share…");
      await observeUntil(`${stage}-share-dialog`, (snapshot) => hasExactText(snapshot, "Share"));
      await nativeInput(`${stage}-public-links-scroll`, "scroll-bottom", "Share");
      await observeUntil(
        `${stage}-public-links`,
        (snapshot) => !active || (hasText(snapshot, "Copy link") && hasText(snapshot, "Revoke")),
      );
    };
    await showPublicLinks("published");
    await nativeInput("native-copy-link", "click", "Copy link");
    await observeUntil("native-copy-confirmed", (snapshot) => hasText(snapshot, "Link copied."));
    await nativeInput("native-update-link", "click", "Update");
    await observeUntil("update-export", (snapshot) => hasText(snapshot, "Review export"));
    await nativeInput("review-update", "click", "Review export");
    await observeUntil(
      "update-owned-card",
      (snapshot) =>
        hasText(snapshot, "Export to Public link") &&
        hasExactText(snapshot, `Posts as ${new URL(ownService.publicUrl).host}`) &&
        hasText(snapshot, "Updates") &&
        hasText(snapshot, publishedUrl),
    );
    const password = randomBytes(24).toString("base64url");
    const passwordFile = join(root, "private-viewer-input");
    await writeFile(passwordFile, password, { mode: 0o600, flag: "wx" });
    await nativeInput("native-link-password", "fill-private", "Password (optional)", passwordFile);
    await nativeInput("approve-update", "click", "Approve export");
    await observeUntil("native-updated", (snapshot) => hasText(snapshot, "Exported."));
    const updated = Schema.decodeUnknownSync(CanvasPublicShareRecordUpdated)(
      journalPayload("updated"),
    );
    if (
      updated.record.url !== publishedUrl ||
      updated.record.publicShareId !== published.record.publicShareId ||
      !updated.record.passwordProtected
    )
      throw Error("The native password update did not retain the same link.");
    const locked = await fetch(publishedUrl);
    if (locked.status !== 401 || !(await locked.text()).includes("Password-protected Canvas"))
      throw Error("The updated public link did not require its password.");
    const unlock = await fetch(publishedUrl, {
      method: "POST",
      redirect: "manual",
      body: new URLSearchParams({ password }),
    });
    const grant = unlock.headers.get("set-cookie");
    if (
      unlock.status !== 303 ||
      grant === null ||
      !grant.includes("HttpOnly") ||
      !grant.includes("SameSite=Strict")
    )
      throw Error("The actual viewer did not issue a bounded private view grant.");
    const cookie = grant.split(";")[0];
    if (cookie === undefined) throw Error("The private viewer grant was absent.");
    const unlocked = await fetch(publishedUrl, { headers: { cookie } });
    if (!unlocked.ok || !(await unlocked.text()).includes("Signups this week"))
      throw Error("The password view grant did not open the native publication.");
    const report = await fetch(`${publishedUrl}/report`, {
      method: "POST",
      body: new URLSearchParams({ reason: "privacy", detail: "Owned native publication fixture" }),
    });
    if (!report.ok) throw Error("The actual native publication report was not accepted.");
    const reports = await readdir(join(root, "share", "reports"));
    if (reports.length !== 1 || reports[0] === undefined)
      throw Error("The owned report was not stored once.");
    const storedReport: unknown = JSON.parse(
      await readFile(join(root, "share", "reports", reports[0]), "utf8"),
    );
    if (
      typeof storedReport !== "object" ||
      storedReport === null ||
      Object.keys(storedReport).sort().join(",") !== "createdAt,detail,reason,shareId"
    )
      throw Error("The stored report carried unexpected reporter fields.");
    await showPublicLinks("updated");
    await nativeInput("native-revoke", "click", "Revoke");
    await observeUntil(
      "native-revoke-card",
      (snapshot) =>
        hasText(snapshot, "Revoke this public link?") && hasText(snapshot, publishedUrl),
    );
    // Only the owned fixture goes offline. The native owner must journal the
    // owed revoke before the service returns, retaining its secret for retry.
    ownService.stop();
    await nativeInput("native-confirm-revoke", "click", "Revoke link");
    await observeUntil("native-offline-revoke", (snapshot) =>
      hasText(snapshot, "This Mac keeps trying to revoke the link."),
    );
    if (!(await ownerSecretStore.has(publishedCredentialRef)))
      throw Error("The offline revoke discarded the credential needed to retry.");
    const restored = startShareService({
      ...shareConfig.config,
      port: Number(new URL(ownService.publicUrl).port),
      usercontentPort: Number(new URL(ownService.usercontentUrl).port),
      publicOrigin: ownService.publicUrl,
      usercontentOrigin: ownService.usercontentUrl,
    });
    shareService = restored;
    if (
      restored.publicUrl !== ownService.publicUrl ||
      restored.usercontentUrl !== ownService.usercontentUrl
    )
      throw Error("The restored owned service changed its origins.");
    const stillLive = await fetch(publishedUrl, { headers: { cookie } });
    if (!stillLive.ok) throw Error("The offline revoke was falsely reported as already settled.");
    // Listings use the production one-minute retry throttle. Wait for that
    // real interval, then reopen the real Share panel rather than bypass it.
    for (let second = 0; second < 61 && !controller.signal.aborted; second++) await pause(1000);
    if (controller.signal.aborted) throw Error("The offline retry was interrupted.");
    await showPublicLinks("retry", "Share", false);
    await waitForProcessCleanup(
      async () => {
        if ((await fetch(publishedUrl, { headers: { cookie } })).status !== 410)
          throw Error("The production pending-revoke retry has not settled.");
      },
      { timeoutMs: 10_000 },
    );
    const gone = await fetch(publishedUrl, { headers: { cookie } });
    if (gone.status !== 410) throw Error("The natively revoked publication did not return 410.");
    journalPayload("settled");
    if (await ownerSecretStore.has(publishedCredentialRef))
      throw Error("The native revocation left its scoped owner credential behind.");
    ownerSecretCleanupVerified = true;
    await writeFile(
      join(artifacts, "native-publication-evidence.json"),
      JSON.stringify(
        {
          source: "normal packaged window",
          publicService: ownService.publicUrl,
          canvasId: String(published.record.canvasId),
          publicShareId: String(published.record.publicShareId),
          targetId: String(exportRecord.targetId),
          format: exportRecord.format,
          approvedExport: true,
          viewerHTTP: true,
          freshViewerBrowser: false,
          sameUrlUpdate: true,
          passwordViewGrant: true,
          reportPrivacy: true,
          nativeCopy: true,
          nativeRevoke410: true,
          scopedOwnerCredentialRemoved: true,
          pairedClient: "actual-packaged-gateway-pinned-TLS-signed-session-read-and-export-refusal",
          pairedSetup: "API-seeded owned device and Project scope; no native pairing UI",
          pairedBrowserClipboard: false,
          offlineRetry: "native-offline-revoke-and-listing-retry-passed",
        },
        null,
        2,
      ),
    );
    if (controller.signal.aborted) throw Error("Native window observation was interrupted.");
    verified = true;
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGTERM", interrupted);
    process.removeListener("SIGINT", interrupted);
    pairedFixture?.connection.disconnect();
    if (shareService !== undefined) shareService.stop();
    if (app !== undefined && pid !== undefined && bundle !== undefined) {
      const ownPid = pid;
      const ownedApp = app;
      const ownedBundle = bundle;
      const ownedPort = port;
      await cleanupPackagedProcess({
        child: ownedApp.child,
        requestQuit: () =>
          runBoundedCommand(
            "/usr/bin/osascript",
            ["-e", createQuitAppleScript(ownedBundle)],
            process.env,
            3000,
          ).then(() => undefined),
        waitForExit: (_child, timeout) => exited(ownedApp.child, timeout),
        signalGroup: (group, signal) => {
          if (group !== ownPid) throw Error("Refusing an unowned process group.");
          try {
            process.kill(-group, signal);
          } catch (error) {
            if (
              !(
                typeof error === "object" &&
                error !== null &&
                "code" in error &&
                error.code === "ESRCH"
              )
            )
              throw error;
          }
        },
        waitForServerCleanup: async () => {
          if (ownedPort === undefined) return;
          await waitForProcessCleanup(
            async () => {
              const response = await fetch(`http://127.0.0.1:${ownedPort}/health`, {
                signal: AbortSignal.timeout(300),
              }).catch(() => undefined);
              if (response !== undefined) throw Error("The owned listener remains available.");
            },
            { timeoutMs: 3000 },
          );
        },
        assertNoProcesses: async () => {
          if (groupProcesses(ownPid).length !== 0) throw Error("Owned native processes remain.");
          if (watchdog !== undefined && !(await exited(watchdog, 2000)))
            throw Error("The finite native cleanup watchdog did not exit.");
        },
        gracefulTimeoutMs: 3000,
        forceTimeoutMs: 2000,
      });
      if (pairedFixture !== undefined) {
        const address = new URL(pairedFixture.origin);
        const probe = createServer();
        await new Promise<void>((resolve, reject) => {
          probe.once("error", reject);
          probe.listen(Number(address.port), address.hostname, resolve);
        });
        await new Promise<void>((resolve, reject) =>
          probe.close((error) => (error ? reject(error) : resolve())),
        );
      }
      cleanupVerified = true;
    }
    if (ownerSecretStore !== undefined && publishedCredentialRef === undefined) {
      // An upload can finish before its success notice is observed. Recover
      // only this fixture's journaled reference so a later UI failure cannot
      // strand an owned Keychain item when its scratch directory is removed.
      try {
        const connection = openReadOnlySqlite(join(root, "data", "octant.sqlite3"));
        try {
          const row = connection.all(
            "SELECT payload_json FROM event_journal WHERE event_name = 'canvas.public-share-published@1' ORDER BY global_sequence DESC LIMIT 1",
          )[0];
          if (row !== undefined) {
            const payload = Schema.decodeUnknownSync(
              Schema.Struct({ payload_json: Schema.String }),
            )(row);
            publishedCredentialRef = Schema.decodeUnknownSync(CanvasPublicSharePublished)(
              JSON.parse(payload.payload_json),
            ).credentialRef;
          }
        } finally {
          connection.close();
        }
      } catch {
        ownerSecretCleanupFailed = true;
      }
    }
    if (ownerSecretStore !== undefined && publishedCredentialRef !== undefined) {
      try {
        await ownerSecretStore.delete(publishedCredentialRef);
        if (await ownerSecretStore.has(publishedCredentialRef))
          throw Error("Owned credential remains.");
        ownerSecretCleanupVerified = true;
      } catch {
        ownerSecretCleanupFailed = true;
        await writeFile(
          join(artifacts, "owner-secret-cleanup.json"),
          JSON.stringify({ result: "unverified" }),
        );
      }
    }
    if (ownerSecretStore !== undefined && bundle !== undefined && cleanupVerified) {
      try {
        const currentDataDirectory = await realpath(join(root, "data"));
        if (
          fixtureDataDirectory !== currentDataDirectory ||
          currentDataDirectory !== join(await realpath(root), "data") ||
          scratchHostScope !== deriveHostRuntimeHostId(currentDataDirectory)
        )
          throw Error("The unique scratch-host scope identity changed.");
        // This helper purges all namespaces inside one store scope. This
        // brand-new scratch scope contains exclusively our synthetic fixture;
        // provider identities and all legacy fallback attribution stay empty.
        const purge = makeKeychainCredentialPurgeStore(
          join(bundle, "Contents/Resources/native/octant-keychain-helper"),
          { storeScope: scratchHostScope, serviceFamily: "octant", timeoutMs: 5000 },
        );
        const before = await purge.purge({ dryRun: true, providerInstanceIds: [] });
        if (!before.dryRun) throw Error("The fixture cleanup inventory was not read-only.");
        if (before.matchedCount > 0) {
          const removed = await purge.purge({ dryRun: false, providerInstanceIds: [] });
          if (removed.dryRun || removed.failedCount !== 0)
            throw Error("Fixture credential cleanup failed.");
        }
        const after = await purge.purge({ dryRun: true, providerInstanceIds: [] });
        if (!after.dryRun || after.matchedCount !== 0) throw Error("Fixture credentials remain.");
        ownerSecretCleanupVerified = true;
        ownerSecretCleanupFailed = false;
        await writeFile(
          join(artifacts, "owner-secret-cleanup.json"),
          JSON.stringify(
            {
              result: "verified",
              scope: scratchHostScope,
              namespaces: "all within the independently verified unique fixture host scope",
              knownReferenceDeletedFirst: publishedCredentialRef !== undefined,
              fixtureScopedMatchesBefore: before.matchedCount,
              fixtureScopedMatchesAfter: 0,
              legacyFallback: false,
              appJoinedBeforeCleanup: true,
            },
            null,
            2,
          ),
        );
      } catch {
        ownerSecretCleanupFailed = true;
        await writeFile(
          join(artifacts, "owner-secret-cleanup.json"),
          JSON.stringify({ result: "unverified" }),
        );
      }
    }
    if (shareService !== undefined) {
      const ownService = shareService;
      await waitForProcessCleanup(
        async () => {
          for (const origin of [ownService.publicUrl, ownService.usercontentUrl]) {
            const response = await fetch(origin, { signal: AbortSignal.timeout(300) }).catch(
              () => undefined,
            );
            if (response !== undefined)
              throw Error("An owned share fixture listener remains available.");
          }
        },
        { timeoutMs: 3000 },
      );
    }
    await rm(root, { recursive: true, force: true });
    if (bundle !== undefined && bundle.startsWith(join(tmpdir(), "octant-packaged-app.")))
      await rm(dirname(bundle), { recursive: true, force: true });
  }
  if (controller.signal.aborted || !verified || !cleanupVerified)
    throw Error("Native window proof or cleanup is incomplete.");
  if (
    ownerSecretCleanupFailed ||
    (publishedCredentialRef !== undefined && !ownerSecretCleanupVerified)
  )
    throw Error("The owned publication credential cleanup could not be verified.");
  await writeFile(
    join(artifacts, "native-window-evidence.json"),
    JSON.stringify(
      {
        stage: "packaged-primary-window",
        result: "observed",
        processId: pid,
        watchdogProcessId: watchdog?.pid,
        port,
        nativeInput: "WindowServer image, Vision and CoreGraphics",
        packageProvenance,
        cachedPackage: process.env.OCTANT_QA_CACHED_PACKAGE === "true",
        nativeSetupSkip: true,
        nativeSettings: true,
        seededCanvasRendered: true,
        publicLinkSettingsObserved: true,
        nativeServiceConfiguration: "journal-confirmed",
        configurationPublishedNothing: true,
        nativeCanvasTab: true,
        nativeExportPanel: true,
        nativeOwnedPublishCard: true,
        productionDebuggingUnchanged: true,
        cleanup: "verified",
        publishAcceptance: "native-publish-update-revoke-passed",
        pairedAcceptance: "not-run",
        personalAccount: false,
      },
      null,
      2,
    ),
  );
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Packaged native smoke failed.");
  process.exitCode = 1;
});
