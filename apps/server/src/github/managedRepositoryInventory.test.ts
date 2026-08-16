import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ManagedRepositoryInventory } from "./managedRepositoryInventory";

const directories: string[] = [];
const requestId = "11111111-1111-4111-8111-111111111111";
const segments = ["github.com", "octant", "octant"] as const;

function createInventory(): { inventory: ManagedRepositoryInventory; root: string } {
  const base = mkdtempSync(join(tmpdir(), "octant-inventory-"));
  directories.push(base);
  const root = join(base, "Octant", "Repositories");
  return { inventory: new ManagedRepositoryInventory({ inventoryPath: root }), root };
}

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

describe("destination derivation", () => {
  it("derives the destination beneath the inventory with a stable digest", async () => {
    const { inventory, root } = createInventory();
    const derived = await inventory.deriveDestination(segments);
    if (derived.status !== "derived") throw new Error("expected derivation");
    expect(derived.destinationPath).toBe(join(root, ...segments));
    expect(derived.inventoryPath).toBe(root);
    expect(derived.digest).toMatch(/^[a-f0-9]{64}$/);
    const again = await inventory.deriveDestination(segments);
    expect(again).toEqual(derived);
  });

  it("refuses traversal or separator segments outright", async () => {
    const { inventory } = createInventory();
    for (const hostile of [
      ["github.com", "..", "octant"],
      ["github.com", "octant", "a/b"],
      ["github.com", "octant", "."],
      ["github.com", "octant", ""],
    ] as const) {
      expect(await inventory.deriveDestination(hostile)).toEqual({
        status: "refused",
        code: "path-confinement",
      });
    }
  });

  it("refuses a symlinked path component instead of following it", async () => {
    const { inventory, root } = createInventory();
    const outside = mkdtempSync(join(tmpdir(), "octant-outside-"));
    directories.push(outside);
    mkdirSync(root, { recursive: true });
    symlinkSync(outside, join(root, "github.com"));
    expect(await inventory.deriveDestination(segments)).toEqual({
      status: "refused",
      code: "path-confinement",
    });
  });

  it("refuses a case-folded collision with an existing sibling", async () => {
    const { inventory, root } = createInventory();
    mkdirSync(join(root, "github.com", "Octant"), { recursive: true });
    expect(await inventory.deriveDestination(segments)).toEqual({
      status: "refused",
      code: "case-fold-collision",
    });
  });

  it("refuses a file standing where a directory component belongs", async () => {
    const { inventory, root } = createInventory();
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "github.com"), "not a directory");
    expect(await inventory.deriveDestination(segments)).toEqual({
      status: "refused",
      code: "path-confinement",
    });
  });

  it("refuses a symlinked inventory root", async () => {
    const base = mkdtempSync(join(tmpdir(), "octant-inventory-"));
    directories.push(base);
    const outside = mkdtempSync(join(tmpdir(), "octant-outside-"));
    directories.push(outside);
    const root = join(base, "Repositories");
    symlinkSync(outside, root);
    const inventory = new ManagedRepositoryInventory({ inventoryPath: root });
    expect(await inventory.deriveDestination(segments)).toEqual({
      status: "refused",
      code: "path-confinement",
    });
  });
});

describe("destination observation", () => {
  it("distinguishes missing, empty, occupied, symlink, and file destinations", async () => {
    const { inventory, root } = createInventory();
    const destination = join(root, ...segments);
    expect(await inventory.observeDestination(destination)).toEqual({ exists: false });

    mkdirSync(destination, { recursive: true });
    expect(await inventory.observeDestination(destination)).toEqual({
      exists: true,
      kind: "directory",
      empty: true,
    });

    writeFileSync(join(destination, "README.md"), "content");
    expect(await inventory.observeDestination(destination)).toEqual({
      exists: true,
      kind: "directory",
      empty: false,
    });

    const filePath = join(root, "github.com", "octant", "file-destination");
    writeFileSync(filePath, "x");
    expect(await inventory.observeDestination(filePath)).toEqual({ exists: true, kind: "file" });

    const linkPath = join(root, "github.com", "octant", "link-destination");
    symlinkSync(destination, linkPath);
    expect(await inventory.observeDestination(linkPath)).toEqual({
      exists: true,
      kind: "symlink",
    });
  });
});

