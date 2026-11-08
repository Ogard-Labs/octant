import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { decodeCanvasId, decodeCanvasVersionId } from "@octant/contracts/canvas";
import { decodeUtcTimestamp } from "@octant/contracts/events";
import { ExtensionActivationScope, ExtensionSource } from "@octant/contracts/extensions";
import {
  ExtensionActivationService,
  LOCAL_EXTENSION_ACTIVATION_POLICY,
} from "../extensions/extensionActivationService";
import { ExtensionLifecycleService } from "../extensions/extensionLifecycleService";
import { ExtensionPackageStore } from "../extensions/extensionPackageStore";
import { ExtensionSupervisor } from "../extensions/extensionSupervisor";
import { createNodeExtensionProcessPort } from "../extensions/nodeExtensionProcessPort";
import { loadPluginDirectory } from "../extensions/pluginDirectoryLoader";
import { readCanvasExportPackage } from "../extensions/canvasExportPackage";
import { inspectExtensionPackage } from "../extensions/packageInspector";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { resolveOutsideDriverRuntime } from "../providers/outsideDriverProcess";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { CanvasExportEventStore } from "./canvasExportEventStore";
import { canvasExportPluginTargets } from "./canvasExportPluginTargets";
import { CanvasExportService, type CanvasExportDocument } from "./canvasExportService";

