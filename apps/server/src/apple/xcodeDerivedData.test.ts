import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createXcodeDerivedData } from "./xcodeDerivedData";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const now = Date.parse("2026-11-11T12:00:00Z");
const daysAgo = (days: number) => new Date(now - days * 24 * 60 * 60 * 1000).toISOString();

async function entry(root: string, name: string, workspace: string, accessed: string) {
  await mkdir(join(root, name, "Build"), { recursive: true });
  await writeFile(join(root, name, "Build", "app.o"), "x".repeat(100));
  await writeFile(
    join(root, name, "info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>LastAccessedDate</key><date>${accessed}</date>
<key>WorkspacePath</key><string>${workspace}</string>
</dict></plist>`,
  );
}

describe("Xcode build data", () => {
  it("offers builds whose workspace is gone or that Xcode has not opened for 30 days", async () => {
    const base = await mkdtemp(join(tmpdir(), "octant-derived-"));
    directories.push(base);
    const root = join(base, "DerivedData");
    const project = join(base, "App.xcodeproj");
    await mkdir(project, { recursive: true });
    await entry(root, "Gone-abc", join(base, "deleted-worktree", "App.xcodeproj"), daysAgo(1));
    await entry(root, "Old-def", project, daysAgo(60));
    await entry(root, "Fresh-ghi", project, daysAgo(2));
    await entry(root, "Offline-jkl", "/Volumes/NoSuchOctantDisk/App.xcodeproj", daysAgo(90));
    await mkdir(join(root, "ModuleCache.noindex"), { recursive: true });

    const data = createXcodeDerivedData({ root, platform: "darwin", now: () => now });
    const listed = await data.list();
    expect(listed.map((e) => [e.name, e.state]).sort()).toEqual([
      ["Gone-abc", "orphaned"],
      ["Old-def", "unused"],
    ]);
    expect(listed[0]?.size).toMatchObject({ complete: true });

    await expect(data.remove("Fresh-ghi")).resolves.toEqual({
      status: "refused",
      reason: "in-use",
    });
    await expect(data.remove("Offline-jkl")).resolves.toEqual({
      status: "refused",
      reason: "in-use",
    });
    await expect(data.remove("../DerivedData")).resolves.toMatchObject({ reason: "not-found" });
    await expect(data.remove("Gone-abc")).resolves.toEqual({ status: "removed" });
    expect(existsSync(join(root, "Gone-abc"))).toBe(false);
    expect(existsSync(join(root, "Fresh-ghi"))).toBe(true);
  });

  it("offers nothing where there is no Xcode", async () => {
    const data = createXcodeDerivedData({ root: undefined, platform: "linux", now: () => now });
    expect(data.available).toBe(false);
    await expect(data.list()).resolves.toEqual([]);
  });
});
