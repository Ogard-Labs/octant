import { constants } from "node:fs";
import { mkdtemp, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const race = vi.hoisted(() => ({
  folder: "",
  outside: "",
  approved: false,
  swapped: false,
  openedOutside: false,
}));

// Reproduce a real directory/link swap after the last canonical-path check
// and before creation. The filesystem effects and helper child stay real.
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    realpath: async (...args: Parameters<typeof fs.realpath>) => {
      const result = await fs.realpath(...args);
      if (args[0] === race.folder && race.approved && !race.swapped) {
        await fs.rename(race.folder, `${race.folder}-original`);
        await fs.symlink(race.outside, race.folder);
        race.swapped = true;
      }
      return result;
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (
        typeof args[0] === "string" &&
        args[0].startsWith(`${race.folder}/`) &&
        typeof args[1] === "number" &&
        (args[1] & constants.O_CREAT) !== 0 &&
        race.swapped
      )
        race.openedOutside = true;
      return handle;
    },
  };
});

import { saveBrowserDownload } from "./browserDownloadSave";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  Object.assign(race, {
    folder: "",
    outside: "",
    approved: false,
    swapped: false,
    openedOutside: false,
  });
});

describe.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "saving a Browser download",
  () => {
    it("creates no file outside the workspace when the checked destination is replaced by a link", async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "octant-download-race-")));
      roots.push(root);
      const workspace = join(root, "workspace");
      const outside = join(root, "outside");
      const folder = join(workspace, "downloads");
      const held = join(root, "held.txt");
      await mkdir(folder, { recursive: true });
      await mkdir(outside);
      await writeFile(held, "private download bytes");
      Object.assign(race, { folder, outside });
      const outcome = await saveBrowserDownload({
        workspaceRoot: workspace,
        name: "report.txt",
        claim: async () => held,
        isHeldPath: async () => true,
        ask: async () => {
          race.approved = true;
          return "approved";
        },
      });
      expect(race.swapped).toBe(true);
      expect(outcome.status).toBe("refused");
      expect(race.openedOutside).toBe(false);
      expect(await readdir(outside)).toEqual([]);
      expect(await readdir(`${folder}-original`)).toEqual([]);
    });
  },
);
