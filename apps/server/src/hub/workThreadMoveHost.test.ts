import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeThreadWorkingDirectory,
  type MovedThreadReference,
  type ThreadMoveId,
  type ThreadMoveOffer,
} from "@octant/contracts";
import { noThreadParts, oneCaptureThreadParts } from "./movedThreadParts.test-support";
import { createThreadMoveHolds } from "./threadMoveHolds";
import { createWorkThreadMoveHost, type WorkThreadMoveHostOptions } from "./workThreadMoveHost";

const THREAD = "77777777-7777-4777-8777-777777777777";
const ARRIVING = "88888888-8888-4888-8888-888888888888";
const MOVE = "99999999-9999-4999-8999-999999999999" as ThreadMoveId;
const PROJECT = "55555555-5555-4555-8555-555555555555";
const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function host(
  overrides: Partial<WorkThreadMoveHostOptions> = {},
  behaviour: { readonly stopsBeforeFirstOpen?: boolean } = {},
) {
  let stopBeforeOpen = behaviour.stopsBeforeFirstOpen === true;
  const created: string[] = [];
  const marks: Array<{ readonly sourceLabel: string; readonly contentReference: string }> = [];
  const histories: string[] = [];
  const workingDirectories: Array<string | undefined> = [];
  const holds = createThreadMoveHolds();
  const partsFolder = temporaryFolder();
  const moveHost = createWorkThreadMoveHost({
    readThread: (id) =>
      String(id) === THREAD || created.includes(String(id))
        ? {
            title: "Plan the offsite",
            active: true,
            providerInstanceId: "11111111-1111-4111-8111-111111111111",
            modelId: "model-a",
          }
        : undefined,
    isBusy: () => false,
    isDelegated: () => false,
    ownFolder: () => ({ status: "stays", reason: "project-folder" }),
    partsDirectory: () => partsFolder,
    providerDriverKind: () => "codex",
    transcript: async () => [
      { role: "person", text: "Draft an agenda", occurredAt: "2026-11-08T10:00:00.000Z" as never },
    ],
    externalContentIngested: () => false,
    purge: async () => {},
    activeWorkProject: (projectId) => projectId === PROJECT,
    landingRoot: () => undefined,
    resolveProvider: (driverKind, modelId) =>
      driverKind === "codex"
        ? { providerInstanceId: "22222222-2222-4222-8222-222222222222", modelId }
        : undefined,
    createThread: async (input) => {
      if (stopBeforeOpen) {
        stopBeforeOpen = false;
        throw new Error("The host stopped before opening the thread.");
      }
      created.push(String(input.threadId));
      workingDirectories.push(input.workingDirectory);
      if (input.inheritedMark !== undefined) marks.push(input.inheritedMark);
    },
    journalHistory: (input) => histories.push(input.threadId),
    holds,
    parts: noThreadParts(),
    ...overrides,
  });
  return { moveHost, created, histories, holds, marks, partsFolder, workingDirectories };
}

function temporaryFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), "octant-work-move-"));
  folders.push(folder);
  return folder;
}

async function packAndOffer(
  moveHost: ReturnType<typeof host>["moveHost"],
  folder: string = temporaryFolder(),
) {
  const packed = await moveHost.source.pack({ mode: "work", threadId: THREAD }, folder, MOVE);
  if (packed.status !== "packed") throw new Error("Nothing was packed.");
  const offer = {
    moveId: MOVE,
    source: { mode: "work", threadId: THREAD },
    title: "Plan the offsite",
    destinationProjectId: PROJECT,
    manifest: {
      parts: packed.parts.map((part) => ({ ...part, bytes: 1, sha256: "a".repeat(64) })),
    },
  } as unknown as ThreadMoveOffer;
  return { offer, parts: new Map(packed.parts.map((part) => [part.partId, part.path])) };
}

const arriveWith = (
  moveHost: ReturnType<typeof host>["moveHost"],
  offer: ThreadMoveOffer,
  parts: ReadonlyMap<string, string>,
) => {
  const planned: MovedThreadReference = { mode: "work", threadId: ARRIVING };
  return moveHost.destination.arrive({
    thread: planned,
    offer,
    parts,
    origin: { memberId: "x" as never, thread: { mode: "work", threadId: THREAD } },
    ownerMemberId: "y" as never,
  });
};

