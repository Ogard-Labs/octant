import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createPackageWithOptions, getRawHeader, statFile } from "@electron/asar";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  prepareDesktopRuntimeFuses,
  validateDesktopRuntimeFuses,
  readDesktopArchive,
  DESKTOP_UNPACKED_FILES,
  validateNodeRuntimeFuses,
} from "./desktop-client-runtime";

// Public fuse-wire format with the states observed in the pinned runtime.
const originalWire = Buffer.concat([
  Buffer.from("fixture-dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX"),
  Buffer.from([1, 9]),
  Buffer.from("101100011"),
]);

describe("Nightly runtime entry restrictions", () => {
  it("refuses the alternate-entry defaults and verifies the official writer's resulting restrictions", async () => {
    const root = await mkdtemp(join(tmpdir(), "nightly-fuses-"));
    const binary = join(root, "electron");
    try {
      await writeFile(binary, originalWire);
      await expect(validateDesktopRuntimeFuses(binary)).rejects.toThrow("RunAsNode");
      await prepareDesktopRuntimeFuses(binary);
      await expect(validateDesktopRuntimeFuses(binary)).resolves.toBeUndefined();
      await writeFile(binary, originalWire);
      await expect(validateDesktopRuntimeFuses(binary)).rejects.toThrow("RunAsNode");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps worker Node support distinct from the sealed desktop and refuses malformed binaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "nightly-fuses-"));
    const binary = join(root, "electron");
    try {
      await writeFile(binary, originalWire);
      await validateNodeRuntimeFuses(binary);
      expect(await readFile(binary)).toEqual(originalWire);
      await prepareDesktopRuntimeFuses(binary);
      await expect(validateNodeRuntimeFuses(binary)).rejects.toThrow("required Node entry");
      await writeFile(binary, "not an Electron fuse wire");
      await expect(prepareDesktopRuntimeFuses(binary)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

it("verifies sealed application bytes and refuses loose JavaScript or mismatched integrity", async () => {
  const root = await mkdtemp(join(tmpdir(), "nightly-archive-"));
  try {
    const stage = join(root, "stage");
    await mkdir(stage);
    await writeFile(join(stage, "entry.mjs"), "export const value = 'fixture';");
    const archive = join(root, "app.asar");
    const metadata = () => ({
      "Resources/app.asar": {
        algorithm: "SHA256",
        hash: createHash("sha256").update(getRawHeader(archive).headerString).digest("hex"),
      },
    });
    await createPackageWithOptions(stage, archive, {});
    expect(readDesktopArchive(archive, metadata())).toEqual([
      { path: "entry.mjs", content: "export const value = 'fixture';" },
    ]);
    expect(() => readDesktopArchive(archive, {})).toThrow(/integrity/);
    const bytes = await readFile(archive);
    bytes[bytes.length - 2] = 0;
    await writeFile(archive, bytes);
    expect(() => readDesktopArchive(archive, metadata())).toThrow(/entry.mjs/);
    await createPackageWithOptions(stage, archive, { unpack: "*.mjs" });
    expect(() => readDesktopArchive(archive, metadata())).toThrow(/unpacked/);
    const nativePath = DESKTOP_UNPACKED_FILES[0];
    await mkdir(join(stage, nativePath, ".."), { recursive: true });
    await writeFile(join(stage, nativePath), "native fixture");
    await createPackageWithOptions(stage, archive, {
      unpack: `**/{${DESKTOP_UNPACKED_FILES.join(",")}}`,
    });
    expect(readDesktopArchive(archive, metadata()).map((entry) => entry.path)).toContain(
      nativePath,
    );
    expect(statFile(archive, "entry.mjs")).not.toHaveProperty("unpacked", true);
    expect(statFile(archive, nativePath)).toHaveProperty("unpacked", true);
    await writeFile(`${archive}.unpacked/${nativePath}`, "modified native fixture");
    expect(() => readDesktopArchive(archive, metadata())).toThrow(/mismatched file bytes/);
    expect(readDesktopArchive(archive, metadata(), "signed").map((entry) => entry.path)).toContain(
      nativePath,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
