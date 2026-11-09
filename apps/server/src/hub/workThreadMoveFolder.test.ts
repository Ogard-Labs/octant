import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeThreadWorkingDirectory } from "@octant/contracts";
import {
  captureWorkFolderForMove,
  settleMovedWorkFolder,
  workThreadOwnFolder,
  type MovedWorkFolder,
} from "./workThreadMoveFolder";

const main = { kind: "main", root: "/Users/person/Offsite" } as const;
const report = decodeThreadWorkingDirectory("report");
const MOVE = "99999999-9999-4999-8999-999999999999";

const parents: string[] = [];
afterEach(() => {
  for (const parent of parents.splice(0)) rmSync(parent, { recursive: true, force: true });
});

/** A source folder holding `files`, with the index a move that carried them all would have kept. */
function travelledFolder(files: Readonly<Record<string, string>>) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "octant-work-settle-")));
  parents.push(parent);
  const folder = join(parent, "report");
  mkdirSync(folder);
  const entries = Object.entries(files).map(([path, text]) => {
    mkdirSync(join(folder, path, ".."), { recursive: true });
    writeFileSync(join(folder, path), text);
    return {
      path: decodeThreadWorkingDirectory(path),
      bytes: Buffer.byteLength(text),
      sha256: createHash("sha256").update(text).digest("hex"),
      mode: 0o644,
    };
  });
  const index: MovedWorkFolder = {
    workingDirectory: report,
    partId: "work-files",
    files: entries,
    emptyFolders: [],
    rootMode: 0o755,
    folderModes: [],
  };
  return { parent, folder, index };
}

describe("reading a Work folder's files for a move", () => {
  const OUTSIDE = "Payroll, not part of the offsite";

  /** A folder with two files and a document outside it a link could point at. */
  function folderBesideAnOutsideDocument() {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "octant-work-capture-")));
    parents.push(parent);
    const folder = join(parent, "report");
    mkdirSync(join(folder, "notes"), { recursive: true });
    writeFileSync(join(folder, "agenda.md"), "# Offsite\n");
    writeFileSync(join(folder, "notes", "rooms.txt"), "Room A");
    mkdirSync(join(parent, "outside"));
    writeFileSync(join(parent, "outside", "rooms.txt"), OUTSIDE);
    return { parent, folder, partPath: join(parent, "work-files.part") };
  }

  it("never packs what a file swapped for a link after the walk points at", async () => {
    const { parent, folder, partPath } = folderBesideAnOutsideDocument();
    const captured = await captureWorkFolderForMove({
      folder,
      workingDirectory: report,
      partId: "work-files",
      partPath,
      beforeReading: async (path) => {
        if (path !== "agenda.md") return;
        rmSync(join(folder, "notes", "rooms.txt"));
        symlinkSync(join(parent, "outside", "rooms.txt"), join(folder, "notes", "rooms.txt"));
      },
    });
    expect(captured.index.files.map((file) => file.path)).toEqual(["agenda.md"]);
    expect(captured.left).toEqual(["notes/rooms.txt"]);
    expect(readFileSync(partPath, "utf8")).not.toContain(OUTSIDE);
  });

  it("never packs a file reached through a folder swapped for a link after the walk", async () => {
    const { parent, folder, partPath } = folderBesideAnOutsideDocument();
    const captured = await captureWorkFolderForMove({
      folder,
      workingDirectory: report,
      partId: "work-files",
      partPath,
      beforeReading: async (path) => {
        if (path !== "agenda.md") return;
        rmSync(join(folder, "notes"), { recursive: true });
        symlinkSync(join(parent, "outside"), join(folder, "notes"));
      },
    });
    expect(captured.index.files.map((file) => file.path)).toEqual(["agenda.md"]);
    expect(captured.left).toEqual(["notes/rooms.txt"]);
    expect(readFileSync(partPath, "utf8")).not.toContain(OUTSIDE);
  });
});

