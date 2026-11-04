import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createPackageWithOptions, getRawHeader, statFile } from "@electron/asar";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { desktopIdentity } from "@octant/host-runtime";
import { describe, expect, it } from "vitest";
import {
  prepareNightlyRuntimeFuses,
  validateNightlyRuntimeFuses,
  readNightlyArchive,
  NIGHTLY_UNPACKED_FILES,
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
      await expect(validateNightlyRuntimeFuses(binary)).rejects.toThrow("RunAsNode");
      await prepareNightlyRuntimeFuses(binary, desktopIdentity("nightly"));
      await expect(validateNightlyRuntimeFuses(binary)).resolves.toBeUndefined();
      await writeFile(binary, originalWire);
      await expect(validateNightlyRuntimeFuses(binary)).rejects.toThrow("RunAsNode");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves Stable's runtime bytes and refuses a malformed Nightly runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "nightly-fuses-"));
    const binary = join(root, "electron");
    try {
      await writeFile(binary, originalWire);
      await prepareNightlyRuntimeFuses(binary, desktopIdentity("stable"));
      expect(await readFile(binary)).toEqual(originalWire);
      await writeFile(binary, "not an Electron fuse wire");
      await expect(
        prepareNightlyRuntimeFuses(binary, desktopIdentity("nightly")),
      ).rejects.toThrow();
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
    expect(readNightlyArchive(archive, metadata())).toEqual([
      { path: "entry.mjs", content: "export const value = 'fixture';" },
    ]);
    expect(() => readNightlyArchive(archive, {})).toThrow(/integrity/);
    const bytes = await readFile(archive);
    bytes[bytes.length - 2] = 0;
    await writeFile(archive, bytes);
    expect(() => readNightlyArchive(archive, metadata())).toThrow(/entry.mjs/);
    await createPackageWithOptions(stage, archive, { unpack: "*.mjs" });
    expect(() => readNightlyArchive(archive, metadata())).toThrow(/unpacked/);
    const nativePath = NIGHTLY_UNPACKED_FILES[0];
    await mkdir(join(stage, nativePath, ".."), { recursive: true });
    await writeFile(join(stage, nativePath), "native fixture");
    await createPackageWithOptions(stage, archive, {
      unpack: `**/{${NIGHTLY_UNPACKED_FILES.join(",")}}`,
    });
    expect(readNightlyArchive(archive, metadata()).map((entry) => entry.path)).toContain(
      nativePath,
    );
    expect(statFile(archive, "entry.mjs")).not.toHaveProperty("unpacked", true);
    expect(statFile(archive, nativePath)).toHaveProperty("unpacked", true);
    await writeFile(`${archive}.unpacked/${nativePath}`, "modified native fixture");
    expect(() => readNightlyArchive(archive, metadata())).toThrow(/mismatched file bytes/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
