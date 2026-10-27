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
import { gitHistoryMetadata } from "./gitHistoryCheckout";

/** Runs just after the host first looks at a path, so a test can swap it for a link then. */
const looked = vi.hoisted(() => ({ at: (_path: string): void => undefined }));
/** Runs just before the host resolves a path, so a test can swap another path then. */
const resolving = vi.hoisted(() => ({ before: (_path: string): void => undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const result = await actual.lstat(...args);
      looked.at(String(args[0]));
      return result;
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const result = await actual.open(...args);
      looked.at(String(args[0]));
      return result;
    },
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      resolving.before(String(args[0]));
      return await actual.realpath(...args);
    },
  };
});

const directories: Array<string> = [];
afterEach(() => {
  looked.at = () => undefined;
  resolving.before = () => undefined;
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/**
 * A linked worktree record as Git writes it: the checkout's `.git` file names
 * `<common>/worktrees/<name>`, whose `gitdir` names the marker back and whose
 * `commondir` names the common directory.
 */
function linkedWorktree(base: string, name: string) {
  const checkout = join(base, `${name}-checkout`);
  const common = join(base, `${name}-repository`, ".git");
  const gitdir = join(common, "worktrees", name);
  mkdirSync(checkout, { recursive: true });
  mkdirSync(gitdir, { recursive: true });
  writeFileSync(join(checkout, ".git"), `gitdir: ${gitdir}\n`);
  writeFileSync(join(gitdir, "gitdir"), `${join(checkout, ".git")}\n`);
  writeFileSync(join(gitdir, "commondir"), "../..\n");
  return { checkout, common, gitdir };
}

function scratch(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "octant-history-marker-")));
  directories.push(base);
  return base;
}

/** Replaces the checkout's `.git` with a link to `target` the first time the host looks at it. */
function swapMarkerOnceLooked(checkout: string, target: string): void {
  const marker = join(checkout, ".git");
  let swapped = false;
  looked.at = (path) => {
    if (swapped || path !== marker) return;
    swapped = true;
    renameSync(marker, join(checkout, ".git-real"));
    symlinkSync(target, marker);
  };
}

describe("Git metadata a history read may reach", () => {
  it("grants a linked worktree its own gitdir and common directory", async () => {
    const own = linkedWorktree(scratch(), "own");
    await expect(gitHistoryMetadata(own.checkout)).resolves.toEqual([own.gitdir, own.common]);
  });

  // The marker sits in the agent-writable checkout. It passed the first look
  // as a regular file, was then swapped for a link to another repository's
  // linked-worktree marker, and the pointer read and the reciprocity check
  // both followed the link, so that repository's metadata was granted.
  it("never grants another repository's metadata when the marker is swapped for a link after the first look", async () => {
    const base = scratch();
    const own = linkedWorktree(base, "own");
    const host = linkedWorktree(base, "host");
    swapMarkerOnceLooked(own.checkout, join(host.checkout, ".git"));
    const granted = await gitHistoryMetadata(own.checkout);
    expect(granted ?? []).not.toContain(host.common);
    expect(granted ?? []).not.toContain(host.gitdir);
  });

  // The agent writes the marker, so it can name another repository's
  // linked-worktree record outright; that record's backlink names the other
  // checkout's marker. Resolving this marker again for the reciprocity check,
  // after it was read and then swapped for a link to that other marker, made
  // the two sides agree.
  it("never grants another repository's metadata when the marker names it and is swapped for a link after being read", async () => {
    const base = scratch();
    const own = linkedWorktree(base, "own");
    const host = linkedWorktree(base, "host");
    const marker = join(own.checkout, ".git");
    writeFileSync(marker, `gitdir: ${host.gitdir}\n`);
    let swapped = false;
    resolving.before = (path) => {
      if (swapped || path !== host.gitdir) return;
      swapped = true;
      renameSync(marker, join(own.checkout, ".git-real"));
      symlinkSync(join(host.checkout, ".git"), marker);
    };
    await expect(gitHistoryMetadata(own.checkout)).resolves.toBeUndefined();
    expect(swapped).toBe(true);
  });

  it("never grants another repository's .git directory when the marker is swapped for a link after the first look", async () => {
    const base = scratch();
    const checkout = join(base, "checkout");
    const host = join(base, "host-repository", ".git");
    mkdirSync(join(checkout, ".git"), { recursive: true });
    mkdirSync(host, { recursive: true });
    swapMarkerOnceLooked(checkout, host);
    const granted = await gitHistoryMetadata(checkout);
    expect(granted ?? []).not.toContain(host);
  });
});