describe("clearing a Work folder whose files moved", () => {
  it("removes every file and folder that travelled, and its trash folder", async () => {
    const { parent, folder, index } = travelledFolder({
      "agenda.md": "# Offsite\n",
      "notes/day-one/rooms.txt": "Room A",
    });
    expect(await settleMovedWorkFolder({ folder, index, moveId: MOVE })).toEqual({
      status: "removed",
    });
    expect(existsSync(folder)).toBe(false);
    expect(readdirSync(parent)).toEqual([]);
  });

  it("keeps a file written to a path after the travelled one was checked and cleared", async () => {
    const { parent, folder, index } = travelledFolder({
      "agenda.md": "# Offsite\n",
      "rooms.txt": "Room A",
    });
    const outcome = await settleMovedWorkFolder({
      folder,
      index,
      moveId: MOVE,
      afterMovedAside: async (path) => {
        if (path === "agenda.md") writeFileSync(join(folder, "agenda.md"), "# Edited just now\n");
      },
    });
    expect(outcome).toEqual({ status: "kept", keptFiles: ["agenda.md"] });
    expect(readFileSync(join(folder, "agenda.md"), "utf8")).toBe("# Edited just now\n");
    expect(readdirSync(folder)).toEqual(["agenda.md"]);
    expect(readdirSync(parent)).toEqual(["report"]);
  });

  it("keeps a file created while the folder was being cleared, and the folder with it", async () => {
    const { folder, index } = travelledFolder({
      "agenda.md": "# Offsite\n",
      "notes/rooms.txt": "Room A",
    });
    const outcome = await settleMovedWorkFolder({
      folder,
      index,
      moveId: MOVE,
      afterMovedAside: async (path) => {
        if (path === "agenda.md") writeFileSync(join(folder, "notes", "late.txt"), "New");
      },
    });
    expect(outcome).toEqual({ status: "kept", keptFiles: ["notes/late.txt"] });
    expect(readFileSync(join(folder, "notes", "late.txt"), "utf8")).toBe("New");
    expect(existsSync(join(folder, "agenda.md"))).toBe(false);
  });

  it("leaves an empty folder that never travelled, and the folder holding it", async () => {
    const { folder, index } = travelledFolder({ "agenda.md": "# Offsite\n" });
    mkdirSync(join(folder, "drafts"));

    expect(await settleMovedWorkFolder({ folder, index, moveId: MOVE })).toEqual({
      status: "kept",
      keptFiles: ["drafts"],
    });
    expect(existsSync(join(folder, "drafts"))).toBe(true);
    expect(existsSync(join(folder, "agenda.md"))).toBe(false);
  });

  it("puts a changed file back, beside its path when that path was taken again", async () => {
    const { folder, index } = travelledFolder({ "agenda.md": "# Offsite\n" });
    writeFileSync(join(folder, "agenda.md"), "# Changed before the clean-up\n");
    const outcome = await settleMovedWorkFolder({
      folder,
      index,
      moveId: MOVE,
      afterMovedAside: async () =>
        writeFileSync(join(folder, "agenda.md"), "# Written meanwhile\n"),
    });
    expect(outcome).toEqual({ status: "kept", keptFiles: ["agenda.md", "agenda.md-kept"] });
    expect(readFileSync(join(folder, "agenda.md"), "utf8")).toBe("# Written meanwhile\n");
    expect(readFileSync(join(folder, "agenda.md-kept"), "utf8")).toBe(
      "# Changed before the clean-up\n",
    );
  });

  /** A first clean-up that stops right after setting `stopAt` aside, as a host that stopped would. */
  async function stoppedAfterSettingAside(
    folder: string,
    index: MovedWorkFolder,
    stopAt: string,
  ): Promise<void> {
    await expect(
      settleMovedWorkFolder({
        folder,
        index,
        moveId: MOVE,
        afterMovedAside: async (path) => {
          if (path === stopAt) throw new Error("The host stopped.");
        },
      }),
    ).rejects.toThrow("stopped");
  }

  it("brings back an edited file a stopped clean-up had set aside, and names it", async () => {
    const { parent, folder, index } = travelledFolder({
      "agenda.md": "# Offsite\n",
      "rooms.txt": "Room A",
    });
    writeFileSync(join(folder, "agenda.md"), "# Edited after the move packed\n");
    await stoppedAfterSettingAside(folder, index, "agenda.md");
    expect(existsSync(join(folder, "agenda.md"))).toBe(false);

    expect(await settleMovedWorkFolder({ folder, index, moveId: MOVE })).toEqual({
      status: "kept",
      keptFiles: ["agenda.md"],
    });
    expect(readFileSync(join(folder, "agenda.md"), "utf8")).toBe(
      "# Edited after the move packed\n",
    );
    expect(existsSync(join(folder, "rooms.txt"))).toBe(false);
    expect(readdirSync(parent)).toEqual(["report"]);
  });

  it("keeps a stopped clean-up's edited file beside its path when the path was taken since", async () => {
    const { folder, index } = travelledFolder({ "agenda.md": "# Offsite\n" });
    writeFileSync(join(folder, "agenda.md"), "# Edited after the move packed\n");
    await stoppedAfterSettingAside(folder, index, "agenda.md");
    writeFileSync(join(folder, "agenda.md"), "# Written before the retry\n");

    expect(await settleMovedWorkFolder({ folder, index, moveId: MOVE })).toEqual({
      status: "kept",
      keptFiles: ["agenda.md", "agenda.md-kept"],
    });
    expect(readFileSync(join(folder, "agenda.md-kept"), "utf8")).toBe(
      "# Edited after the move packed\n",
    );
  });

  it("deletes a matching file a stopped clean-up had set aside and removes the folder", async () => {
    const { parent, folder, index } = travelledFolder({
      "agenda.md": "# Offsite\n",
      "notes/rooms.txt": "Room A",
    });
    await stoppedAfterSettingAside(folder, index, "agenda.md");

    expect(await settleMovedWorkFolder({ folder, index, moveId: MOVE })).toEqual({
      status: "removed",
    });
    expect(readdirSync(parent)).toEqual([]);
  });
});