/** Actual installed package and native worker, with the remote HTTP response stood in for. */
async function main(): Promise<void> {
  const runtime = resolveOutsideDriverRuntime({
    versions: process.versions,
    execPath: process.execPath,
  });
  const example = process.env.OCTANT_QA_EXPORT_EXAMPLE_ROOT;
  if (process.platform !== "darwin" || process.versions.bun === undefined || runtime === undefined)
    throw Error("The installed export acceptance requires Bun on isolated macOS.");
  if (example === undefined) throw Error("Supply the pinned example source directory.");
  const root = await mkdtemp(join(await realpath(tmpdir()), "octant-installed-export-"));
  const buildRoot = await mkdtemp(
    join(
      fileURLToPath(new URL("../../../../packages/plugin-api/", import.meta.url)),
      ".native-export-",
    ),
  );
  const database = join(root, "host.sqlite3");
  const connection = openSqlite(database);
  const clock = () => decodeUtcTimestamp(new Date().toISOString());
  const registries = createPhase1RuntimeRegistries();
  applyMigrations(connection, MIGRATIONS, clock);
  const journal = new Journal({
    connection,
    registry: registries.events,
    projections: registries.projections,
    clock,
  });
  const worker = fileURLToPath(new URL("./canvasExportWorker.mjs", import.meta.url));
  const store = new ExtensionPackageStore({
    dataDirectory: root,
    uuid: randomUUID,
    outsideDriverRuntime: runtime,
    canvasExportWorkerEntryPoint: worker,
  });
  const native = createNodeExtensionProcessPort({ receiptDirectory: join(root, "receipts") });
  let starts = 0;
  const supervisor = new ExtensionSupervisor({
    process: {
      receipts: native.receipts,
      start: async (input) => {
        starts += 1;
        return native.start(input);
      },
    },
    authorizeLaunch: (input) => store.authorizeRuntimeLaunch(input),
    clock,
    evidence: (event) => lifecycle.recordRuntimeEvidence(event),
  });
  const lifecycle = new ExtensionLifecycleService({
    connection,
    journal,
    store,
    supervisor,
    uuid: randomUUID,
    clock,
  });
  let installedId: string | undefined;
  let failure: unknown;
  try {
    await writeFile(
      join(buildRoot, "reference.mjs"),
      await readFile(join(resolve(example), "index.mjs")),
    );
    // The published factory's fetch port receives a controlled response in this
    // fixture. Its receipt proves the exact body crossed the actual process;
    // no request is made to the illustrative public page host.
    await writeFile(
      join(buildRoot, "entry.mjs"),
      `import { createHash } from "node:crypto";
import { createPageHostExportTarget } from "./reference.mjs";
export const canvasExport = createPageHostExportTarget({
  targetId: "docs-md-example", label: "docs-md (example)", formats: ["markdown", "html"],
  fetch: async request => new Response(JSON.stringify({ url: "https://pages.example/installed-native-copy", id: createHash("sha256").update(await request.text()).digest("hex") }), { status: 201 })
});`,
    );
    const packageRoot = join(root, "local-package");
    await mkdir(join(packageRoot, "dist"), { recursive: true });
    await writeFile(
      join(packageRoot, "octant-canvas-export.json"),
      await readFile(join(resolve(example), "octant-canvas-export.json")),
    );
    const built = await Bun.build({
      entrypoints: [join(buildRoot, "entry.mjs")],
      target: "node",
      minify: true,
    });
    const module = built.outputs[0];
    if (!built.success || module === undefined)
      throw Error("The example's public SDK bundle failed.");
    await writeFile(
      join(packageRoot, "dist/index.mjs"),
      new Uint8Array(await module.arrayBuffer()),
    );
    const loaded = await loadPluginDirectory(packageRoot);
    if (loaded.format !== "canvas-export-package")
      throw Error("The local folder was not recognized as an export package.");
    const reading = readCanvasExportPackage({
      layout: loaded.format,
      source: Schema.decodeUnknownSync(ExtensionSource)({
        kind: "local-folder",
        sourceRef: "installed-example-fixture",
      }),
      format: "directory",
      archiveBytes: module.size,
      entries: loaded.entries,
      appVersion: "0.1.0",
      platform: process.platform,
    });
    if (reading.status !== "accepted") throw Error("The example package document was refused.");
    const inspected = inspectExtensionPackage(reading.resolved);
    await store.initialize();
    await lifecycle.install(inspected);
    installedId = String(inspected.manifest.extensionId);
    const current = () => {
      const pkg = lifecycle
        .snapshot()
        .packages.find((pkg) => String(pkg.extensionId) === installedId);
      if (pkg === undefined) throw Error("Installed example is absent from the real projection.");
      return pkg;
    };
    const activation = new ExtensionActivationService({
      policy: LOCAL_EXTENSION_ACTIVATION_POLICY,
      catalogStatus: () => "available",
    });
    const scope = Schema.decodeUnknownSync(ExtensionActivationScope)({
      hostId: "local",
      mode: "code",
      projectId: null,
      threadId: null,
      providerFamily: "canvas-export",
    });
    const bindings = () =>
      canvasExportPluginTargets(
        { store, supervisor, runtime, workerEntryPoint: worker, platform: process.platform },
        () => activation.resolve(lifecycle.snapshot(), { scope }),
      );
    const events = new CanvasExportEventStore({ journal, uuid: randomUUID });
    const document: CanvasExportDocument = {
      canvasId: decodeCanvasId(randomUUID()),
      versionId: decodeCanvasVersionId(randomUUID()),
      sequence: 1,
      title: "Installed native export",
      blocks: [
        {
          blockId: "heading",
          schemaVersion: 1,
          kind: "heading",
          level: 1,
          text: "Native package acceptance",
        },
      ],
    };
    const service = new CanvasExportService({
      load: (id) => (String(id) === String(document.canvasId) ? document : undefined),
      targets: bindings,
      eventStore: events,
      uuid: randomUUID,
      clock,
    });
    const noOffer = () => {
      if (service.offers(document.canvasId)?.targets.length !== 0 || starts !== 0)
        throw Error("Installation, trust or one enable switch started or offered a destination.");
    };
    noOffer();
    await lifecycle.setSourceTrust({
      extensionId: current().extensionId,
      expectedStateVersion: current().stateVersion,
      trusted: true,
    });
    noOffer();
    await lifecycle.setPluginDesired({
      extensionId: current().extensionId,
      expectedStateVersion: current().stateVersion,
      desired: true,
    });
    noOffer();
    const component = current().components[0]?.component;
    if (component === undefined) throw Error("The example export component is missing.");
    await lifecycle.setComponentDesired({
      extensionId: current().extensionId,
      expectedStateVersion: current().stateVersion,
      componentId: component.id,
      desired: true,
    });
    const offered = service.offers(document.canvasId)?.targets[0];
    if (offered?.status !== "ready")
      throw Error("The trusted and enabled example was not offered.");
    const request = {
      schemaVersion: 1 as const,
      kind: "canvas-export-prepare" as const,
      canvasId: document.canvasId,
      versionId: document.versionId,
      expectedSequence: 1,
      targetId: offered.targetId,
      format: "markdown" as const,
    };
    if ((await service.prepare(request, false)).kind !== "refused" || starts !== 0)
      throw Error("An unauthorized prepare reached native package code.");
    const denied = await service.prepare(request, true);
    if (denied.kind !== "approval")
      throw Error("The installed example did not describe an approval.");
    const afterDescription = starts;
    const actor = { kind: "local-user" as const, actorId: OCTANT_LOCAL_ACTOR_ID };
    await service.decide({
      canvasId: document.canvasId,
      approvalId: denied.card.approvalId,
      decision: "denied",
      permitted: true,
      actor,
    });
    if (starts !== afterDescription || events.replay().length !== 0)
      throw Error("A denied card invoked or recorded an export.");
    const prepared = await service.prepare(request, true);
    if (prepared.kind !== "approval")
      throw Error("The example could not prepare a second reviewed export.");
    const expectedReceipt = createHash("sha256")
      .update(
        JSON.stringify({
          title: prepared.card.title,
          format: prepared.card.format,
          body: prepared.card.payload,
        }),
      )
      .digest("hex");
    const exported = await service.decide({
      canvasId: document.canvasId,
      approvalId: prepared.card.approvalId,
      decision: "approved",
      permitted: true,
      actor,
    });
    if (
      exported.kind !== "exported" ||
      exported.record.outcome.kind !== "receipt" ||
      exported.record.outcome.receipt.kind !== "link" ||
      exported.record.outcome.receipt.remoteId !== expectedReceipt
    )
      throw Error("The real installed example did not receive the exact approved payload.");
    const replayConnection = openSqlite(database);
    try {
      const replayJournal = new Journal({
        connection: replayConnection,
        registry: registries.events,
        projections: registries.projections,
        clock,
      });
      const replayed = new CanvasExportEventStore({
        journal: replayJournal,
        uuid: randomUUID,
      }).replay();
      if (replayed.length !== 1 || replayed[0]?.payloadDigest !== prepared.card.payloadDigest)
        throw Error("The completed export did not replay from the real journal.");
    } finally {
      replayConnection.close();
    }
    const stale = await service.prepare(request, true);
    if (stale.kind !== "approval") throw Error("The example did not prepare a revocation case.");
    await lifecycle.disable(installedId);
    const beforeStale = starts;
    const refused = await service.decide({
      canvasId: document.canvasId,
      approvalId: stale.card.approvalId,
      decision: "approved",
      permitted: true,
      actor,
    });
    if (
      refused.kind !== "refused" ||
      starts !== beforeStale ||
      service.offers(document.canvasId)?.targets.length !== 0 ||
      events.replay().length !== 1
    )
      throw Error("Disable did not invalidate the held native export approval.");
    if ((await native.receipts()).length !== 0)
      throw Error("The installed export left a native process receipt.");
  } catch (error) {
    failure = error;
  } finally {
    try {
      const drained = installedId === undefined ? undefined : await supervisor.drain(installedId);
      connection.close();
      if (drained !== undefined && drained.state !== "drained") {
        failure ??= Error("Native worker cleanup is uncertain; its owned fixture was retained.");
      } else {
        const writable = async (path: string): Promise<void> => {
          await chmod(path, 0o700);
          for (const entry of await readdir(path, { withFileTypes: true })) {
            if (entry.isDirectory()) await writable(join(path, entry.name));
            else await chmod(join(path, entry.name), 0o600);
          }
        };
        await writable(root);
        await rm(root, { recursive: true, force: true });
        await rm(buildRoot, { recursive: true, force: true });
      }
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
  console.log(
    JSON.stringify({
      check: "installed-example-native-export",
      status: "passed",
      runtime: runtime.kind,
      source: "public example factory",
      localFolder: true,
      realJournal: true,
      nativeWorker: true,
      controlledHttpResponse: true,
      realExternalExport: false,
      nativeStarts: starts,
      receipts: 0,
      cleanup: "verified",
    }),
  );
}

void main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message.slice(0, 1024) : "Installed native export smoke failed.",
  );
  process.exitCode = 1;
});
