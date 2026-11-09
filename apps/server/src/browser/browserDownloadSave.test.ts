import { constants, mkdirSync, renameSync, symlinkSync } from "node:fs";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
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
  beforeSpawn: undefined as (() => void) | undefined,
  moveHeldDirectory: false,
  readPath: "",
  readEntered: false,
  readRelease: () => {},
}));
vi.mock("node:child_process", async (importOriginal) => {
  const child = await importOriginal<typeof import("node:child_process")>();
  return {
    ...child,
    execFile: (...args: Parameters<typeof child.execFile>) => {
      const before = race.beforeSpawn;
      race.beforeSpawn = undefined;
      before?.();
      if (race.moveHeldDirectory && Array.isArray(args[1])) {
        args[1] = args[1].map((argument) =>
          argument.includes("for (const name of names) {")
            ? argument.replace(
                "for (const name of names) {",
                `fs.realpathSync("."); fs.renameSync(folder, folder + "-moved"); fs.mkdirSync(folder); for (const name of names) {`,
              )
            : argument,
        );
      }
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
      if (args[0] === race.readPath) {
        const read = handle.read.bind(handle);
        Object.defineProperty(handle, "read", {
          value: async (
            buffer: NodeJS.ArrayBufferView,
            offset: number,
            length: number,
            position: number,
          ) => {
            const result = await read(buffer, offset, length, position);
            if (race.approved && !race.readEntered) {
              race.readEntered = true;
              await new Promise<void>((resolve) => {
                race.readRelease = resolve;
              });
            }
            return result;
          },
        });
      }
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

import { decodeProjectWorkingFolderId, decodeThreadWorkingDirectory } from "@octant/contracts";
import { saveBrowserDownload } from "./browserDownloadSave";

const roots: string[] = [];
afterEach(async () => {
  race.readRelease();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  Object.assign(race, {
    folder: "",
    outside: "",
    approved: false,
    swapped: false,
    openedOutside: false,
    childEnvironment: undefined,
    beforeSpawn: undefined,
    moveHeldDirectory: false,
    readPath: "",
    readEntered: false,
    readRelease: () => {},
  });
});

async function selectedFixture(directory = "reports", kind: "main" | "extra" = "extra") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "octant-selected-download-")));
  roots.push(root);
  const workspace = join(root, "workspace");
  const approved = join(root, "approved");
  const folder = directory === "." ? approved : join(approved, directory);
  const held = join(root, "held.txt");
  await mkdir(workspace);
  await mkdir(folder, { recursive: true });
  await writeFile(held, "reviewed download bytes");
  const identity = await lstat(folder, { bigint: true });
  const destination = {
    folder: {
      id: decodeProjectWorkingFolderId(`folder_${"a".repeat(64)}`),
      label: "Approved reports",
      kind,
    },
    canonicalRoot: approved,
    directory: decodeThreadWorkingDirectory(directory),
    reviewedDirectory: { device: String(identity.dev), inode: String(identity.ino) },
    current: () => true,
  };
  return { root, workspace, approved, folder, held, destination };
}

