import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkProjectStatusFiles } from "./workProjectStatusFiles";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function folder(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "octant-work-status-"));
  roots.push(root);
  return root;
}

describe("a Work Project's brief files", () => {
  it("seeds AGENTS.md and STATUS.md once and never rewrites what is there", async () => {
    const root = await folder();
    const files = new WorkProjectStatusFiles();

    expect(await files.seed(root, "Acme offer", "2026-09-12")).toEqual(["AGENTS.md", "STATUS.md"]);
    await writeFile(join(root, "STATUS.md"), "# mine\nLast updated: 2026-09-01\n");
    expect(await files.seed(root, "Acme offer", "2026-09-12")).toEqual([]);

    const snapshot = await files.read(root);
    expect(snapshot.agents?.text).toContain("# Acme offer");
    expect(snapshot.status?.text).toBe("# mine\nLast updated: 2026-09-01\n");
  });

  it("neither writes through nor reads through a symlink under the status name", async () => {
    const root = await folder();
    const elsewhere = await folder();
    await writeFile(join(elsewhere, "secret.md"), "not yours");
    await symlink(join(elsewhere, "secret.md"), join(root, "STATUS.md"));
    const files = new WorkProjectStatusFiles();

    expect(await files.seed(root, "Acme", "2026-09-12")).toEqual(["AGENTS.md"]);
    expect((await files.read(root)).status).toBeUndefined();
    expect(
      await files.appendRecentChange(root, {
        date: "2026-09-12",
        taskTitle: "t",
        paths: ["a.md"],
        truncated: false,
      }),
    ).toBe(false);
    expect(await readFile(join(elsewhere, "secret.md"), "utf8")).toBe("not yours");
  });

  it("appends a turn's changed files to Recent changes in place", async () => {
    const root = await folder();
    const files = new WorkProjectStatusFiles();
    await files.seed(root, "Acme", "2026-09-12");

    expect(
      await files.appendRecentChange(root, {
        date: "2026-09-12",
        taskTitle: "Draft the offer",
        paths: ["offer.docx"],
        truncated: false,
      }),
    ).toBe(true);
    const text = await readFile(join(root, "STATUS.md"), "utf8");
    expect(text).toContain("## Recent changes\n\n- 2026-09-12 Draft the offer: `offer.docx`");
    expect(text).toContain("Last updated: 2026-09-12");
  });
});