describe("moving a Work thread", () => {
  it("moves the conversation and opens the thread held, with its history, in the chosen Project", async () => {
    const { moveHost, created, histories, holds } = host();
    const { offer, parts } = await packAndOffer(moveHost);
    expect(await moveHost.destination.acceptsProject(placementOf(offer))).toBe(true);

    expect(await arriveWith(moveHost, offer, parts)).toEqual({
      status: "arrived",
      thread: { mode: "work", threadId: ARRIVING },
    });
    expect(created).toEqual([ARRIVING]);
    expect(histories).toEqual([ARRIVING]);
    expect(holds.isHeld({ mode: "work", threadId: ARRIVING })).toBe(true);

    // A retried arrival after a stop opens no second thread.
    await arriveWith(moveHost, offer, parts);
    expect(created).toEqual([ARRIVING]);
  });

  it("carries the thread's bulk parts and keeps them under the arriving thread once", async () => {
    const carried = oneCaptureThreadParts();
    const { moveHost } = host({ parts: carried.parts });
    const { offer, parts } = await packAndOffer(moveHost);
    expect([...parts.keys()]).toEqual(["thread", "capture-1"]);

    expect((await arriveWith(moveHost, offer, parts)).status).toBe("arrived");
    expect(carried.kept.map((capture) => [capture.threadId, capture.facts.url])).toEqual([
      [ARRIVING, "https://example.com/agenda"],
    ]);
    // A retried arrival keeps the same capture under the same id.
    await arriveWith(moveHost, offer, parts);
    expect(new Set(carried.kept.map((capture) => capture.captureId)).size).toBe(1);
  });

  it("counts its capture in what a move would send", async () => {
    const { moveHost } = host({ parts: oneCaptureThreadParts().parts });
    const size = await moveHost.source.measure({ mode: "work", threadId: THREAD });
    if (size.status !== "measured") throw new Error("The thread was not measured.");
    expect(size.parts.find((part) => part.kind === "browser-capture")?.bytes).toBe(3);
    expect(size.bytes).toBe(size.parts.reduce((total, part) => total + part.bytes, 0));
  });

  it("opens the thread marked when the source thread had read outside content", async () => {
    const { moveHost, marks } = host({ externalContentIngested: () => true });
    const { offer, parts } = await packAndOffer(moveHost);
    await arriveWith(moveHost, offer, parts);
    expect(marks).toEqual([
      { sourceLabel: "moved-thread", contentReference: `moved-thread-${MOVE}` },
    ]);
  });

  it("never moves a thread a peer delegated here", async () => {
    const { moveHost } = host({ isDelegated: () => true });
    const read = await moveHost.source.read({ mode: "work", threadId: THREAD });
    expect(read.status === "found" && read.delegated).toBe(true);
  });

  it("refuses a destination without the provider kind the thread ran on", async () => {
    const { moveHost, created } = host({ resolveProvider: () => undefined });
    const { offer, parts } = await packAndOffer(moveHost);
    expect(await arriveWith(moveHost, offer, parts)).toEqual({
      status: "refused",
      reason: "no-matching-provider",
    });
    expect(created).toEqual([]);
  });

  it("keeps the history before answering when an earlier try opened the thread but stopped first", async () => {
    let stopBeforeHistory = true;
    const histories: string[] = [];
    const { moveHost, created } = host({
      journalHistory: (input) => {
        if (stopBeforeHistory) {
          stopBeforeHistory = false;
          throw new Error("The host stopped after opening the thread.");
        }
        histories.push(input.threadId);
      },
    });
    const { offer, parts } = await packAndOffer(moveHost);
    await expect(arriveWith(moveHost, offer, parts)).rejects.toThrow("stopped");

    expect(await arriveWith(moveHost, offer, parts)).toEqual({
      status: "arrived",
      thread: { mode: "work", threadId: ARRIVING },
    });
    expect(created).toEqual([ARRIVING]);
    expect(histories).toEqual([ARRIVING]);
  });
});

