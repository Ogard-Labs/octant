import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { keychainHelperBuildArgs, shouldBuildKeychainHelper } from "./build-keychain-helper";

const repositoryRoot = resolve(import.meta.dirname, "..");

describe("keychainHelperBuildArgs", () => {
  it("builds the Security.framework helper deterministically", () => {
    expect(keychainHelperBuildArgs("/repo/helper.swift", "/repo/dist/helper")).toEqual([
      "swiftc",
      "-O",
      "-framework",
      "Security",
      "-o",
      "/repo/dist/helper",
      "/repo/helper.swift",
    ]);
  });

  it("skips the Swift Keychain helper off macOS so Linux builds do not require swiftc", () => {
    expect(shouldBuildKeychainHelper("darwin")).toBe(true);
    expect(shouldBuildKeychainHelper("linux")).toBe(false);
    expect(shouldBuildKeychainHelper("win32")).toBe(false);
  });

  it("compiles the helper after tsdown cleans the desktop dist directory", async () => {
    const desktopPackage = JSON.parse(
      await readFile(resolve(repositoryRoot, "apps/desktop/package.json"), "utf8"),
    ) as { readonly scripts: { readonly build: string } };

    expect(desktopPackage.scripts.build).toBe(
      "tsdown && bun ../../scripts/build-keychain-helper.ts && bun ../../scripts/build-code-file-helper.ts",
    );
  });

  it("clears mutable Swift buffers before terminating instead of relying on defer", async () => {
    const source = await readFile(
      resolve(repositoryRoot, "apps/desktop/native/keychain-helper/OctantKeychainHelper.swift"),
      "utf8",
    );

    expect(source).not.toContain("defer {");
    expect(source).toContain("input.resetBytes(in: 0..<input.count)");
    // More clears than the original two success-path sites remain correct.
    expect(
      source.match(/credentialData\.resetBytes\(in: 0\.\.<credentialData\.count\)/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(2);
  });
});
