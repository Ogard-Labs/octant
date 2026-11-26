import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { changedCalledTools, manifestContract, pinnedFiles } from "./computer-use-driver-pin";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const pin = {
  version: "0.70.2",
  sha256: "b".repeat(64),
  assetId: 123,
  assetBytes: 456,
  contract: { major: 0, minor: 11 },
};

describe("moving the bundled computer-use driver pin", () => {
  it("moves every pinned value in the repository's own files to the new release", () => {
    const files = new Map(pinnedFiles(read, pin).map((file) => [file.path, file.text]));
    expect(files.get("apps/desktop/package.json")).toContain('"@trycua/cua-driver": "0.70.2"');
    expect(files.get("apps/desktop/package.json")).toContain(
      '"@trycua/cua-driver-darwin-arm64": "0.70.2"',
    );
    expect(files.get("package.json")).toContain(
      '"@trycua/cua-driver@0.70.2": "patches/cua-driver-0.70.2.patch"',
    );
    const release = files.get("apps/desktop/src/computerUseDriverRelease.ts");
    expect(release).toContain('version: "0.70.2"');
    expect(release).toContain(
      "cua-driver-rs-v0.70.2/cua-driver-rs-0.70.2-darwin-universal-binary.tar.gz",
    );
    expect(release).toContain(`sha256: "${"b".repeat(64)}"`);
    expect(files.get("apps/desktop/src/computerUseDriverUpdates.ts")).toContain(
      "COMPUTER_DRIVER_CONTRACT = { major: 0, minor: 11 }",
    );
    expect(files.get("scripts/packaged-browser-owner-driver-cache.ts")).toContain(
      "PINNED_DRIVER_ASSET = { id: 123, bytes: 456 }",
    );
  });

  it("refuses to guess when a file no longer holds exactly one pinned value", () => {
    expect(() => pinnedFiles((path) => (path === "package.json" ? "{}" : read(path)), pin)).toThrow(
      "package.json",
    );
  });

  it("names each called driver tool whose published schema changed or vanished", () => {
    const tool = (name: string, input: unknown) => ({
      name,
      input_schema: input,
      success_output_schema: {},
    });
    const pinned = {
      contract_version: "0.9.0",
      tools: [tool("click", { a: 1 }), tool("scroll", {}), tool("type_text", {}), tool("zoom", {})],
    };
    const candidate = {
      contract_version: "0.10.0",
      tools: [tool("click", { a: 2 }), tool("scroll", {}), tool("zoom", { b: 1 })],
    };
    expect(changedCalledTools(pinned, candidate)).toEqual(["click", "type_text"]);
    expect(manifestContract(candidate)).toEqual({ major: 0, minor: 10 });
  });
});