describe("which Work folder a move carries", () => {
  it("carries the subfolder a thread was started in when no other thread or Project uses it", () => {
    expect(
      workThreadOwnFolder({
        workingFolder: main,
        workingDirectory: report,
        // A thread working in the Project folder above does not share it.
        otherThreadFolders: ["/Users/person/Offsite", "/Users/person/Offsite/reports"],
        projectFolders: ["/Users/person/Offsite"],
      }),
    ).toEqual({ status: "own", folder: "/Users/person/Offsite/report", workingDirectory: report });
  });

  it("leaves the Project folder, an extra folder, and a shared subfolder where they are", () => {
    const shared = { otherThreadFolders: [], projectFolders: [] };
    expect(
      workThreadOwnFolder({ ...shared, workingFolder: main, workingDirectory: undefined }),
    ).toEqual({ status: "stays", reason: "project-folder" });
    expect(
      workThreadOwnFolder({
        ...shared,
        workingFolder: { kind: "extra" },
        workingDirectory: report,
      }),
    ).toEqual({ status: "stays", reason: "extra-folder" });
    expect(
      workThreadOwnFolder({
        ...shared,
        workingFolder: main,
        workingDirectory: report,
        otherThreadFolders: ["/Users/person/Offsite/report/drafts"],
      }),
    ).toEqual({ status: "stays", reason: "shared" });
    expect(
      workThreadOwnFolder({
        ...shared,
        workingFolder: main,
        workingDirectory: report,
        projectFolders: ["/Users/person/Offsite/report"],
      }),
    ).toEqual({ status: "stays", reason: "shared" });
  });
});
