import { Schema } from "effect";
import { ExtensionSource } from "@octant/contracts/extensions";
import { randomUUID } from "node:crypto";
import { chmod, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readCanvasExportPackage } from "./canvasExportPackage";
import { ExtensionPackageStore } from "./extensionPackageStore";
import { inspectExtensionPackage, type ExtensionArchiveEntry } from "./packageInspector";
import { signPackageEntries } from "./packageSignatureTestFixtures";

function reading(
  sign?: (entries: ReadonlyArray<ExtensionArchiveEntry>) => ReadonlyArray<ExtensionArchiveEntry>,
) {
  const manifest = {
    provenance: { publisher: "Example Publisher", canonicalUrl: "https://example.test/export" },
    manifestVersion: 1,
    slug: "page-export",
    displayName: "Page export",
    version: "1.0.0",
    license: { kind: "spdx", identifier: "MIT" },
    compatibility: {
      platforms: ["macos", "linux", "windows"],
      modes: ["chat", "work", "code"],
      providerFamilies: [],
    },
    declaredCapabilities: ["network"],
    components: [
      {
        id: "export",
        kind: "canvas-export-target",
        displayName: "Page export",
        declaredCapabilities: ["network"],
        entryPoint: "export.mjs",
        canvasExport: {
          contribution: {
            schemaVersion: 1,
            kind: "canvas-export-contribution",
            targetId: "page-export",
            label: "Page export",
            formats: ["markdown"],
          },
          allowedOrigins: ["https://example.test"],
        },
      },
    ],
  };
  return readCanvasExportPackage({
    layout: "canvas-export-package",
    source: Schema.decodeUnknownSync(ExtensionSource)({
      kind: "local-folder",
      sourceRef: "local-export",
    }),
    format: "directory",
    archiveBytes: 1024,
    entries: (sign ?? ((entries) => entries))([
      {
        path: "octant-canvas-export.json",
        kind: "file",
        content: Buffer.from(JSON.stringify({ manifest })),
      },
      { path: "export.mjs", kind: "file", content: Buffer.from("export const canvasExport = {};") },
    ]),
    appVersion: "1.0.0",
    platform: "darwin",
  });
}

describe("a signed Canvas export package", () => {
  it("records the key that signed it and refuses a signature that does not match its files", () => {
    let fingerprint = "";
    const signed = reading((entries) => {
      const signature = signPackageEntries(entries, { name: "page-export", version: "1.0.0" });
      fingerprint = signature.fingerprint;
      return [...entries, signature.entry];
    });
    if (signed.status !== "accepted") throw new Error("expected an accepted package");
    expect(inspectExtensionPackage(signed.resolved).manifest.provenance.publisherKey).toBe(
      fingerprint,
    );

    expect(
      reading((entries) => [
        ...entries,
        signPackageEntries(entries.slice(0, 1), { name: "page-export", version: "1.0.0" }).entry,
      ]),
    ).toEqual({ status: "refused", reason: "signature-invalid" });
  });
});

describe("installed Canvas export modules", () => {
  it("verifies a non-executable module and admits only the fixed worker launch under isolation", async () => {
    const value = reading();
    if (value.status !== "accepted") throw new Error("expected package acceptance");
    const inspected = inspectExtensionPackage(value.resolved);
    const directory = await mkdtemp(join(tmpdir(), "octant-export-store-"));
    try {
      const runtime = { kind: "bun", path: "/host/bun" } as const;
      const worker = "/host/canvasExportWorker.mjs";
      const store = new ExtensionPackageStore({
        dataDirectory: directory,
        uuid: randomUUID,
        outsideDriverRuntime: runtime,
        canvasExportWorkerEntryPoint: worker,
      });
      await store.initialize();
      const target = await store.promote(await store.stage(inspected));
      const entry = await store.verifiedModuleEntry(target, "export", "canvas-export-target");
      if (entry === undefined) throw new Error("expected verified entry");
      const input = {
        ...target,
        componentId: "export",
        entryPoint: entry.entryPoint,
        command: runtime.path,
        args: [worker, entry.entryPoint],
        cwd: entry.packageRoot,
        sandbox: {
          kind: "canvas-export",
          runtime: runtime.kind,
          instanceId: "review",
          packageRoot: entry.packageRoot,
          temporaryDirectory: "/private/tmp/export",
          workerEntryPoint: worker,
        },
      } as const;
      expect(await store.authorizeRuntimeLaunch(input)).toBe(true);
      expect(await store.authorizeRuntimeLaunch({ ...input, args: [entry.entryPoint] })).toBe(
        false,
      );
      expect(await store.authorizeRuntimeLaunch({ ...input, sandbox: undefined })).toBe(false);
      expect(
        await store.authorizeRuntimeLaunch({
          ...input,
          args: ["/host/other.mjs", entry.entryPoint],
        }),
      ).toBe(false);
      expect(await store.verifiedEntryPoint(target, "export")).toBeUndefined();
    } finally {
      const writable = async (path: string): Promise<void> => {
        await chmod(path, 0o700);
        for (const entry of await readdir(path, { withFileTypes: true })) {
          if (entry.isDirectory()) await writable(join(path, entry.name));
          else await chmod(join(path, entry.name), 0o600);
        }
      };
      await writable(directory);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