describe("staging lifecycle", () => {
  it("creates one confined staging directory per request and refuses reuse", async () => {
    const { inventory, root } = createInventory();
    const staged = await inventory.ensureStaging(requestId);
    if (staged.status !== "staged") throw new Error("expected staging");
    expect(staged.stagingPath).toBe(join(root, ".octant-incoming", requestId));
    expect(await inventory.stagingExists(requestId)).toBe(true);
    expect(await inventory.ensureStaging(requestId)).toEqual({
      status: "refused",
      code: "destination-collision",
    });
  });

  it("rejects request identifiers that are not canonical UUIDs", async () => {
    const { inventory } = createInventory();
    expect(await inventory.ensureStaging("../escape")).toEqual({
      status: "refused",
      code: "path-confinement",
    });
  });
});

describe("promotion and quarantine", () => {
  it("promotes staging to the destination atomically and refuses replacement", async () => {
    const { inventory, root } = createInventory();
    const derived = await inventory.deriveDestination(segments);
    if (derived.status !== "derived") throw new Error("expected derivation");
    const staged = await inventory.ensureStaging(requestId);
    if (staged.status !== "staged") throw new Error("expected staging");
    writeFileSync(join(staged.stagingPath, "marker"), "content");

    const promoted = await inventory.promote(staged.stagingPath, derived.destinationPath);
    expect(promoted).toMatchObject({ status: "promoted" });
    expect(await inventory.stagingExists(requestId)).toBe(false);
    expect(await inventory.observeDestination(derived.destinationPath)).toEqual({
      exists: true,
      kind: "directory",
      empty: false,
    });

    const second = await inventory.ensureStaging(requestId);
    if (second.status !== "staged") throw new Error("expected staging");
    expect(await inventory.promote(second.stagingPath, derived.destinationPath)).toEqual({
      status: "refused",
      code: "destination-collision",
    });
    expect(join(root, ".octant-incoming", requestId)).toBe(second.stagingPath);
  });

  it("refuses promotion when a destination parent was replaced by a symlink", async () => {
    const { inventory, root } = createInventory();
    const derived = await inventory.deriveDestination(segments);
    if (derived.status !== "derived") throw new Error("expected derivation");
    const staged = await inventory.ensureStaging(requestId);
    if (staged.status !== "staged") throw new Error("expected staging");

    const outside = mkdtempSync(join(tmpdir(), "octant-outside-"));
    directories.push(outside);
    mkdirSync(join(root, "github.com"), { recursive: true });
    symlinkSync(outside, join(root, "github.com", "octant"));

    expect(await inventory.promote(staged.stagingPath, derived.destinationPath)).toEqual({
      status: "refused",
      code: "path-confinement",
    });
  });

  it("refuses to promote a staging path outside the inventory", async () => {
    const { inventory } = createInventory();
    const derived = await inventory.deriveDestination(segments);
    if (derived.status !== "derived") throw new Error("expected derivation");
    const outside = mkdtempSync(join(tmpdir(), "octant-outside-"));
    directories.push(outside);
    expect(await inventory.promote(outside, derived.destinationPath)).toEqual({
      status: "refused",
      code: "path-confinement",
    });
  });

  it("quarantines staging non-destructively with unique names", async () => {
    const { inventory, root } = createInventory();
    const first = await inventory.ensureStaging(requestId);
    if (first.status !== "staged") throw new Error("expected staging");
    writeFileSync(join(first.stagingPath, "partial"), "content");
    const quarantined = await inventory.quarantine(requestId);
    expect(quarantined).toMatchObject({ status: "quarantined" });
    expect(await inventory.stagingExists(requestId)).toBe(false);

    const second = await inventory.ensureStaging(requestId);
    if (second.status !== "staged") throw new Error("expected staging");
    const again = await inventory.quarantine(requestId);
    if (again.status !== "quarantined" || quarantined.status !== "quarantined") {
      throw new Error("expected quarantine");
    }
    expect(again.quarantinePath).not.toBe(quarantined.quarantinePath);
    expect(again.quarantinePath.startsWith(join(root, ".octant-quarantine"))).toBe(true);
  });

  it("reports a missing staging quarantine as already clean", async () => {
    const { inventory } = createInventory();
    expect(await inventory.quarantine(requestId)).toEqual({ status: "clean" });
  });
});
