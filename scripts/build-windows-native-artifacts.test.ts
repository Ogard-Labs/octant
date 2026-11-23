import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import {
  copyValidatedWindowsNativeArtifacts,
  installNodeSdk,
  QA_WINDOWS_PREBUILT_NATIVE_DIR_ENV,
  resolveQaWindowsPrebuiltNativeDirectory,
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
    await writeFile(join(directory, "octant-windows-confine.exe"), pe(false));
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

it("retries a failed Node SDK install in a fresh devdir and proceeds once one succeeds", async () => {
  const stage = await mkdtemp(join(tmpdir(), "octant-native-sdk-test-"));
  const sdk = join(stage, "sdk");
  try {
    const seen: string[][] = [];
    let attempts = 0;
    await installNodeSdk(
      sdk,
      async () => {
        attempts += 1;
        seen.push(await readdir(sdk));
        await writeFile(join(sdk, "partial"), "");
        if (attempts === 1) throw Error("gyp ERR! Completion callback never invoked!");
      },
      async () => undefined,
    );
    expect(attempts).toBe(2);
    // The second attempt starts from an empty devdir, not the partial extract.
    expect(seen).toEqual([[], []]);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
});

it("fails naming the Node SDK install after three failed attempts", async () => {
  const stage = await mkdtemp(join(tmpdir(), "octant-native-sdk-test-"));
  try {
    let attempts = 0;
    const failed = installNodeSdk(
      join(stage, "sdk"),
      async () => {
        attempts += 1;
        throw Error(`attempt ${attempts} failed`);
      },
      async () => undefined,
    );
    await expect(failed).rejects.toThrow(
      "node-gyp install of the Node SDK failed after 3 attempts",
    );
    await expect(failed).rejects.toMatchObject({ cause: { message: "attempt 3 failed" } });
    expect(attempts).toBe(3);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
});

it("reuses prebuilt Windows native artifacts only when all four fixed x64 binaries validate", async () => {
  const stage = await mkdtemp(join(tmpdir(), "octant-native-reuse-test-"));
  const source = join(stage, "source");
  const destination = join(stage, "destination");
  try {
    await expect(copyValidatedWindowsNativeArtifacts(source, destination)).rejects.toThrow();
    await rm(destination, { recursive: true, force: true });
    const fs = await import("node:fs/promises");
    await fs.mkdir(source, { recursive: true });
    await writeFile(join(source, WINDOWS_NATIVE_ARTIFACTS[0]), pe(true));
    await writeFile(join(source, WINDOWS_NATIVE_ARTIFACTS[1]), pe(false));
    await writeFile(join(source, WINDOWS_NATIVE_ARTIFACTS[2]), pe(true));
    await writeFile(join(source, WINDOWS_NATIVE_ARTIFACTS[3]), pe(false));
    await copyValidatedWindowsNativeArtifacts(source, destination);
    expect((await readdir(destination)).sort()).toEqual([...WINDOWS_NATIVE_ARTIFACTS].sort());
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
});

it("refuses prebuilt Windows native reuse on stable, release, or signing builds", () => {
  const dir = join(tmpdir(), "prebuilt-native");
  expect(
    resolveQaWindowsPrebuiltNativeDirectory({
      flavor: "nightly",
      environment: { [QA_WINDOWS_PREBUILT_NATIVE_DIR_ENV]: dir },
    }),
  ).toBe(resolve(dir));
  expect(() =>
    resolveQaWindowsPrebuiltNativeDirectory({
      flavor: "stable",
      environment: { [QA_WINDOWS_PREBUILT_NATIVE_DIR_ENV]: dir },
    }),
  ).toThrow("only permitted for unsigned Nightly QA");
  expect(() =>
    resolveQaWindowsPrebuiltNativeDirectory({
      flavor: "nightly",
      environment: { [QA_WINDOWS_PREBUILT_NATIVE_DIR_ENV]: dir, OCTANT_RELEASE_BUILD: "1" },
    }),
  ).toThrow("OCTANT_RELEASE_BUILD");
  expect(() =>
    resolveQaWindowsPrebuiltNativeDirectory({
      flavor: "nightly",
      environment: { [QA_WINDOWS_PREBUILT_NATIVE_DIR_ENV]: dir, AZURE_CLIENT_ID: "id" },
    }),
  ).toThrow("AZURE_CLIENT_ID");
});