describe("moving a Work thread's own folder", () => {
  const SOURCE: MovedThreadReference = { mode: "work", threadId: THREAD };

  /** A thread that works in its own `report` folder, moving into a Project with its own folder. */
  function filesHost(behaviour: { readonly stopsBeforeFirstOpen?: boolean } = {}) {
    const sourceRoot = realpathSync(temporaryFolder());
    const destinationRoot = realpathSync(temporaryFolder());
    const sourceFolder = join(sourceRoot, "report");
    mkdirSync(sourceFolder);
    const moved = host(
      {
        ownFolder: () => ({
          status: "own",
          folder: sourceFolder,
          workingDirectory: decodeThreadWorkingDirectory("report"),
        }),
        landingRoot: () => destinationRoot,
      },
      behaviour,
    );
    return { ...moved, sourceRoot, sourceFolder, destinationRoot };
  }

  it("carries the folder's files and lands them where the thread works on the destination", async () => {
    const moved = filesHost();
    writeFileSync(join(moved.sourceFolder, "agenda.md"), "# Offsite\n");
    mkdirSync(join(moved.sourceFolder, "notes", "day-one"), { recursive: true });
    writeFileSync(join(moved.sourceFolder, "notes", "day-one", "rooms.txt"), "Room A");
    mkdirSync(join(moved.sourceFolder, "drafts"));

    const size = await moved.moveHost.source.measure(SOURCE);
    expect(
      size.status === "measured" && size.parts.find((part) => part.kind === "work-files"),
    ).toEqual({ kind: "work-files", bytes: 16 });
    const { offer, parts } = await packAndOffer(moved.moveHost, moved.partsFolder);
    expect([...parts.keys()]).toEqual(["thread", "work-files"]);
    expect((await arriveWith(moved.moveHost, offer, parts)).status).toBe("arrived");

    const landed = join(moved.destinationRoot, "report");
    expect(readFileSync(join(landed, "agenda.md"), "utf8")).toBe("# Offsite\n");
    expect(readFileSync(join(landed, "notes", "day-one", "rooms.txt"), "utf8")).toBe("Room A");
    expect(statSync(join(landed, "drafts")).isDirectory()).toBe(true);
    expect(moved.workingDirectories).toEqual(["report"]);

    // Everything in it travelled unchanged, so the folder goes with the thread.
    expect(await moved.moveHost.source.erase({ thread: SOURCE, moveId: MOVE })).toEqual({
      worktreeKept: false,
    });
    expect(existsSync(moved.sourceFolder)).toBe(false);
  });

  it("leaves ignored files, a file holding a secret, and a link behind, names them, and keeps the folder", async () => {
    const moved = filesHost();
    execFileSync("git", ["init", "-q"], { cwd: moved.sourceRoot });
    writeFileSync(join(moved.sourceRoot, ".gitignore"), "*.log\n");
    writeFileSync(join(moved.sourceFolder, "agenda.md"), "# Offsite\n");
    writeFileSync(join(moved.sourceFolder, "debug.log"), "noise");
    writeFileSync(
      join(moved.sourceFolder, "keys.txt"),
      `ANTHROPIC_API_KEY=sk-ant-api03-${"a".repeat(24)}\n`,
    );
    symlinkSync(join(moved.sourceRoot, ".gitignore"), join(moved.sourceFolder, "rules"));

    const { offer, parts } = await packAndOffer(moved.moveHost, moved.partsFolder);
    expect((await arriveWith(moved.moveHost, offer, parts)).status).toBe("arrived");
    expect(readdirSync(join(moved.destinationRoot, "report"))).toEqual(["agenda.md"]);

    const kept = {
      worktreeKept: false,
      keptFolder: moved.sourceFolder,
      keptFiles: ["debug.log", "keys.txt", "rules"],
    };
    expect(await moved.moveHost.source.erase({ thread: SOURCE, moveId: MOVE })).toEqual(kept);
    // Only what travelled is cleared; the folder stays with what did not.
    expect(readdirSync(moved.sourceFolder).sort()).toEqual(["debug.log", "keys.txt", "rules"]);
    // An erase run again after a stop reports the same and removes nothing.
    expect(await moved.moveHost.source.erase({ thread: SOURCE, moveId: MOVE })).toEqual(kept);
    expect(readdirSync(moved.sourceFolder).sort()).toEqual(["debug.log", "keys.txt", "rules"]);
  });

  it("lands each file with the permission bits it had on the source", async () => {
    const moved = filesHost();
    writeFileSync(join(moved.sourceFolder, "build.sh"), "#!/bin/sh\necho built\n");
    chmodSync(join(moved.sourceFolder, "build.sh"), 0o755);
    writeFileSync(join(moved.sourceFolder, "private.txt"), "Only mine");
    chmodSync(join(moved.sourceFolder, "private.txt"), 0o600);

    const { offer, parts } = await packAndOffer(moved.moveHost, moved.partsFolder);
    expect((await arriveWith(moved.moveHost, offer, parts)).status).toBe("arrived");

    const landed = join(moved.destinationRoot, "report");
    expect(statSync(join(landed, "build.sh")).mode & 0o777).toBe(0o755);
    expect(statSync(join(landed, "private.txt")).mode & 0o777).toBe(0o600);
  });

  it("lands the folder and the folders inside it with the permission bits they had", async () => {
    const moved = filesHost();
    mkdirSync(join(moved.sourceFolder, "team"));
    writeFileSync(join(moved.sourceFolder, "team", "rota.md"), "Who drives");
    chmodSync(join(moved.sourceFolder, "team"), 0o750);
    chmodSync(moved.sourceFolder, 0o700);

    const { offer, parts } = await packAndOffer(moved.moveHost, moved.partsFolder);
    expect((await arriveWith(moved.moveHost, offer, parts)).status).toBe("arrived");

    const landed = join(moved.destinationRoot, "report");
    expect(statSync(landed).mode & 0o777).toBe(0o700);
    expect(statSync(join(landed, "team")).mode & 0o777).toBe(0o750);
    expect(readFileSync(join(landed, "team", "rota.md"), "utf8")).toBe("Who drives");
  });

  it("lands an empty folder with its own permission bits", async () => {
    const moved = filesHost();
    writeFileSync(join(moved.sourceFolder, "notes.md"), "Plan");
    mkdirSync(join(moved.sourceFolder, "shared"));
    chmodSync(join(moved.sourceFolder, "shared"), 0o770);

    const { offer, parts } = await packAndOffer(moved.moveHost, moved.partsFolder);
    expect((await arriveWith(moved.moveHost, offer, parts)).status).toBe("arrived");

    const landed = join(moved.destinationRoot, "report");
    expect(statSync(join(landed, "shared")).mode & 0o777).toBe(0o770);
  });

  it("keeps the folder when a file in it changed after the move packed", async () => {
    const moved = filesHost();
    writeFileSync(join(moved.sourceFolder, "agenda.md"), "# Offsite\n");
    const { offer, parts } = await packAndOffer(moved.moveHost, moved.partsFolder);
    await arriveWith(moved.moveHost, offer, parts);
    writeFileSync(join(moved.sourceFolder, "agenda.md"), "# Offsite, edited after\n");

    expect(await moved.moveHost.source.erase({ thread: SOURCE, moveId: MOVE })).toEqual({
      worktreeKept: false,
      keptFolder: moved.sourceFolder,
      keptFiles: ["agenda.md"],
    });
    expect(readFileSync(join(moved.sourceFolder, "agenda.md"), "utf8")).toContain("edited");
  });

  it("never overwrites a file already at the destination path and lands beside it instead", async () => {
    const moved = filesHost();
    writeFileSync(join(moved.sourceFolder, "agenda.md"), "# Offsite\n");
    mkdirSync(join(moved.destinationRoot, "report"));
    writeFileSync(join(moved.destinationRoot, "report", "agenda.md"), "The person's own");

    const { offer, parts } = await packAndOffer(moved.moveHost, moved.partsFolder);
    expect((await arriveWith(moved.moveHost, offer, parts)).status).toBe("arrived");

    expect(readFileSync(join(moved.destinationRoot, "report", "agenda.md"), "utf8")).toBe(
      "The person's own",
    );
    expect(moved.workingDirectories).toEqual(["report-moved-99999999"]);
    expect(
      readFileSync(join(moved.destinationRoot, "report-moved-99999999", "agenda.md"), "utf8"),
    ).toBe("# Offsite\n");
  });

  it("refuses the arrival, writing nothing, when the fresh path is taken too", async () => {
    const moved = filesHost();
    writeFileSync(join(moved.sourceFolder, "agenda.md"), "# Offsite\n");
    mkdirSync(join(moved.destinationRoot, "report"));
    writeFileSync(join(moved.destinationRoot, "report", "agenda.md"), "The person's own");
    writeFileSync(join(moved.destinationRoot, "report-moved-99999999"), "Also the person's");

    const { offer, parts } = await packAndOffer(moved.moveHost, moved.partsFolder);
    expect(await arriveWith(moved.moveHost, offer, parts)).toEqual({
      status: "refused",
      reason: "transfer-failed",
    });
    expect(moved.created).toEqual([]);
    expect(readdirSync(moved.destinationRoot).sort()).toEqual(["report", "report-moved-99999999"]);
    expect(readdirSync(join(moved.destinationRoot, "report"))).toEqual(["agenda.md"]);
  });

  it("lands the files once when a try stopped after landing them and before opening the thread", async () => {
    const moved = filesHost({ stopsBeforeFirstOpen: true });
    writeFileSync(join(moved.sourceFolder, "agenda.md"), "# Offsite\n");
    const { offer, parts } = await packAndOffer(moved.moveHost, moved.partsFolder);

    expect((await arriveWith(moved.moveHost, offer, parts)).status).toBe("refused");
    expect(await arriveWith(moved.moveHost, offer, parts)).toEqual({
      status: "arrived",
      thread: { mode: "work", threadId: ARRIVING },
    });

    expect(moved.workingDirectories).toEqual(["report"]);
    expect(readdirSync(moved.destinationRoot)).toEqual(["report"]);
    expect(readdirSync(join(moved.destinationRoot, "report"))).toEqual(["agenda.md"]);
  });
});

function placementOf(offer: ThreadMoveOffer) {
  return {
    mode: offer.source.mode,
    ...(offer.destinationProjectId === undefined
      ? {}
      : { destinationProjectId: String(offer.destinationProjectId) }),
    ...(offer.repositoryRemotes === undefined
      ? {}
      : { repositoryRemotes: offer.repositoryRemotes }),
  };
}
