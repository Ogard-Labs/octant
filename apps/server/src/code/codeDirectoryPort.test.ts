import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeCodeRelativePath } from "@octant/contracts";
import { readConfinedCodeFile } from "./codeConfinedFileRead";
import {
  liveCodeDirectoryPort,
  liveCodeTestSourcePort,
  type CodeDirectoryPort,
  type CodeTestSourcePort,
} from "./codeDirectoryPort";
import { readContainedDirectoryNames, resolveContainedPath } from "./codePathConfinement";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

// Confinement hands the ports canonical paths, so the fixture resolves its
// root: macOS's tmpdir sits behind the /var -> /private/var link, which the
// open refuses as it would any other link.
async function tempRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "octant-code-directory-")));
  roots.push(root);
  return root;
}

describe("liveCodeDirectoryPort.openDirectory", () => {
  it("reports the opened object's own identity and reads names under a bound", async () => {
    const root = await tempRoot();
    const directory = join(root, "src");
    await mkdir(directory);
    for (const name of ["a.ts", "b.ts", "c.ts"]) await writeFile(join(directory, name), "x");

    const expected = await liveCodeDirectoryPort.lstat(directory);
    const opened = await liveCodeDirectoryPort.openDirectory(directory);
    try {
      // The identity comes from the open handle, which is what a caller
      // compares against the object its containment sequence resolved.
      expect(await opened.stat()).toEqual({
        isDirectory: true,
        device: expected.device,
        inode: expected.inode,
      });

      const first = await opened.read(2);
      const rest = await opened.read(2);
      expect(first).toHaveLength(2);
      expect([...first, ...rest].map((entry) => entry.name).sort()).toEqual([
        "a.ts",
        "b.ts",
        "c.ts",
      ]);
      expect(await opened.read(2)).toEqual([]);
    } finally {
      await opened.close();
    }
  });

  it("refuses a name that is a symlink to a directory", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "real"));
    await writeFile(join(root, "real", "kept.ts"), "x");
    await symlink(join(root, "real"), join(root, "link"));

    // O_NOFOLLOW: a directory name replaced by a link is an error, never a
    // redirected enumeration.
    await expect(liveCodeDirectoryPort.openDirectory(join(root, "link"))).rejects.toThrow();
  });

  it("refuses a name that is not a directory", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "notes.md"), "x");

    await expect(liveCodeDirectoryPort.openDirectory(join(root, "notes.md"))).rejects.toThrow();
  });
});

describe("liveCodeTestSourcePort.openFile", () => {
  // A file swapped for a FIFO between the containment check and the open used
  // to block the open until a writer appeared, stalling the read for good.
  it.skipIf(process.platform === "win32")(
    "opens a FIFO without waiting for a writer, so the caller can refuse it",
    async () => {
      const root = await tempRoot();
      const fifo = join(root, "notes.md");
      execFileSync("mkfifo", [fifo]);

      const opened = await Promise.race([
        liveCodeTestSourcePort.openFile(fifo),
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 2_000)),
      ]);

      expect(opened).not.toBe("blocked");
      if (opened === "blocked") return;
      try {
        expect((await opened.stat()).isFile).toBe(false);
      } finally {
        await opened.close();
      }
    },
  );
});

/** A confinement step a read or listing takes before it trusts a path. */
type ConfinementStep = "lstat" | "realpath" | "stat" | "open";

const confinementSteps: ReadonlyArray<ConfinementStep> = ["lstat", "realpath", "stat", "open"];

/**
 * A checkout whose `dist` directory can be swapped for a link to a host folder
 * holding the same relative names, so a read that follows the swap returns host
 * bytes or host names rather than failing to find them.
 */
async function swappableCheckout() {
  const base = await tempRoot();
  const root = join(base, "checkout");
  const outside = join(base, "outside");
  await mkdir(join(root, "dist", "app"), { recursive: true });
  await mkdir(join(outside, "app"), { recursive: true });
  await writeFile(join(root, "dist", "app", "app.bin"), "built app");
  await writeFile(join(outside, "app", "app.bin"), "host secret");
  await writeFile(join(outside, "app", "host-only.txt"), "host secret");
  return {
    root,
    toLink: async () => {
      await rename(join(root, "dist"), join(root, "dist-real"));
      await symlink(outside, join(root, "dist"));
    },
  };
}

