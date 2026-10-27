import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createArtifactMirrorFilePort } from "./artifactMirrorFilePort";

/** Runs just before the port resolves or opens a path, so a test can swap a directory then. */
const resolving = vi.hoisted(() => ({
  before: (_step: "realpath" | "open", _path: string): void => undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    realpath: async (path: string) => {
      resolving.before("realpath", path);
      return await actual.realpath(path);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      resolving.before("open", String(args[0]));
      return await actual.open(...args);
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      resolving.before("open", String(args[0]));
      return await actual.readFile(...args);
    },
  };
});

const directories: Array<string> = [];
afterEach(() => {
  resolving.before = () => undefined;
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/**
 * A checkout holding a mirrored bundle under `docs`, and a host folder with the
 * same relative names, so a read that follows `docs` swapped for a link returns
 * host bytes rather than failing to find them.
 */
function mirroredCheckout() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "octant-mirror-read-")));
  directories.push(base);
  const root = join(base, "checkout");
  const outside = join(base, "outside");
  mkdirSync(join(root, "docs", "artifacts"), { recursive: true });
  mkdirSync(join(outside, "artifacts"), { recursive: true });
  writeFileSync(join(root, "docs", "artifacts", "plan.octant.json"), "mirrored bundle");
  writeFileSync(join(outside, "artifacts", "plan.octant.json"), "host secret");
  return {
    root,
    bundle: join(root, "docs", "artifacts", "plan.octant.json"),
    toLink: () => {
      renameSync(join(root, "docs"), join(root, "docs-real"));
      symlinkSync(outside, join(root, "docs"));
    },
  };
}

describe("reading a mirrored bundle back from an agent-writable root", () => {
  it("reads the bundle the mirror wrote", async () => {
    const checkout = mirroredCheckout();
    await expect(createArtifactMirrorFilePort().read(checkout.bundle, checkout.root)).resolves.toBe(
      "mirrored bundle",
    );
  });

  // Re-import reads the bundle at the path the mirror last wrote. An agent in
  // the checkout can rename `docs` and leave a link to a host folder holding
  // the same names; a plain read followed it and handed host bytes to re-import.
  it("refuses a bundle whose ancestor is already a link to a host folder", async () => {
    const checkout = mirroredCheckout();
    checkout.toLink();
    await expect(
      createArtifactMirrorFilePort().read(checkout.bundle, checkout.root),
    ).resolves.toBeUndefined();
  });

  it.each(["realpath", "open"] as const)(
    "refuses a bundle whose ancestor is swapped for a host link before %s",
    async (step) => {
      const checkout = mirroredCheckout();
      let swapped = false;
      resolving.before = (current, path) => {
        if (swapped || current !== step || !path.startsWith(join(checkout.root, "docs"))) return;
        swapped = true;
        checkout.toLink();
      };
      await expect(
        createArtifactMirrorFilePort().read(checkout.bundle, checkout.root),
      ).resolves.toBeUndefined();
    },
  );
});
