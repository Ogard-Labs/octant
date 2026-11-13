import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { projectTypeScriptServerBinary } from "./projectTypeScriptToolchain";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function folder(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "octant-project-toolchain-")));
  roots.push(root);
  return root;
}

function binaryAt(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, 0o755);
  return path;
}

const native = join("@typescript", "typescript-linux-x64", "lib", "tsc");
const find = (root: string) => projectTypeScriptServerBinary(root, "linux", "x64");

describe("the Project's own TypeScript language server", () => {
  it("is the native binary the checkout's own install holds, hoisted or beside a linked package", async () => {
    const hoisted = folder();
    const binary = binaryAt(join(hoisted, "node_modules", native));
    expect(await find(hoisted)).toBe(binary);

    // A linking installer keeps each package in a store inside node_modules
    // and links `typescript` to it, with the native package beside it there.
    const linked = folder();
    const store = join(linked, "node_modules", ".store", "typescript@7", "node_modules");
    const stored = binaryAt(join(store, native));
    mkdirSync(join(store, "typescript"), { recursive: true });
    symlinkSync(join(store, "typescript"), join(linked, "node_modules", "typescript"));
    expect(await find(linked)).toBe(stored);
  });

  it("is nothing when the checkout holds no native copy, or holds one for another platform", async () => {
    const root = folder();
    expect(await find(root)).toBeUndefined();
    mkdirSync(join(root, "node_modules", "typescript", "lib"), { recursive: true });
    writeFileSync(join(root, "node_modules", "typescript", "lib", "tsc.js"), "");
    binaryAt(join(root, "node_modules", "@typescript", "typescript-darwin-arm64", "lib", "tsc"));
    expect(await find(root)).toBeUndefined();
  });

  it("never names a binary outside the checkout, however the checkout links to it", async () => {
    const root = folder();
    const outside = folder();
    binaryAt(join(outside, native));
    mkdirSync(join(root, "node_modules"), { recursive: true });
    symlinkSync(join(outside, "@typescript"), join(root, "node_modules", "@typescript"));
    expect(await find(root)).toBeUndefined();

    const linked = folder();
    mkdirSync(join(outside, "typescript"), { recursive: true });
    mkdirSync(join(linked, "node_modules"), { recursive: true });
    symlinkSync(join(outside, "typescript"), join(linked, "node_modules", "typescript"));
    expect(await find(linked)).toBeUndefined();
  });
});