/**
 * The live ports, except that `dist` is swapped for the link the first time
 * `step` is about to run on a path under it. Every later step resolves the
 * path afresh, through the link.
 */
function swappingBefore(
  step: ConfinementStep,
  checkout: { readonly root: string; readonly toLink: () => Promise<void> },
): CodeDirectoryPort & CodeTestSourcePort {
  let swapped = false;
  const at = async (current: ConfinementStep, path: string) => {
    if (swapped || current !== step || !path.startsWith(join(checkout.root, "dist"))) return;
    swapped = true;
    await checkout.toLink();
  };
  return {
    lstat: async (path) => {
      await at("lstat", path);
      return await liveCodeDirectoryPort.lstat(path);
    },
    realpath: async (path) => {
      await at("realpath", path);
      return await liveCodeDirectoryPort.realpath(path);
    },
    stat: async (path) => {
      await at("stat", path);
      return await liveCodeDirectoryPort.stat(path);
    },
    readlink: (path) => liveCodeDirectoryPort.readlink(path),
    openDirectory: async (path) => {
      await at("open", path);
      return await liveCodeDirectoryPort.openDirectory(path);
    },
    openFile: async (path) => {
      await at("open", path);
      return await liveCodeTestSourcePort.openFile(path);
    },
  };
}

describe("an ancestor swapped for a link to a host folder during confinement", () => {
  // Each step resolves the path afresh and O_NOFOLLOW guards only the final
  // component. A swap after `realpath` let `stat` and the open both reach the
  // host object, so the identity check passed and host bytes or names came
  // back; only the open itself can say which path it took.
  it.each(confinementSteps)("refuses a file read when the swap lands before %s", async (step) => {
    const checkout = await swappableCheckout();
    const read = await readConfinedCodeFile({
      port: swappingBefore(step, checkout),
      canonicalRoot: checkout.root,
      relativePath: decodeCodeRelativePath("dist/app/app.bin"),
      maximumBytes: 1_024,
    });
    expect(read.status).toBe("refused");
  });

  // A listing reports each child's kind and size from the identity `stat`, so
  // a `stat` that followed the swapped ancestor put a host file's size in the
  // Files panel even though no byte of it was read.
  it.each(confinementSteps.filter((step) => step !== "open"))(
    "never resolves a host object's metadata when the swap lands before %s",
    async (step) => {
      const checkout = await swappableCheckout();
      const resolved = await resolveContainedPath(
        swappingBefore(step, checkout),
        checkout.root,
        join(checkout.root, "dist", "app", "app.bin"),
      );
      expect(resolved).toBeUndefined();
    },
  );

  it.each(confinementSteps)(
    "refuses a directory listing when the swap lands before %s",
    async (step) => {
      const checkout = await swappableCheckout();
      const port = swappingBefore(step, checkout);
      const resolved = await resolveContainedPath(
        port,
        checkout.root,
        join(checkout.root, "dist", "app"),
      );
      const names =
        resolved === undefined
          ? undefined
          : await readContainedDirectoryNames(port, resolved.canonical, resolved.stat, 10);
      expect(names).toBeUndefined();
    },
  );

  it("still reads and lists the checkout when nothing is swapped", async () => {
    const checkout = await swappableCheckout();
    await expect(
      readConfinedCodeFile({
        port: liveCodeTestSourcePort,
        canonicalRoot: checkout.root,
        relativePath: decodeCodeRelativePath("dist/app/app.bin"),
        maximumBytes: 1_024,
      }),
    ).resolves.toEqual({ status: "read", bytes: new TextEncoder().encode("built app") });
    const resolved = await resolveContainedPath(
      liveCodeDirectoryPort,
      checkout.root,
      join(checkout.root, "dist", "app"),
    );
    expect(resolved).toBeDefined();
    if (resolved === undefined) return;
    await expect(
      readContainedDirectoryNames(liveCodeDirectoryPort, resolved.canonical, resolved.stat, 10),
    ).resolves.toEqual(["app.bin"]);
  });
});