describe.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "saving a Browser download",
  () => {
    it.each(["main", "extra"] as const)(
      "saves only to the selected %s root and returns its honest relative receipt",
      async (kind) => {
        const fixture = await selectedFixture(kind === "main" ? "." : "nested/reports", kind);
        const admission = vi.fn(() => "approved" as const);
        const outcome = await saveBrowserDownload({
          workspaceRoot: fixture.workspace,
          destination: fixture.destination,
          name: "report.txt",
          claim: async () => fixture.held,
          isHeldPath: async () => true,
          ask: async () => "approved",
          finalAdmission: admission,
        });
        expect(outcome).toMatchObject({
          status: "saved",
          path: kind === "main" ? "report.txt" : "nested/reports/report.txt",
          destination: {
            approvedFolderId: fixture.destination.folder.id,
            label: "Approved reports",
            pathBase: "selected-root",
          },
        });
        expect(JSON.stringify(outcome)).not.toContain(fixture.approved);
        expect(await readFile(join(fixture.folder, "report.txt"), "utf8")).toBe(
          "reviewed download bytes",
        );
        expect(await readdir(fixture.workspace)).toEqual([]);
        expect(admission).toHaveBeenCalledOnce();
      },
    );

    it("refuses a replaced approved root even when the reviewed child directory is moved into it", async () => {
      const fixture = await selectedFixture();
      const rootIdentity = await lstat(fixture.approved, { bigint: true });
      await rename(fixture.approved, `${fixture.approved}-old`);
      await mkdir(fixture.approved);
      await rename(join(`${fixture.approved}-old`, "reports"), fixture.folder);
      const ask = vi.fn(async () => "approved" as const);
      const admission = vi.fn(() => "approved" as const);
      expect(
        await saveBrowserDownload({
          workspaceRoot: fixture.workspace,
          destination: {
            ...fixture.destination,
            reviewedRoot: { device: String(rootIdentity.dev), inode: String(rootIdentity.ino) },
          },
          name: "report.txt",
          claim: async () => fixture.held,
          isHeldPath: async () => true,
          ask,
          finalAdmission: admission,
        }),
      ).toMatchObject({ status: "refused", error: "download-changed" });
      expect(ask).not.toHaveBeenCalled();
      expect(admission).not.toHaveBeenCalled();
      expect(await readdir(fixture.folder)).toEqual([]);
    });

    it("never falls back to the workspace when a selected folder no longer belongs to the Project", async () => {
      const fixture = await selectedFixture();
      const outcome = await saveBrowserDownload({
        workspaceRoot: fixture.workspace,
        destination: { ...fixture.destination, current: () => false },
        name: "report.txt",
        claim: async () => fixture.held,
        isHeldPath: async () => true,
        ask: async () => "approved",
      });
      expect(outcome.status).toBe("refused");
      expect(await readdir(fixture.workspace)).toEqual([]);
      expect(await readdir(fixture.folder)).toEqual([]);
    });

    it.each(["../outside", "/outside", "nested/../outside", "nested\\outside"])(
      "refuses an escaping selected directory %s",
      async (directory) => {
        const fixture = await selectedFixture();
        const outcome = await saveBrowserDownload({
          workspaceRoot: fixture.workspace,
          destination: {
            ...fixture.destination,
            directory: directory as typeof fixture.destination.directory,
          },
          name: "report.txt",
          claim: async () => fixture.held,
          isHeldPath: async () => true,
          ask: async () => "approved",
        });
        expect(outcome.status).toBe("refused");
        expect(await readdir(fixture.workspace)).toEqual([]);
        expect(await readdir(fixture.folder)).toEqual([]);
      },
    );

    it.each(["during approval", "before child creation", "ancestor link before child creation"])(
      "refuses a reviewed directory replacement %s",
      async (stage) => {
        const fixture = await selectedFixture("nested/reports");
        const outside = join(fixture.root, "outside");
        await mkdir(join(outside, "reports"), { recursive: true });
        const swap = () => {
          if (stage.startsWith("ancestor")) {
            renameSync(join(fixture.approved, "nested"), join(fixture.approved, "nested-original"));
            symlinkSync(outside, join(fixture.approved, "nested"));
          } else {
            renameSync(fixture.folder, `${fixture.folder}-original`);
            mkdirSync(fixture.folder);
          }
        };
        const admission = vi.fn(() => "approved" as const);
        const outcome = await saveBrowserDownload({
          workspaceRoot: fixture.workspace,
          destination: fixture.destination,
          name: "report.txt",
          claim: async () => fixture.held,
          isHeldPath: async () => true,
          ask: async () => {
            if (stage === "during approval") {
              await rename(fixture.folder, `${fixture.folder}-original`);
              await mkdir(fixture.folder);
            } else race.beforeSpawn = swap;
            return "approved";
          },
          finalAdmission: admission,
        });
        expect(outcome.status).toBe("refused");
        expect(await readdir(fixture.workspace)).toEqual([]);
        expect(
          await readdir(stage.startsWith("ancestor") ? join(outside, "reports") : fixture.folder),
        ).toEqual([]);
        expect(admission).toHaveBeenCalledTimes(stage === "during approval" ? 0 : 1);
      },
    );

    it.each(["revoked", "cancelled"])(
      "writes nothing when %s while the held bytes are read",
      async (reason) => {
        const fixture = await selectedFixture();
        const abort = new AbortController();
        let current = true;
        race.readPath = fixture.held;
        const admission = vi.fn(() => "approved" as const);
        const pending = saveBrowserDownload({
          workspaceRoot: fixture.workspace,
          destination: { ...fixture.destination, current: () => current },
          signal: abort.signal,
          name: "report.txt",
          claim: async () => fixture.held,
          isHeldPath: async () => true,
          ask: async () => {
            race.approved = true;
            return "approved";
          },
          finalAdmission: admission,
        });
        try {
          await vi.waitFor(() => expect(race.readEntered).toBe(true));
          if (reason === "revoked") current = false;
          else abort.abort();
        } finally {
          race.readRelease();
        }
        expect((await pending).status).toBe("refused");
        expect(await readdir(fixture.folder)).toEqual([]);
        expect(await readdir(fixture.workspace)).toEqual([]);
        expect(admission).not.toHaveBeenCalled();
      },
    );

    it.each(["denied", "cancelled", "expired"] as const)(
      "performs no default destination effect when final admission is %s",
      async (decision) => {
        const fixture = await selectedFixture();
        const outcome = await saveBrowserDownload({
          workspaceRoot: fixture.workspace,
          signal: new AbortController().signal,
          name: "report.txt",
          claim: async () => fixture.held,
          isHeldPath: async () => true,
          ask: async () => "approved",
          finalAdmission: () => decision,
        });
        expect(outcome).toMatchObject({
          status: "refused",
          error: `browser-download-${decision}`,
          reason: decision,
        });
        expect(await readdir(fixture.workspace)).toEqual([]);
      },
    );

    it("refuses a moved native working directory even after the runtime cached its old path", async () => {
      const fixture = await selectedFixture();
      race.moveHeldDirectory = true;
      const outcome = await saveBrowserDownload({
        workspaceRoot: fixture.workspace,
        destination: fixture.destination,
        name: "report.txt",
        claim: async () => fixture.held,
        isHeldPath: async () => true,
        ask: async () => "approved",
      });
      expect(outcome.status).toBe("refused");
      expect(await readdir(fixture.folder)).toEqual([]);
      expect(await readdir(`${fixture.folder}-moved`)).toEqual([]);
    });

    it("accepts a host-selected root without a workspace and never exposes a path as its folder label", async () => {
      const fixture = await selectedFixture(".");
      const outcome = await saveBrowserDownload({
        workspaceRoot: undefined,
        destination: {
          ...fixture.destination,
          folder: { ...fixture.destination.folder, label: fixture.approved },
        },
        name: "report.txt",
        claim: async () => fixture.held,
        isHeldPath: async () => true,
        ask: async () => "approved",
      });
      expect(outcome).toMatchObject({
        status: "saved",
        path: "report.txt",
        destination: {
          approvedFolderId: fixture.destination.folder.id,
          label: "Approved extra folder",
          pathBase: "selected-root",
        },
      });
      expect(JSON.stringify(outcome)).not.toContain(fixture.approved);
    });

    it.each(["revoked", "cancelled"])(
      "writes nothing if the selection is %s during approval",
      async (change) => {
        const fixture = await selectedFixture();
        const abort = new AbortController();
        let current = true;
        const outcome = await saveBrowserDownload({
          workspaceRoot: fixture.workspace,
          destination: { ...fixture.destination, current: () => current },
          signal: abort.signal,
          name: "report.txt",
          claim: async () => fixture.held,
          isHeldPath: async () => true,
          ask: async () => {
            if (change === "revoked") current = false;
            else abort.abort();
            return "approved";
          },
        });
        expect(outcome).toMatchObject({ status: "refused", reason: "cancelled" });
        expect(await readdir(fixture.folder)).toEqual([]);
        expect(await readdir(fixture.workspace)).toEqual([]);
      },
    );

    it("refuses changed held bytes before final admission even when size and inode stay the same", async () => {
      const fixture = await selectedFixture();
      const admission = vi.fn(() => "approved" as const);
      const outcome = await saveBrowserDownload({
        workspaceRoot: fixture.workspace,
        destination: fixture.destination,
        name: "report.txt",
        claim: async () => fixture.held,
        isHeldPath: async () => true,
        ask: async () => {
          const bytes = await readFile(fixture.held);
          bytes.set([0x7f, 0x45, 0x4c, 0x46]);
          await writeFile(fixture.held, bytes);
          return "approved";
        },
        finalAdmission: admission,
      });
      expect(outcome).toMatchObject({ status: "refused", reason: "changed" });
      expect(admission).not.toHaveBeenCalled();
      expect(await readdir(fixture.folder)).toEqual([]);
      expect(await readdir(fixture.workspace)).toEqual([]);
    });

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
