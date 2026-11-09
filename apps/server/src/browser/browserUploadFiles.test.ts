import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { prepareBrowserUpload, admitBrowserUpload } from "./browserUploadFiles";

it("binds upload approval to the exact bounded private copy even when the source later changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "octant-upload-manifest-"));
  try {
    await writeFile(join(root, "report.txt"), "reviewed report");
    const prepared = await prepareBrowserUpload({ workspaceRoot: root, files: ["report.txt"] });
    if (prepared.status !== "prepared") throw Error(JSON.stringify(prepared));
    try {
      expect(prepared.files[0]?.sha256).toBe(
        createHash("sha256").update("reviewed report").digest("hex"),
      );
      await writeFile(join(root, "report.txt"), "changed report");
      expect(await readFile(prepared.paths[0] ?? "", "utf8")).toBe("reviewed report");
      const admitted = await admitBrowserUpload({
        workspaceRoot: root,
        files: ["report.txt"],
        ask: async (files) =>
          files[0]?.sha256 === prepared.files[0]?.sha256 ? "approved" : "denied",
      });
      expect(admitted).toMatchObject({ status: "refused", reason: "browser-upload-denied" });
    } finally {
      await prepared.release();
    }
    expect(
      await prepareBrowserUpload({
        workspaceRoot: root,
        files: Array.from({ length: 6 }, () => "report.txt"),
      }),
    ).toMatchObject({ status: "refused" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
