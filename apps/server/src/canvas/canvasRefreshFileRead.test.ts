import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { liveWorkFilesystem } from "../work/workFilesystemPort";
import { resolveConfinedPath } from "../preview/previewTargetRegistry";
import { readCanvasRefreshFile, resolveCanvasRefreshFile } from "./canvasRefreshFileRead";

const INSIDE_TEXT = "inside the checkout\n";
const OUTSIDE_TEXT = "a file the Canvas was never authorized to read\n";
const MAX_BYTES = 4096;

const digestOf = (text: string): string => createHash("sha256").update(text).digest("hex");

const created: string[] = [];

afterEach(async () => {
  for (const directory of created.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * A real checkout with a real file beside a real directory outside it, so the
 * swaps below are the host's own semantics rather than a fake's opinion of
 * them. `realpath` first because a temporary directory is itself often a link.
 */
async function checkout(): Promise<{ readonly root: string; readonly outside: string }> {
  const base = await realpath(await mkdtemp(join(tmpdir(), "octant-canvas-refresh-read-")));
  created.push(base);
  const root = join(base, "checkout");
  const outside = join(base, "elsewhere");
  await mkdir(join(root, "notes"), { recursive: true });
  await mkdir(join(outside, "notes"), { recursive: true });
  await writeFile(join(root, "notes", "plan.md"), INSIDE_TEXT);
  await writeFile(join(outside, "notes", "plan.md"), OUTSIDE_TEXT);
  return { root, outside };
}

/** The containment sequence the Canvas refresh port runs, and nothing more. */
async function resolved(root: string, relativePath: string) {
  const confined = resolveConfinedPath(root, relativePath);
  expect(confined.ok).toBe(true);
  if (!confined.ok) throw new Error("unreachable");
  return await resolveCanvasRefreshFile(liveWorkFilesystem, {
    absolutePath: confined.absolutePath,
    displayName: "plan.md",
    relativePath,
  });
}

const read = async (
  file: NonNullable<Awaited<ReturnType<typeof resolved>>>,
  maxBytes = MAX_BYTES,
) => await readCanvasRefreshFile({ filesystem: liveWorkFilesystem, file, maxBytes });

describe("canvas refresh confined file read", () => {
  it("reports the size and digest of a confined source", async () => {
    const { root } = await checkout();
    const file = await resolved(root, "notes/plan.md");
    expect(file).toBeDefined();
    if (file === undefined) return;
    expect(await read(file)).toEqual({
      kind: "content",
      byteLength: INSIDE_TEXT.length,
      contentSha256: digestOf(INSIDE_TEXT),
    });
  });

  it("refuses a source whose ancestor became a symlink out of the checkout", async () => {
    const { root, outside } = await checkout();
    const file = await resolved(root, "notes/plan.md");
    expect(file).toBeDefined();
    if (file === undefined) return;
    // The window the port used to leave open: containment has approved this
    // name, and a racing checkout now points an ancestor of it somewhere else.
    await rename(join(root, "notes"), join(root, "notes.moved"));
    await symlink(join(outside, "notes"), join(root, "notes"));
    expect(await read(file)).toEqual({ kind: "unreadable" });
  });

  it("refuses a source replaced by a different object after containment resolved it", async () => {
    const { root } = await checkout();
    const file = await resolved(root, "notes/plan.md");
    expect(file).toBeDefined();
    if (file === undefined) return;
    await writeFile(join(root, "notes", "other.md"), OUTSIDE_TEXT);
    await rename(join(root, "notes", "other.md"), join(root, "notes", "plan.md"));
    expect(await read(file)).toEqual({ kind: "unreadable" });
  });

  it("refuses a source larger than the refresh ceiling", async () => {
    const { root } = await checkout();
    const file = await resolved(root, "notes/plan.md");
    expect(file).toBeDefined();
    if (file === undefined) return;
    expect(await read(file, INSIDE_TEXT.length - 1)).toEqual({ kind: "oversized" });
  });

  it("refuses a source that grew past the ceiling after it was measured", async () => {
    const { root } = await checkout();
    const file = await resolved(root, "notes/plan.md");
    expect(file).toBeDefined();
    if (file === undefined) return;
    // Appending keeps the object's identity, so only a bound taken from the
    // handle can still refuse it.
    await appendFile(join(root, "notes", "plan.md"), "x".repeat(MAX_BYTES));
    const content = await read(file, INSIDE_TEXT.length + 1);
    expect(content.kind).not.toBe("content");
  });

  it("refuses to resolve a source that is a symlink or is gone", async () => {
    const { root, outside } = await checkout();
    await rm(join(root, "notes", "plan.md"));
    await symlink(join(outside, "notes", "plan.md"), join(root, "notes", "plan.md"));
    expect(
      await resolveCanvasRefreshFile(liveWorkFilesystem, {
        absolutePath: join(root, "notes", "plan.md"),
        displayName: "plan.md",
        relativePath: "notes/plan.md",
      }),
    ).toBeUndefined();
    expect(
      await resolveCanvasRefreshFile(liveWorkFilesystem, {
        absolutePath: join(root, "notes", "missing.md"),
        displayName: "missing.md",
        relativePath: "notes/missing.md",
      }),
    ).toBeUndefined();
  });
});
