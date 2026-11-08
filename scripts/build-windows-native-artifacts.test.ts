import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  validateWindowsNativeArtifacts,
  WINDOWS_NATIVE_ARTIFACTS,
} from "./build-windows-native-artifacts";

function pe(dll: boolean) {
  const bytes = Buffer.alloc(128);
  bytes.write("MZ");
  bytes.writeUInt32LE(64, 60);
  bytes.write("PE\0\0", 64);
  bytes.writeUInt16LE(0x8664, 68);
  bytes.writeUInt16LE(dll ? 0x2000 : 0, 86);
  return bytes;
}

it("refuses missing, foreign-architecture and QA-only native resources before archiving", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octant-native-artifact-test-"));
  const owner = join(directory, WINDOWS_NATIVE_ARTIFACTS[0]);
  const helper = join(directory, WINDOWS_NATIVE_ARTIFACTS[1]);
  try {
    await writeFile(owner, pe(true));
    await expect(validateWindowsNativeArtifacts(directory)).rejects.toThrow(
      "fixed runtime artifacts",
    );
    await writeFile(helper, pe(false));
    await writeFile(join(directory, "octant-desktop-peer-windows.node"), pe(true));
    await expect(validateWindowsNativeArtifacts(directory)).resolves.toBeUndefined();
    const arm = pe(true);
    arm.writeUInt16LE(0xaa64, 68);
    await writeFile(owner, arm);
    await expect(validateWindowsNativeArtifacts(directory)).rejects.toThrow("expected x64 PE");
    await writeFile(owner, pe(true));
    await writeFile(helper, pe(true));
    await expect(validateWindowsNativeArtifacts(directory)).rejects.toThrow("expected x64 PE");
    await writeFile(helper, pe(false));
    await writeFile(join(directory, "octant-windows-owner-reader.exe"), pe(false));
    await expect(validateWindowsNativeArtifacts(directory)).rejects.toThrow(
      "fixed runtime artifacts",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
