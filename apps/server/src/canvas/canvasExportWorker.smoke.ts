import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { ExtensionSource } from "@octant/contracts/extensions";
import { decodeCanvasExportRenderedOutput } from "@octant/contracts/canvas-export";
import { readCanvasExportPackage } from "../extensions/canvasExportPackage";
import { inspectExtensionPackage } from "../extensions/packageInspector";
import { ExtensionPackageStore } from "../extensions/extensionPackageStore";
import { ExtensionSupervisor } from "../extensions/extensionSupervisor";
import { createNodeExtensionProcessPort } from "../extensions/nodeExtensionProcessPort";
import { resolveOutsideDriverRuntime } from "../providers/outsideDriverProcess";
import { runCanvasExportWorker } from "./canvasExportWorkerProcess";

/** Run in an isolated test computer; this checks a real native process, not a simulated port. */
async function main(): Promise<void> {
  const runtime = resolveOutsideDriverRuntime({
    versions: process.versions,
    execPath: process.execPath,
  });
  if (process.platform !== "darwin" || runtime === undefined)
    throw new Error("This host has no available native export-worker runtime.");
  if (spawnSync("/usr/bin/true").status !== 0)
    throw new Error("The native control process was unavailable outside confinement.");
  const root = await mkdtemp(join(await realpath(tmpdir()), "octant-export-native-smoke-"));
  const worker = fileURLToPath(new URL("./canvasExportWorker.mjs", import.meta.url));
  const extensionId = { current: "" };
  const supervisor = new ExtensionSupervisor({
    process: createNodeExtensionProcessPort({ receiptDirectory: join(root, "receipts") }),
    clock: () => new Date().toISOString(),
    evidence: (event) =>
      console.log(
        JSON.stringify({ stage: "worker-lifecycle", state: event.state, reason: event.reason }),
      ),
    authorizeLaunch: (input) => store.authorizeRuntimeLaunch(input),
  });
  const store = new ExtensionPackageStore({
    dataDirectory: root,
    uuid: randomUUID,
    outsideDriverRuntime: runtime,
    canvasExportWorkerEntryPoint: worker,
  });
  try {
    const forbidden = join(root, "host-only.txt");
    const forbiddenWrite = join(root, "host-write.txt");
    await writeFile(forbidden, "disposable fixture only");
    const entry = `import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
export const canvasExport = {
  describeDestination: async () => {
    const probe = { packageRead: readFileSync(process.argv[2], 'utf8').length > 0, hostRead: false, hostWrite: false, privateWrite: false, child: false, socketDenied: false, bridgeDenied: false };
    try { readFileSync(${JSON.stringify(forbidden)}); probe.hostRead = true; } catch {}
    try { writeFileSync(${JSON.stringify(forbiddenWrite)}, 'unexpected'); probe.hostWrite = true; } catch {}
    try { writeFileSync(process.env.TMPDIR + '/owned-cache', 'fixture'); probe.privateWrite = true; } catch {}
    try { const child = spawnSync('/usr/bin/true'); probe.child = child.status === 0; } catch {}
    probe.socketDenied = await new Promise(resolve => {
      const socket = createConnection({ host: '127.0.0.1', port: 9 });
      const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 1000);
      socket.on('connect', () => { clearTimeout(timer); socket.destroy(); resolve(false); });
      socket.on('error', error => { clearTimeout(timer); resolve(['EPERM','EACCES'].includes(error.code)); });
    });
    try { await fetch('https://example.test/'); } catch { probe.bridgeDenied = true; }
    return { note: JSON.stringify(probe) };
  },
  exportDocument: async () => ({ kind: 'receipt', receipt: { kind: 'remote-id', remoteId: 'disposable-native-copy' } })
};`;
    const manifest = {
      manifestVersion: 1,
      slug: "native-export-probe",
      displayName: "Native export probe",
      version: "1.0.0",
      provenance: { publisher: "Octant fixture", canonicalUrl: "https://example.test/export" },
      license: { kind: "spdx", identifier: "MIT" },
      compatibility: {
        platforms: ["macos", "linux", "windows"],
        modes: ["chat", "work", "code"],
        providerFamilies: [],
      },
      declaredCapabilities: [],
      components: [
        {
          id: "export",
          kind: "canvas-export-target",
          displayName: "Native export probe",
          declaredCapabilities: [],
          entryPoint: "export.mjs",
          canvasExport: {
            contribution: {
              schemaVersion: 1,
              kind: "canvas-export-contribution",
              targetId: "native-probe",
              label: "Native export probe",
              formats: ["markdown"],
            },
            allowedOrigins: [],
          },
        },
      ],
    };
    const reading = readCanvasExportPackage({
      layout: "canvas-export-package",
      source: Schema.decodeUnknownSync(ExtensionSource)({
        kind: "local-folder",
        sourceRef: "native-export-smoke",
      }),
      format: "directory",
      archiveBytes: 16384,
      entries: [
        {
          path: "octant-canvas-export.json",
          kind: "file",
          content: Buffer.from(JSON.stringify({ manifest })),
        },
        { path: "export.mjs", kind: "file", content: Buffer.from(entry) },
      ],
      appVersion: "1.0.0",
      platform: process.platform,
    });
    if (reading.status !== "accepted") throw new Error("Native probe package was refused.");
    await store.initialize();
    const reference = await store.promote(
      await store.stage(inspectExtensionPackage(reading.resolved)),
    );
    extensionId.current = reference.extensionId;
    const output = decodeCanvasExportRenderedOutput({
      schemaVersion: 1,
      kind: "canvas-export-output",
      format: "markdown",
      title: "Native export probe",
      body: "disposable",
      metadata: {
        canvasId: randomUUID(),
        versionId: randomUUID(),
        sequence: 1,
        byteLength: 10,
        contentDigest: `sha256:${"a".repeat(64)}`,
      },
    });
    const options = {
      store,
      supervisor,
      runtime,
      workerEntryPoint: worker,
      platform: process.platform,
    };
    const input = {
      reference,
      componentId: "export",
      current: () => true,
      allowedOrigins: [],
      output,
    };
    const description = await runCanvasExportWorker(options, { ...input, phase: "describe" });
    console.log(
      JSON.stringify({
        stage: "native-description",
        kind: description.kind,
        ...(description.kind === "description" ? { probe: description.destination?.note } : {}),
      }),
    );
    if (
      description.kind !== "description" ||
      description.destination?.note !==
        JSON.stringify({
          packageRead: true,
          hostRead: false,
          hostWrite: false,
          privateWrite: true,
          child: false,
          socketDenied: true,
          bridgeDenied: true,
        })
    )
      throw new Error("Native export isolation was not proven.");
    const exported = await runCanvasExportWorker(options, { ...input, phase: "export" });
    if (exported.kind !== "delivery" || exported.delivery.kind !== "receipt")
      throw new Error("Native export did not complete.");
    if ((await readdir(join(root, "receipts"))).length !== 0)
      throw new Error("A worker process still owns a receipt.");
    console.log(
      JSON.stringify({
        status: "passed",
        runtime: runtime.kind,
        isolation: "native",
        realExternalExport: false,
      }),
    );
  } finally {
    if (extensionId.current !== "") await supervisor.drain(extensionId.current);
    const writable = async (path: string): Promise<void> => {
      await chmod(path, 0o700);
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (entry.isDirectory()) await writable(join(path, entry.name));
        else await chmod(join(path, entry.name), 0o600);
      }
    };
    await writable(root);
    await rm(root, { recursive: true, force: true });
  }
}
void main().catch(() => {
  console.error(
    "Native export worker smoke failed; no isolation or external-export claim is established.",
  );
  process.exitCode = 1;
});
