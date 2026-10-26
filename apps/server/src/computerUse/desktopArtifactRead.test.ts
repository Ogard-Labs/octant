import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  openDesktopArtifactFile,
  readDesktopArtifact,
  type DesktopArtifactFile,
} from "./desktopArtifactRead";

/** Runs just before the read resolves a path, so a test can swap a directory at that moment. */
const resolving = vi.hoisted(() => ({
  lstat: (_path: string): void => undefined,
  realpath: (_path: string): void => undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: async (path: string) => {
      resolving.lstat(path);
      return actual.lstat(path);
    },
    realpath: async (path: string) => {
      resolving.realpath(path);
      return actual.realpath(path);
    },
  };
});

const directories: Array<string> = [];
afterEach(() => {
  resolving.lstat = () => undefined;
  resolving.realpath = () => undefined;
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function checkoutWith(contents: string): { readonly root: string; readonly file: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "octant-desktop-artifact-")));
  directories.push(root);
  const file = join(root, "app.bin");
  writeFileSync(file, contents);
  return { root, file };
}

/** Opens the real file, then lets `change` alter it on disk after the first chunk is read. */
function changingAfterFirstRead(change: () => void) {
  return async (path: string, flags: number): Promise<DesktopArtifactFile> => {
    const file = await openDesktopArtifactFile(path, flags);
    let reads = 0;
    return {
      ...file,
      read: async (buffer, offset, length, position) => {
        reads += 1;
        // Only the first call returns real bytes, so the read is split and the
        // change lands between its parts.
        const first = reads === 1;
        const result = await file.read(buffer, offset, first ? 1 : length, position);
        if (first) change();
        return result;
      },
    };
  };
}

/** Only Linux names the file an open handle reached, so only there does a read succeed. */
const namesOpenFiles = process.platform === "linux";

describe("desktop artifact read", () => {
  it.runIf(namesOpenFiles)("refuses a file that grows while it is being read", async () => {
    const { root, file } = checkoutWith("built app");
    await expect(
      readDesktopArtifact({
        root,
        path: "app.bin",
        maximumBytes: 1_024,
        openFile: changingAfterFirstRead(() => appendFileSync(file, " and more")),
      }),
    ).resolves.toEqual({ status: "refused", reason: "changed-while-read" });
  });

  it.runIf(namesOpenFiles)("refuses a file that shrinks while it is being read", async () => {
    const { root, file } = checkoutWith("built app");
    await expect(
      readDesktopArtifact({
        root,
        path: "app.bin",
        maximumBytes: 1_024,
        openFile: changingAfterFirstRead(() => truncateSync(file, 2)),
      }),
    ).resolves.toEqual({ status: "refused", reason: "changed-while-read" });
  });

  it.runIf(namesOpenFiles)("reads an unchanged file whole and names its hash", async () => {
    const { root } = checkoutWith("built app");
    await expect(
      readDesktopArtifact({
        root,
        path: "app.bin",
        maximumBytes: 1_024,
        openFile: changingAfterFirstRead(() => undefined),
      }),
    ).resolves.toMatchObject({
      status: "read",
      artifact: { path: "app.bin", name: "app.bin", size: 9 },
      bytes: new TextEncoder().encode("built app"),
    });
  });

  it.runIf(namesOpenFiles)(
    "refuses a file reached through an ancestor swapped for a link between the checks and the open",
    async () => {
      // An agent that can write the checkout flips one directory between a real
      // directory and a link to a host folder it cannot read. Each path check and
      // the open resolve the path afresh, so a flip timed between them makes every
      // check see the checkout while the walk's last step and the open reach the
      // host file. A rename loop wins this race within seconds.
      const base = realpathSync(mkdtempSync(join(tmpdir(), "octant-desktop-artifact-")));
      directories.push(base);
      const root = join(base, "checkout");
      const outside = join(base, "outside");
      mkdirSync(join(root, "dist", "app"), { recursive: true });
      mkdirSync(join(outside, "app"), { recursive: true });
      writeFileSync(join(root, "dist", "app", "app.bin"), "built app");
      writeFileSync(join(outside, "app", "app.bin"), "host secret");
      const walked = join(root, "dist", "app", "app.bin");
      const toLink = () => {
        renameSync(join(root, "dist"), join(root, "dist-real"));
        symlinkSync(outside, join(root, "dist"));
      };
      const toDirectory = () => {
        unlinkSync(join(root, "dist"));
        renameSync(join(root, "dist-real"), join(root, "dist"));
      };
      resolving.lstat = (path) => {
        if (path === walked) toLink();
      };
      resolving.realpath = (path) => {
        if (path === walked) toDirectory();
      };

      await expect(
        readDesktopArtifact({
          root,
          path: "dist/app/app.bin",
          maximumBytes: 1_024,
          openFile: async (path, flags) => {
            toLink();
            return openDesktopArtifactFile(path, flags);
          },
        }),
      ).resolves.toEqual({ status: "refused", reason: "changed-while-read" });
    },
  );

  it("refuses where the platform cannot name the file the handle reached", async () => {
    const { root } = checkoutWith("built app");
    await expect(
      readDesktopArtifact({
        root,
        path: "app.bin",
        maximumBytes: 1_024,
        openFile: async (path, flags) => ({
          ...(await openDesktopArtifactFile(path, flags)),
          location: async () => undefined,
        }),
      }),
    ).resolves.toEqual({ status: "refused", reason: "path-unverifiable" });
  });
});
