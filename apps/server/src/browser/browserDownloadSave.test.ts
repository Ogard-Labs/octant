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
  childEnvironment: undefined as NodeJS.ProcessEnv | undefined,
}));
vi.mock("node:child_process", async (importOriginal) => {
  const child = await importOriginal<typeof import("node:child_process")>();
  return {
    ...child,
    execFile: (...args: Parameters<typeof child.execFile>) => {
      const options = args[2];
      if (typeof options === "object" && options !== null) race.childEnvironment = options.env;
      return child.execFile(...args);
    },
  };
});

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
    childEnvironment: undefined,
  });
});

describe.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "saving a Browser download",
  () => {
    it("preserves only fixed Node-mode authority when the host runs in the packaged worker runtime", async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "octant-download-worker-")));
      roots.push(root);
      const descriptor = Object.getOwnPropertyDescriptor(process.versions, "electron");
      Object.defineProperty(process.versions, "electron", { configurable: true, value: "43.7.11" });
      const held = join(root, "held.txt");
      await writeFile(held, "approved worker bytes");
      try {
        const outcome = await saveBrowserDownload({
          workspaceRoot: root,
          name: "report.txt",
          claim: async () => held,
          isHeldPath: async () => true,
          ask: async () => "approved",
        });
        expect(outcome.status).toBe("saved");
        expect(race.childEnvironment).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
      } finally {
        if (descriptor === undefined) Reflect.deleteProperty(process.versions, "electron");
        else Object.defineProperty(process.versions, "electron", descriptor);
      }
    });
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
