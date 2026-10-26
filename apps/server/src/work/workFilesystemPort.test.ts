import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { readFile, rename, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readConfinedWorkFile } from "./workConfinedRead";
import { writeConfinedWorkFile } from "./workConfinedWrite";
import { liveWorkFilesystem, type WorkFilesystemPort } from "./workFilesystemPort";
import { readContainedWorkDirectoryNames, resolveContainedWorkPath } from "./workPathConfinement";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Resolution hands the port canonical paths, so the fixture resolves its root:
// macOS's tmpdir sits behind the /var → /private/var symlink, which the
// darwin child-open guard would otherwise (correctly) refuse.
function fixture(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "octant-work-filesystem-")));
  directories.push(root);
  return root;
}

describe("live Work filesystem directory chain", () => {
  it("creates nested children through a proven parent directory on the host filesystem", async () => {
    const root = fixture();
    const parent = await liveWorkFilesystem.openDirectory(root);
    try {
      await parent.mkdir("reports");
      const reports = await parent.openDirectory("reports");
      try {
        expect((await reports.stat()).isDirectory).toBe(true);
        const file = await reports.openWriteFile("summary.txt", { exclusiveCreate: true });
        await file.write(new TextEncoder().encode("confined bytes"));
        await file.close();
      } finally {
        await reports.close();
      }
    } finally {
      await parent.close();
    }
    expect(new TextDecoder().decode(await readFile(join(root, "reports", "summary.txt")))).toBe(
      "confined bytes",
    );
  });

  it("refuses a child entry that is a symlink or a traversing name", async () => {
    const root = fixture();
    const outside = fixture();
    mkdirSync(join(root, "inside"));
    symlinkSync(outside, join(root, "escape"));
    const parent = await liveWorkFilesystem.openDirectory(root);
    try {
      await expect(parent.openDirectory("escape")).rejects.toThrow();
      await expect(parent.openWriteFile("escape", { exclusiveCreate: false })).rejects.toThrow();
      await expect(parent.openDirectory("../inside")).rejects.toThrow();
      await expect(parent.mkdir("..")).rejects.toThrow();
    } finally {
      await parent.close();
    }
  });

  it("never creates a directory outside the root when the proven parent name is swapped", async () => {
    const root = fixture();
    const outside = fixture();
    mkdirSync(join(root, "a"));

    const proven = await liveWorkFilesystem.openDirectory(join(root, "a"));
    try {
      await rename(join(root, "a"), join(root, "a-moved"));
      symlinkSync(outside, join(root, "a"));

      // Linux creates through the held object, so the child lands inside the
      // moved original; macOS refuses the swapped name outright. Neither may
      // leave anything under the swap target.
      if (process.platform === "linux") {
        await proven.mkdir("child");
        const created = await stat(join(root, "a-moved", "child"), { bigint: true });
        expect(created.isDirectory()).toBe(true);
      } else {
        await expect(proven.mkdir("child")).rejects.toThrow("moved parent");
        await expect(stat(join(root, "a-moved", "child"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
      await expect(stat(join(outside, "child"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await proven.close();
    }
  });

  it("never opens a decoy behind an ancestor swapped in after the parent was proven", async () => {
    const root = fixture();
    const outside = fixture();
    mkdirSync(join(root, "a", "b"), { recursive: true });
    mkdirSync(join(outside, "b"));
    const original = await stat(join(root, "a", "b"), { bigint: true });
    const decoy = await stat(join(outside, "b"), { bigint: true });

    const proven = await liveWorkFilesystem.openDirectory(join(root, "a"));
    try {
      await rename(join(root, "a"), join(root, "a-moved"));
      symlinkSync(outside, join(root, "a"));

      // Linux resolves the child against the held directory object and finds
      // the moved original; macOS refuses the symlinked ancestor outright.
      // Either way the swapped-in decoy must never answer.
      let opened;
      try {
        opened = await proven.openDirectory("b");
      } catch {
        return;
      }
      try {
        const identity = await opened.stat();
        expect(identity.device).toBe(String(original.dev));
        expect(identity.inode).toBe(String(original.ino));
        expect(identity.device === String(decoy.dev) && identity.inode === String(decoy.ino)).toBe(
          false,
        );
      } finally {
        await opened.close();
      }
    } finally {
      await proven.close();
    }
  });
});

describe("live Work filesystem file open", () => {
  // A file swapped for a FIFO between the containment check and the open used
  // to block the open until a writer appeared, stalling the read for good.
  it.skipIf(process.platform === "win32")(
    "opens a FIFO without waiting for a writer, so the caller can refuse it",
    async () => {
      const fifo = join(fixture(), "notes.md");
      execFileSync("mkfifo", [fifo]);

      const opened = await Promise.race([
        liveWorkFilesystem.openFile(fifo),
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

describe("live Work filesystem file overwrite", () => {
  // An overwrite opens an existing name without O_CREAT, so a FIFO swapped in
  // after the containment check used to hold the open until a reader appeared.
  it.skipIf(process.platform === "win32")(
    "refuses to overwrite a FIFO without waiting for a reader",
    async () => {
      const fifo = join(fixture(), "notes.md");
      execFileSync("mkfifo", [fifo]);

      const opened = await Promise.race([
        liveWorkFilesystem.openWriteFile(fifo, { exclusiveCreate: false }).then(
          async (file) => {
            await file.close();
            return "opened" as const;
          },
          () => "refused" as const,
        ),
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 2_000)),
      ]);

      expect(opened).toBe("refused");
    },
  );
});

/** A confinement step a read, listing, or overwrite takes before it trusts a path. */
type ConfinementStep = "lstat" | "realpath" | "stat" | "open";

const confinementSteps: ReadonlyArray<ConfinementStep> = ["lstat", "realpath", "stat", "open"];

/**
 * A Project folder whose `dist` directory can be swapped for a link to a host
 * folder holding the same relative names, and the live port, except that the
 * swap happens the first time `step` is about to run on a path under `dist`.
 * Every later step resolves the path afresh, through the link.
 */
function swappingBefore(step: ConfinementStep) {
  const base = fixture();
  const root = join(base, "project");
  const outside = join(base, "outside");
  mkdirSync(join(root, "dist", "app"), { recursive: true });
  mkdirSync(join(outside, "app"), { recursive: true });
  writeFileSync(join(root, "dist", "app", "app.bin"), "built app");
  writeFileSync(join(outside, "app", "app.bin"), "host secret");
  writeFileSync(join(outside, "app", "host-only.txt"), "host secret");
  let swapped = false;
  const at = (current: ConfinementStep, path: string) => {
    if (swapped || current !== step || !path.startsWith(join(root, "dist"))) return;
    swapped = true;
    renameSync(join(root, "dist"), join(root, "dist-real"));
    symlinkSync(outside, join(root, "dist"));
  };
  const filesystem: WorkFilesystemPort = {
    ...liveWorkFilesystem,
    lstat: async (path) => {
      at("lstat", path);
      return await liveWorkFilesystem.lstat(path);
    },
    realpath: async (path) => {
      at("realpath", path);
      return await liveWorkFilesystem.realpath(path);
    },
    stat: async (path) => {
      at("stat", path);
      return await liveWorkFilesystem.stat(path);
    },
    openFile: async (path) => {
      at("open", path);
      return await liveWorkFilesystem.openFile(path);
    },
    openDirectory: async (path) => {
      at("open", path);
      return await liveWorkFilesystem.openDirectory(path);
    },
    openWriteFile: async (path, options) => {
      at("open", path);
      return await liveWorkFilesystem.openWriteFile(path, options);
    },
  };
  return { root, outside, filesystem };
}

describe("an ancestor swapped for a link to a host folder during Work confinement", () => {
  // Each step resolves the path afresh and O_NOFOLLOW guards only the final
  // component. A swap after `realpath` let `stat` and the open both reach the
  // host object, so the identity check passed; only the open itself can say
  // which path it took.
  it.each(confinementSteps)("refuses a file read when the swap lands before %s", async (step) => {
    const { root, filesystem } = swappingBefore(step);
    const resolved = await resolveContainedWorkPath(
      filesystem,
      root,
      join(root, "dist", "app", "app.bin"),
    );
    const bytes =
      resolved === undefined
        ? undefined
        : await readConfinedWorkFile({
            filesystem,
            canonicalPath: resolved.canonical,
            expected: resolved.stat,
            maximumBytes: 1_024,
          });
    expect(bytes).toBeUndefined();
  });

  // A listing reports each child's kind and size from the identity `stat`, so
  // a `stat` that followed the swapped ancestor put a host file's size in the
  // Files panel even though no byte of it was read.
  it.each(confinementSteps.filter((step) => step !== "open"))(
    "never resolves a host object's metadata when the swap lands before %s",
    async (step) => {
      const { root, filesystem } = swappingBefore(step);
      await expect(
        resolveContainedWorkPath(filesystem, root, join(root, "dist", "app", "app.bin")),
      ).resolves.toBeUndefined();
    },
  );

  it.each(confinementSteps)(
    "refuses a directory listing when the swap lands before %s",
    async (step) => {
      const { root, filesystem } = swappingBefore(step);
      const resolved = await resolveContainedWorkPath(filesystem, root, join(root, "dist", "app"));
      const names =
        resolved === undefined
          ? undefined
          : await readContainedWorkDirectoryNames(
              filesystem,
              resolved.canonical,
              resolved.stat,
              10,
            );
      expect(names).toBeUndefined();
    },
  );

  it.each(confinementSteps)(
    "never overwrites the host file when the swap lands before %s",
    async (step) => {
      const { root, outside, filesystem } = swappingBefore(step);
      const resolved = await resolveContainedWorkPath(
        filesystem,
        root,
        join(root, "dist", "app", "app.bin"),
      );
      if (resolved !== undefined) {
        await writeConfinedWorkFile({
          filesystem,
          canonicalPath: resolved.canonical,
          expected: resolved.stat,
          allowCreate: false,
          bytes: new TextEncoder().encode("agent bytes"),
        });
      }
      expect(readFileSync(join(outside, "app", "app.bin"), "utf8")).toBe("host secret");
    },
  );

  it("still reads, lists, and overwrites the folder when nothing is swapped", async () => {
    const { root } = swappingBefore("open");
    const file = await resolveContainedWorkPath(
      liveWorkFilesystem,
      root,
      join(root, "dist", "app", "app.bin"),
    );
    expect(file).toBeDefined();
    if (file === undefined) return;
    const bytes = await readConfinedWorkFile({
      filesystem: liveWorkFilesystem,
      canonicalPath: file.canonical,
      expected: file.stat,
      maximumBytes: 1_024,
    });
    expect(bytes).toEqual(new TextEncoder().encode("built app"));
    const directory = await resolveContainedWorkPath(
      liveWorkFilesystem,
      root,
      join(root, "dist", "app"),
    );
    expect(directory).toBeDefined();
    if (directory === undefined) return;
    await expect(
      readContainedWorkDirectoryNames(liveWorkFilesystem, directory.canonical, directory.stat, 10),
    ).resolves.toEqual(["app.bin"]);
    await expect(
      writeConfinedWorkFile({
        filesystem: liveWorkFilesystem,
        canonicalPath: file.canonical,
        expected: file.stat,
        allowCreate: false,
        bytes: new TextEncoder().encode("rebuilt app"),
      }),
    ).resolves.toBe(true);
    expect(readFileSync(join(root, "dist", "app", "app.bin"), "utf8")).toBe("rebuilt app");
  });
});
