import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeProjectId,
  decodeWindowId,
  type CodeProject,
  type EventActor,
  type Project,
  type ProviderInstance,
  type WindowId,
} from "@octant/contracts";
import { BindingReceiptStore } from "./bindingReceiptStore";
import { openSqlite } from "./persistence/sqlitePort";
import { ProjectRootPort } from "./projectRootPort";
import type { ProjectServiceApi } from "./projectService";
import { ProviderFolderScanService } from "./providerFolderScanService";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function createGitRepo(root: string, remoteUrl?: string): void {
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  if (remoteUrl !== undefined) {
    writeFileSync(
      join(root, ".git", "config"),
      `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${remoteUrl}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
    );
  }
}

function createLinkedWorktree(mainRepo: string, worktreeRoot: string, name: string): void {
  const adminDir = join(mainRepo, ".git", "worktrees", name);
  mkdirSync(adminDir, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });
  writeFileSync(join(adminDir, "commondir"), "../..\n");
  writeFileSync(join(adminDir, "gitdir"), `${join(worktreeRoot, ".git")}\n`);
  writeFileSync(join(worktreeRoot, ".git"), `gitdir: ${adminDir}\n`);
}

function writeClaudeSession(
  claudeHome: string,
  cwd: string,
  sessionId: string,
  mtimeIso: string,
): string {
  const folderKey = cwd.replace(/[^A-Za-z0-9]/g, "-");
  const dir = join(claudeHome, "projects", folderKey);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sessionId}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ type: "user", cwd, message: { content: "hello" } })}\n`);
  const when = new Date(mtimeIso);
  utimesSync(file, when, when);
  return file;
}

function writeCodexSession(
  codexHome: string,
  cwd: string,
  sessionUuid: string,
  dayPath: readonly [string, string, string],
  mtimeIso: string,
): string {
  const dir = join(codexHome, "sessions", dayPath[0], dayPath[1], dayPath[2]);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-2026-11-21T09-00-00-${sessionUuid}.jsonl`);
  writeFileSync(
    file,
    `${JSON.stringify({
      type: "session_meta",
      payload: { id: sessionUuid, cwd, timestamp: mtimeIso },
    })}\n`,
  );
  const when = new Date(mtimeIso);
  utimesSync(file, when, when);
  return file;
}

function writePiSession(
  piSessionsDir: string,
  cwd: string,
  sessionId: string,
  mtimeIso: string,
): string {
  const folderName = `--${cwd.replace(/^[/\\]/u, "").replace(/[/\\:]/gu, "-")}--`;
  const dir = join(piSessionsDir, folderName);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `2026-11-21T09-00-00_${sessionId}.jsonl`);
  writeFileSync(
    file,
    `${JSON.stringify({ type: "session", id: sessionId, cwd, timestamp: mtimeIso })}\n`,
  );
  const when = new Date(mtimeIso);
  utimesSync(file, when, when);
  return file;
}

function writeOpenCodeDatabase(
  dataDir: string,
  rows: ReadonlyArray<{
    readonly id: string;
    readonly directory: string;
    readonly updatedMs: number;
  }>,
): string {
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, "opencode.db");
  const db = openSqlite(dbPath);
  try {
    db.exec(
      "CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, time_updated INTEGER, time_created INTEGER)",
    );
    const insert = db.prepare(
      "INSERT INTO session (id, parent_id, directory, time_updated, time_created) VALUES (?, NULL, ?, ?, ?)",
    );
    for (const row of rows) {
      insert.run(row.id, row.directory, row.updatedMs, row.updatedMs);
    }
  } finally {
    db.close();
  }
  return dbPath;
}

function createFakeProjectService(receipts: BindingReceiptStore, now: () => number = Date.now) {
  const created: Array<{
    readonly windowId: WindowId;
    readonly name: string;
    readonly canonicalRoot: string;
    readonly project: CodeProject;
    readonly command: Record<string, unknown>;
    readonly actor: EventActor | undefined;
  }> = [];

  const service: Pick<ProjectServiceApi, "executeProject"> = {
    executeProject: async (windowId, rawCommand, actor) => {
      const command = rawCommand as {
        readonly kind: string;
        readonly projectId: string;
        readonly name: string;
        readonly receiptId: string;
      };
      if (command.kind !== "create-code-project") {
        throw new Error(`Unexpected command: ${command.kind}`);
      }
      const binding = receipts.consume({
        receiptId: command.receiptId,
        authenticatedWindowId: windowId,
        projectType: "code",
        now: now(),
      });
      const timestamp = "2026-11-21T10:00:00.000Z" as CodeProject["createdAt"];
      const project: CodeProject = {
        id: decodeProjectId(command.projectId),
        name: command.name,
        type: "code",
        lifecycle: "active",
        pinned: false,
        rank: "0/1" as CodeProject["rank"],
        version: 1 as CodeProject["version"],
        createdAt: timestamp,
        updatedAt: timestamp,
        binding,
        bindingHistory: [
          {
            revisionId: randomUUID() as CodeProject["bindingHistory"][number]["revisionId"],
            revision: 1,
            currentBinding: binding,
            actor: { kind: "local-user", actorId: "octant-local-user" as never },
            changedAt: timestamp,
          },
        ],
        codeAccessPersistence: "current-session",
      };
      created.push({
        windowId,
        name: command.name,
        canonicalRoot: binding.canonicalRoot,
        project,
        command: command as unknown as Record<string, unknown>,
        actor,
      });
      return { kind: "code-project-created", project };
    },
  };

  return {
    service,
    created,
    activeCodeProjects: (): ReadonlyArray<Project> => created.map((entry) => entry.project),
  };
}

describe("ProviderFolderScanService", () => {
  it("lists folders the person's providers used, with no paths sent to the renderer beyond the chosen folder", async () => {
    const home = makeTempDir("octant-scan-home-");
    const repoA = join(home, "work", "alpha");
    const repoAClone = join(home, "backup", "alpha-clone");
    const repoWorktree = join(home, "work", "alpha-wt");
    const plainFolder = join(home, "notes-project");
    const downloadsRepo = join(home, "Downloads", "scratch-repo");

    createGitRepo(repoA, "git@github.com:acme/alpha.git");
    createGitRepo(repoAClone, "https://github.com/acme/alpha.git");
    createLinkedWorktree(repoA, repoWorktree, "alpha-wt");
    mkdirSync(plainFolder, { recursive: true });
    createGitRepo(downloadsRepo, "https://github.com/acme/scratch.git");

    // Default ~/.claude + extra ~/.claude-accounts/work + custom CLAUDE_CONFIG_DIR
    const defaultClaude = join(home, ".claude");
    const extraClaude = join(home, ".claude-accounts", "work");
    const envClaude = makeTempDir("octant-claude-env-");
    const claudeFile = writeClaudeSession(
      defaultClaude,
      repoA,
      "11111111-1111-4111-8111-111111111111",
      "2026-11-21T08:00:00.000Z",
    );
    const claudeBeforeMtime = statSync(claudeFile).mtimeMs;
    writeClaudeSession(
      extraClaude,
      repoAClone,
      "22222222-2222-4222-8222-222222222222",
      "2026-11-21T09:30:00.000Z",
    );
    writeClaudeSession(
      envClaude,
      repoWorktree,
      "33333333-3333-4333-8333-333333333333",
      "2026-11-21T09:45:00.000Z",
    );
    writeClaudeSession(
      defaultClaude,
      downloadsRepo,
      "44444444-4444-4444-8444-444444444444",
      "2026-11-21T09:50:00.000Z",
    );

    // Default ~/.codex + extra ~/.codex-accounts/team + custom CODEX_HOME
    const defaultCodex = join(home, ".codex");
    const extraCodex = join(home, ".codex-accounts", "team");
    const envCodex = makeTempDir("octant-codex-env-");
    writeCodexSession(
      defaultCodex,
      repoA,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      ["2026", "11", "21"],
      "2026-11-21T09:00:00.000Z",
    );
    writeCodexSession(
      extraCodex,
      plainFolder,
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      ["2026", "11", "20"],
      "2026-11-20T12:00:00.000Z",
    );
    writeCodexSession(
      envCodex,
      home,
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      ["2026", "11", "21"],
      "2026-11-21T09:59:00.000Z",
    );

    // OpenCode SQLite + Pi sessions
    const xdgDataHome = join(home, ".local", "share");
    writeOpenCodeDatabase(join(xdgDataHome, "opencode"), [
      { id: "ses_1", directory: plainFolder, updatedMs: Date.parse("2026-11-21T07:00:00.000Z") },
    ]);
    const piSessions = join(home, ".pi", "agent", "sessions");
    writePiSession(piSessions, repoAClone, "pi-session-1", "2026-11-21T10:00:00.000Z");

    const receipts = new BindingReceiptStore();
    const fakeProjects = createFakeProjectService(receipts);
    const scanner = new ProviderFolderScanService({
      homeDirectory: home,
      env: {
        CLAUDE_CONFIG_DIR: envClaude,
        CODEX_HOME: envCodex,
        XDG_DATA_HOME: xdgDataHome,
      },
      readProviderInstances: () => [],
      readActiveCodeProjects: () => fakeProjects.activeCodeProjects(),
      isHostStrict: () => false,
      bindingReceiptStore: receipts,
      projectRootPort: new ProjectRootPort(),
      projectService: fakeProjects.service,
      uuid: randomUUID,
      clock: () => "2026-11-21T10:05:00.000Z",
    });

    const windowId = decodeWindowId(randomUUID());
    const result = await scanner.scan(windowId);

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.stoppedEarly).toBe(false);

    // Clones of acme/alpha are grouped; linked worktree, Downloads, and home are excluded.
    expect(result.groups).toHaveLength(2);
    const alphaGroup = result.groups[0];
    const notesGroup = result.groups[1];
    expect(alphaGroup?.repository).toBe("acme/alpha");
    expect(alphaGroup?.label).toBe("acme/alpha");
    expect(alphaGroup?.providers).toEqual(["claude", "codex", "pi"]);
    expect(alphaGroup?.sessionCount).toBe(4);
    expect(alphaGroup?.folders).toHaveLength(2);
    expect(alphaGroup?.folders.map((folder) => folder.folderName)).toEqual([
      "alpha-clone",
      "alpha",
    ]);

    expect(notesGroup?.repository).toBeUndefined();
    expect(notesGroup?.label).toBe("notes-project");
    expect(notesGroup?.providers).toEqual(["codex", "opencode"]);
    expect(notesGroup?.sessionCount).toBe(2);

    // Verify ZERO raw host paths leak in the serialized response.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(home);
    expect(serialized).not.toContain(repoA);
    expect(serialized).not.toContain(repoAClone);
    expect(serialized).not.toContain(plainFolder);
    expect(serialized).not.toContain(repoWorktree);
    expect(serialized).not.toContain(downloadsRepo);
    expect(serialized).not.toContain("git@github.com");

    // Verify provider files were never modified.
    expect(statSync(claudeFile).mtimeMs).toBe(claudeBeforeMtime);
  });

  it("imports only the ticked folders as Code Projects", async () => {
    const home = makeTempDir("octant-import-home-");
    const repoOne = join(home, "code", "one");
    const repoTwo = join(home, "code", "two");
    const repoThree = join(home, "code", "three");
    createGitRepo(repoOne, "https://github.com/acme/one.git");
    createGitRepo(repoTwo, "https://github.com/acme/two.git");
    createGitRepo(repoThree);

    const registeredClaude = makeTempDir("octant-registered-claude-");
    writeClaudeSession(
      registeredClaude,
      repoOne,
      "11111111-1111-4111-8111-111111111111",
      "2026-11-21T10:00:00.000Z",
    );
    writeClaudeSession(
      registeredClaude,
      repoTwo,
      "22222222-2222-4222-8222-222222222222",
      "2026-11-21T09:00:00.000Z",
    );
    writeClaudeSession(
      registeredClaude,
      repoThree,
      "33333333-3333-4333-8333-333333333333",
      "2026-11-21T08:00:00.000Z",
    );

    const receipts = new BindingReceiptStore();
    const fakeProjects = createFakeProjectService(receipts);
    const registeredInstance = {
      id: randomUUID(),
      driverKind: "claude",
      configuration: { configDirectory: registeredClaude },
    } as never as ProviderInstance;

    const scanner = new ProviderFolderScanService({
      homeDirectory: home,
      env: {},
      readProviderInstances: () => [registeredInstance],
      readActiveCodeProjects: () => fakeProjects.activeCodeProjects(),
      isHostStrict: () => false,
      bindingReceiptStore: receipts,
      projectRootPort: new ProjectRootPort(),
      projectService: fakeProjects.service,
      uuid: randomUUID,
      clock: () => "2026-11-21T10:05:00.000Z",
    });

    const windowId = decodeWindowId(randomUUID());
    const otherWindowId = decodeWindowId(randomUUID());
    const scanned = await scanner.scan(windowId);
    expect(scanned.status).toBe("ready");
    if (scanned.status !== "ready") return;

    const idOne = scanned.groups.find((g) => g.label === "acme/one")?.folders[0]?.id;
    const idThree = scanned.groups.find((g) => g.label === "three")?.folders[0]?.id;
    expect(idOne).toBeDefined();
    expect(idThree).toBeDefined();
    if (idOne === undefined || idThree === undefined) return;

    // A different window cannot redeem this window's opaque folder IDs.
    const foreignAttempt = await scanner.importFolders(otherWindowId, { folderIds: [idOne] });
    expect(foreignAttempt.status).toBe("completed");
    if (foreignAttempt.status === "completed") {
      expect(foreignAttempt.results[0]?.status).toBe("refused");
    }
    expect(fakeProjects.created).toHaveLength(0);

    // Tick only one and three; leave two unticked.
    const imported = await scanner.importFolders(windowId, { folderIds: [idOne, idThree] });
    expect(imported.status).toBe("completed");
    if (imported.status !== "completed") return;
    expect(imported.results.map((r) => r.status)).toEqual(["created", "created"]);
    expect(fakeProjects.created.map((c) => c.canonicalRoot)).toEqual([repoOne, repoThree]);
    expect(fakeProjects.created.map((c) => c.name)).toEqual(["one", "three"]);
    // Created at first-run access level (no Full access persistence, no Project override).
    for (const entry of fakeProjects.created) {
      expect(entry.project.codeAccessPersistence).toBe("current-session");
      expect(entry.project.defaultPermissionMode).toBeUndefined();
      expect(entry.project.nativeProviders).toBeUndefined();
    }

    // Re-scanning marks imported folders as alreadyImported and keeps unticked folder unimported.
    const rescanned = await scanner.scan(windowId);
    expect(rescanned.status).toBe("ready");
    if (rescanned.status !== "ready") return;
    expect(rescanned.groups.find((g) => g.label === "acme/one")?.folders[0]?.alreadyImported).toBe(
      true,
    );
    expect(rescanned.groups.find((g) => g.label === "acme/two")?.folders[0]?.alreadyImported).toBe(
      false,
    );
    expect(rescanned.groups.find((g) => g.label === "three")?.folders[0]?.alreadyImported).toBe(
      true,
    );
  });

  it("says when the scan stopped early", async () => {
    const home = makeTempDir("octant-bounds-home-");
    const claudeHome = join(home, ".claude");
    for (let index = 0; index < 5; index += 1) {
      const folder = join(home, `project-${String(index)}`);
      mkdirSync(folder, { recursive: true });
      writeClaudeSession(
        claudeHome,
        folder,
        `11111111-1111-4111-8111-11111111111${String(index)}`,
        `2026-11-21T0${String(index)}:00:00.000Z`,
      );
    }

    const receipts = new BindingReceiptStore();
    const fakeProjects = createFakeProjectService(receipts);
    const windowId = decodeWindowId(randomUUID());

    const fileBounded = new ProviderFolderScanService({
      homeDirectory: home,
      env: {},
      readProviderInstances: () => [],
      readActiveCodeProjects: () => [],
      isHostStrict: () => false,
      bindingReceiptStore: receipts,
      projectRootPort: new ProjectRootPort(),
      projectService: fakeProjects.service,
      limits: { maxFiles: 2, maxEntries: 50, maxTimeMs: 10_000 },
    });
    const fileResult = await fileBounded.scan(windowId);
    expect(fileResult.status).toBe("ready");
    if (fileResult.status === "ready") {
      expect(fileResult.stoppedEarly).toBe(true);
      expect(fileResult.stoppedEarlyReason).toBe("file-limit");
      expect(fileResult.groups.length).toBeGreaterThan(0);
    }

    const entryBounded = new ProviderFolderScanService({
      homeDirectory: home,
      env: {},
      readProviderInstances: () => [],
      readActiveCodeProjects: () => [],
      isHostStrict: () => false,
      bindingReceiptStore: receipts,
      projectRootPort: new ProjectRootPort(),
      projectService: fakeProjects.service,
      limits: { maxFiles: 50, maxEntries: 2, maxTimeMs: 10_000 },
    });
    const entryResult = await entryBounded.scan(windowId);
    expect(entryResult.status).toBe("ready");
    if (entryResult.status === "ready") {
      expect(entryResult.stoppedEarly).toBe(true);
      expect(entryResult.stoppedEarlyReason).toBe("entry-limit");
      expect(entryResult.groups.length).toBe(2);
    }

    let ticks = 0;
    const timeBounded = new ProviderFolderScanService({
      homeDirectory: home,
      env: {},
      readProviderInstances: () => [],
      readActiveCodeProjects: () => [],
      isHostStrict: () => false,
      bindingReceiptStore: receipts,
      projectRootPort: new ProjectRootPort(),
      projectService: fakeProjects.service,
      now: () => {
        ticks += 100;
        return ticks;
      },
      limits: { maxFiles: 50, maxEntries: 50, maxTimeMs: 150 },
    });
    const timeResult = await timeBounded.scan(windowId);
    expect(timeResult.status).toBe("ready");
    if (timeResult.status === "ready") {
      expect(timeResult.stoppedEarly).toBe(true);
      expect(timeResult.stoppedEarlyReason).toBe("time-limit");
    }
  });

  it("hides the first-run project scan under Strict", async () => {
    const home = makeTempDir("octant-strict-home-");
    const repo = join(home, "code", "secret-app");
    createGitRepo(repo, "https://github.com/acme/secret-app.git");
    writeClaudeSession(
      join(home, ".claude"),
      repo,
      "11111111-1111-4111-8111-111111111111",
      "2026-11-21T10:00:00.000Z",
    );

    const receipts = new BindingReceiptStore();
    const fakeProjects = createFakeProjectService(receipts);
    let strict = false;
    const scanner = new ProviderFolderScanService({
      homeDirectory: home,
      env: {},
      readProviderInstances: () => [],
      readActiveCodeProjects: () => [],
      isHostStrict: () => strict,
      bindingReceiptStore: receipts,
      projectRootPort: new ProjectRootPort(),
      projectService: fakeProjects.service,
    });

    const windowId = decodeWindowId(randomUUID());
    const openScan = await scanner.scan(windowId);
    expect(openScan.status).toBe("ready");
    const folderId = openScan.status === "ready" ? openScan.groups[0]?.folders[0]?.id : undefined;
    expect(folderId).toBeDefined();

    // Turning Strict on hides scans and refuses importing previously scanned IDs.
    strict = true;
    const strictScan = await scanner.scan(windowId);
    expect(strictScan).toEqual({ status: "hidden", reason: "strict" });

    if (folderId !== undefined) {
      const strictImport = await scanner.importFolders(windowId, { folderIds: [folderId] });
      expect(strictImport.status).toBe("refused");
      if (strictImport.status === "refused") {
        expect(strictImport.reason).toBe("strict");
      }
    }
    expect(fakeProjects.created).toHaveLength(0);
  });

  it("scans OpenCode legacy JSON storage, registered Codex homes, and custom Pi session directories", async () => {
    const home = makeTempDir("octant-extra-homes-");
    const repoLegacy = join(home, "code", "legacy-app");
    const repoRegisteredCodex = join(home, "code", "codex-registered");
    const repoCustomPi = join(home, "code", "pi-custom");
    createGitRepo(repoLegacy, "ssh://git@gitlab.com/team/legacy-app.git");
    createGitRepo(repoRegisteredCodex);
    createGitRepo(repoCustomPi);

    const openCodeData = join(home, "custom-opencode-data");
    const legacyDir = join(openCodeData, "storage", "session", "proj-hash");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, "ses_legacy_1.json"),
      JSON.stringify({
        id: "ses_legacy_1",
        directory: repoLegacy,
        time: { updated: Date.parse("2026-11-21T09:00:00.000Z") },
      }),
    );

    const registeredCodexHome = makeTempDir("octant-registered-codex-");
    writeCodexSession(
      registeredCodexHome,
      repoRegisteredCodex,
      "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      ["2026", "11", "21"],
      "2026-11-21T08:30:00.000Z",
    );

    const customPiSessions = makeTempDir("octant-custom-pi-sessions-");
    writePiSession(customPiSessions, repoCustomPi, "pi-custom-1", "2026-11-21T08:00:00.000Z");

    const receipts = new BindingReceiptStore();
    const fakeProjects = createFakeProjectService(receipts);
    const registeredCodex = {
      id: randomUUID(),
      driverKind: "codex",
      configuration: { codexHome: registeredCodexHome },
    } as never as ProviderInstance;

    const scanner = new ProviderFolderScanService({
      homeDirectory: home,
      env: {
        OPENCODE_DATA: openCodeData,
        PI_CODING_AGENT_SESSION_DIR: customPiSessions,
      },
      readProviderInstances: () => [registeredCodex],
      readActiveCodeProjects: () => [],
      isHostStrict: () => false,
      bindingReceiptStore: receipts,
      projectRootPort: new ProjectRootPort(),
      projectService: fakeProjects.service,
    });

    const result = await scanner.scan(decodeWindowId(randomUUID()));
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.groups.map((group) => group.label)).toEqual([
      "team/legacy-app",
      "codex-registered",
      "pi-custom",
    ]);
    expect(result.groups[0]?.providers).toEqual(["opencode"]);
    expect(result.groups[1]?.providers).toEqual(["codex"]);
    expect(result.groups[2]?.providers).toEqual(["pi"]);
  });

  it("refuses importing plain non-Git folders when Code requires Git and allows them when Git is optional", async () => {
    const home = makeTempDir("octant-plain-git-");
    const plainDir = join(home, "notes");
    mkdirSync(plainDir, { recursive: true });
    writeClaudeSession(
      join(home, ".claude"),
      plainDir,
      "11111111-1111-4111-8111-111111111111",
      "2026-11-21T10:00:00.000Z",
    );

    const receipts = new BindingReceiptStore();
    const fakeProjects = createFakeProjectService(receipts);
    let requireGit = true;
    const scanner = new ProviderFolderScanService({
      homeDirectory: home,
      env: {},
      readProviderInstances: () => [],
      readActiveCodeProjects: () => fakeProjects.activeCodeProjects(),
      isHostStrict: () => false,
      requireGitRepository: () => requireGit,
      bindingReceiptStore: receipts,
      projectRootPort: new ProjectRootPort(),
      projectService: fakeProjects.service,
    });

    const windowId = decodeWindowId(randomUUID());
    const scanned = await scanner.scan(windowId);
    expect(scanned.status).toBe("ready");
    if (scanned.status !== "ready") return;
    expect(scanned.requireGitRepository).toBe(true);
    const folder = scanned.groups[0]?.folders[0];
    expect(folder?.isGitRepository).toBe(false);
    if (folder === undefined) return;

    const refused = await scanner.importFolders(windowId, { folderIds: [folder.id] });
    expect(refused.status).toBe("completed");
    if (refused.status === "completed") {
      expect(refused.results[0]).toMatchObject({ status: "refused", reason: "requires-git" });
    }
    expect(fakeProjects.created).toHaveLength(0);

    requireGit = false;
    const allowed = await scanner.importFolders(windowId, { folderIds: [folder.id] });
    expect(allowed.status).toBe("completed");
    if (allowed.status === "completed") {
      expect(allowed.results[0]?.status).toBe("created");
    }
    expect(fakeProjects.created).toHaveLength(1);
  });

  it("keeps an initialized Git submodule as its own candidate instead of binding the parent repo", async () => {
    const home = makeTempDir("octant-submodule-");
    const parentRepo = join(home, "product");
    const submoduleDir = join(parentRepo, "vendor", "library");
    const moduleGitDir = join(parentRepo, ".git", "modules", "vendor", "library");
    createGitRepo(parentRepo, "https://github.com/acme/product.git");
    mkdirSync(moduleGitDir, { recursive: true });
    writeFileSync(
      join(moduleGitDir, "config"),
      `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = git@github.com:acme/library.git\n`,
    );
    mkdirSync(submoduleDir, { recursive: true });
    writeFileSync(join(submoduleDir, ".git"), `gitdir: ${moduleGitDir}\n`);

    writeClaudeSession(
      join(home, ".claude"),
      submoduleDir,
      "11111111-1111-4111-8111-111111111111",
      "2026-11-21T10:00:00.000Z",
    );

    const receipts = new BindingReceiptStore();
    const fakeProjects = createFakeProjectService(receipts);
    const scanner = new ProviderFolderScanService({
      homeDirectory: home,
      env: {},
      readProviderInstances: () => [],
      readActiveCodeProjects: () => fakeProjects.activeCodeProjects(),
      isHostStrict: () => false,
      bindingReceiptStore: receipts,
      projectRootPort: new ProjectRootPort(),
      projectService: fakeProjects.service,
    });

    const windowId = decodeWindowId(randomUUID());
    const scanned = await scanner.scan(windowId);
    expect(scanned.status).toBe("ready");
    if (scanned.status !== "ready") return;
    expect(scanned.groups).toHaveLength(1);
    expect(scanned.groups[0]?.label).toBe("acme/library");
    const folderId = scanned.groups[0]?.folders[0]?.id;
    expect(folderId).toBeDefined();
    if (folderId === undefined) return;

    const imported = await scanner.importFolders(windowId, { folderIds: [folderId] });
    expect(imported.status).toBe("completed");
    expect(fakeProjects.created.map((entry) => entry.canonicalRoot)).toEqual([submoduleDir]);
  });

  it("discovers folders whose Codex sessions live only in archived_sessions without double counting duplicates", async () => {
    const home = makeTempDir("octant-codex-archive-");
    const archivedOnlyRepo = join(home, "code", "archived-widget");
    const sharedRepo = join(home, "code", "shared-widget");
    createGitRepo(archivedOnlyRepo, "https://github.com/acme/archived-widget.git");
    createGitRepo(sharedRepo, "https://github.com/acme/shared-widget.git");
    const codexHome = join(home, ".codex");
    const archiveOnlySessionUuid = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const duplicateSessionUuid = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const archiveDir = join(codexHome, "archived_sessions");
    mkdirSync(archiveDir, { recursive: true });
    const archiveOnlyFile = join(
      archiveDir,
      `rollout-2026-11-20T09-00-00-${archiveOnlySessionUuid}.jsonl`,
    );
    writeFileSync(
      archiveOnlyFile,
      `${JSON.stringify({
        type: "session_meta",
        payload: {
          id: archiveOnlySessionUuid,
          cwd: archivedOnlyRepo,
          timestamp: "2026-11-20T09:00:00.000Z",
        },
      })}\n`,
    );
    const archiveOnlyTime = new Date("2026-11-20T09:00:00.000Z");
    utimesSync(archiveOnlyFile, archiveOnlyTime, archiveOnlyTime);
    const duplicateArchiveFile = join(
      archiveDir,
      `rollout-2026-11-20T08-00-00-${duplicateSessionUuid}.jsonl`,
    );
    writeFileSync(
      duplicateArchiveFile,
      `${JSON.stringify({
        type: "session_meta",
        payload: {
          id: duplicateSessionUuid,
          cwd: sharedRepo,
          timestamp: "2026-11-20T08:00:00.000Z",
        },
      })}\n`,
    );
    const duplicateTime = new Date("2026-11-20T08:00:00.000Z");
    utimesSync(duplicateArchiveFile, duplicateTime, duplicateTime);
    // Same session ID also in active sessions must deduplicate to 1 session.
    writeCodexSession(
      codexHome,
      sharedRepo,
      duplicateSessionUuid,
      ["2026", "11", "20"],
      "2026-11-20T08:00:00.000Z",
    );

    const receipts = new BindingReceiptStore();
    const fakeProjects = createFakeProjectService(receipts);
    const scanner = new ProviderFolderScanService({
      homeDirectory: home,
      env: {},
      readProviderInstances: () => [],
      readActiveCodeProjects: () => [],
      isHostStrict: () => false,
      bindingReceiptStore: receipts,
      projectRootPort: new ProjectRootPort(),
      projectService: fakeProjects.service,
    });

    const scanned = await scanner.scan(decodeWindowId(randomUUID()));
    expect(scanned.status).toBe("ready");
    if (scanned.status !== "ready") return;
    expect(scanned.groups.map((group) => [group.label, group.sessionCount])).toEqual([
      ["acme/archived-widget", 1],
      ["acme/shared-widget", 1],
    ]);
  });

  it("stops an in-flight scan or import when Strict turns on mid-operation", async () => {
    const home = makeTempDir("octant-strict-race-");
    const repoOne = join(home, "code", "one");
    const repoTwo = join(home, "code", "two");
    createGitRepo(repoOne, "https://github.com/acme/one.git");
    createGitRepo(repoTwo, "https://github.com/acme/two.git");
    writeClaudeSession(
      join(home, ".claude"),
      repoOne,
      "11111111-1111-4111-8111-111111111111",
      "2026-11-21T10:00:00.000Z",
    );
    writeClaudeSession(
      join(home, ".claude"),
      repoTwo,
      "22222222-2222-4222-8222-222222222222",
      "2026-11-21T09:00:00.000Z",
    );

    const receipts = new BindingReceiptStore();
    const fakeProjects = createFakeProjectService(receipts);
    let strictChecks = 0;
    const midScanStrict = new ProviderFolderScanService({
      homeDirectory: home,
      env: {},
      readProviderInstances: () => [],
      readActiveCodeProjects: () => [],
      isHostStrict: () => {
        strictChecks += 1;
        return strictChecks > 2;
      },
      bindingReceiptStore: receipts,
      projectRootPort: new ProjectRootPort(),
      projectService: fakeProjects.service,
    });
    const scanResult = await midScanStrict.scan(decodeWindowId(randomUUID()));
    expect(scanResult).toEqual({ status: "hidden", reason: "strict" });

    // Enabling Strict during importFolders refuses remaining folders without creating Projects.
    let strict = false;
    const projectRootPort: Pick<ProjectRootPort, "validate"> = {
      validate: async (projectType, candidate) => {
        const result = await new ProjectRootPort().validate(projectType, candidate);
        strict = true;
        return result;
      },
    };
    const midImportScanner = new ProviderFolderScanService({
      homeDirectory: home,
      env: {},
      readProviderInstances: () => [],
      readActiveCodeProjects: () => [],
      isHostStrict: () => strict,
      bindingReceiptStore: receipts,
      projectRootPort,
      projectService: fakeProjects.service,
    });
    const windowId = decodeWindowId(randomUUID());
    const ready = await midImportScanner.scan(windowId);
    expect(ready.status).toBe("ready");
    if (ready.status !== "ready") return;
    const ids = ready.groups.flatMap((group) => group.folders.map((folder) => folder.id));
    const [first, ...rest] = ids;
    expect(first).toBeDefined();
    if (first === undefined) return;
    const importResult = await midImportScanner.importFolders(windowId, {
      folderIds: [first, ...rest],
    });
    expect(importResult).toMatchObject({ status: "refused", reason: "strict" });
    expect(fakeProjects.created).toHaveLength(0);
  });

  it("refuses importing a folder that was replaced by a symlink or swapped before import", async () => {
    const home = makeTempDir("octant-toctou-");
    const scannedRepo = join(home, "code", "target-repo");
    const movedAside = join(home, "code", "moved-aside");
    const unselectedRepo = join(home, "code", "unselected-secret");
    createGitRepo(scannedRepo, "https://github.com/acme/target.git");
    createGitRepo(unselectedRepo, "https://github.com/acme/secret.git");
    writeClaudeSession(
      join(home, ".claude"),
      scannedRepo,
      "11111111-1111-4111-8111-111111111111",
      "2026-11-21T10:00:00.000Z",
    );

    const receipts = new BindingReceiptStore();
    const fakeProjects = createFakeProjectService(receipts);
    const scanner = new ProviderFolderScanService({
      homeDirectory: home,
      env: {},
      readProviderInstances: () => [],
      readActiveCodeProjects: () => [],
      isHostStrict: () => false,
      bindingReceiptStore: receipts,
      projectRootPort: new ProjectRootPort(),
      projectService: fakeProjects.service,
    });

    const windowId = decodeWindowId(randomUUID());
    const scanned = await scanner.scan(windowId);
    expect(scanned.status).toBe("ready");
    if (scanned.status !== "ready") return;
    const folderId = scanned.groups[0]?.folders[0]?.id;
    expect(folderId).toBeDefined();
    if (folderId === undefined) return;

    // Replace the discovered directory with a symlink to an unselected directory.
    renameSync(scannedRepo, movedAside);
    symlinkSync(unselectedRepo, scannedRepo);

    const imported = await scanner.importFolders(windowId, { folderIds: [folderId] });
    expect(imported.status).toBe("completed");
    if (imported.status === "completed") {
      expect(imported.results[0]).toMatchObject({ status: "refused", reason: "unavailable" });
    }
    expect(fakeProjects.created).toHaveLength(0);
  });

  it("keeps the newer scan's folder IDs importable when an older overlapping or aborted scan finishes later", async () => {
    const home = makeTempDir("octant-scan-overlap-");
    const repo = join(home, "code", "overlap-repo");
    createGitRepo(repo, "https://github.com/acme/overlap.git");
    writeClaudeSession(
      join(home, ".claude"),
      repo,
      "11111111-1111-4111-8111-111111111111",
      "2026-11-21T10:00:00.000Z",
    );

    let callCount = 0;
    let markScan1Paused: (() => void) | undefined;
    const scan1Paused = new Promise<void>((resolve) => {
      markScan1Paused = resolve;
    });
    let releaseScan1: ((instances: ReadonlyArray<ProviderInstance>) => void) | undefined;
    const scan1Gate = new Promise<ReadonlyArray<ProviderInstance>>((resolve) => {
      releaseScan1 = resolve;
    });
    let markScan3Paused: (() => void) | undefined;
    const scan3Paused = new Promise<void>((resolve) => {
      markScan3Paused = resolve;
    });
    let releaseScan3: ((instances: ReadonlyArray<ProviderInstance>) => void) | undefined;
    const scan3Gate = new Promise<ReadonlyArray<ProviderInstance>>((resolve) => {
      releaseScan3 = resolve;
    });

    const receipts = new BindingReceiptStore();
    const fakeProjects = createFakeProjectService(receipts);
    const scanner = new ProviderFolderScanService({
      homeDirectory: home,
      env: {},
      readProviderInstances: () => {
        callCount += 1;
        if (callCount === 1) {
          markScan1Paused?.();
          return scan1Gate;
        }
        if (callCount === 3) {
          markScan3Paused?.();
          return scan3Gate;
        }
        return [];
      },
      readActiveCodeProjects: () => [],
      isHostStrict: () => false,
      bindingReceiptStore: receipts,
      projectRootPort: new ProjectRootPort(),
      projectService: fakeProjects.service,
    });

    const windowId = decodeWindowId(randomUUID());

    // Start scan #1 and pause it in-flight.
    const scan1Promise = scanner.scan(windowId);
    await scan1Paused;

    // Start scan #2 for the same window and let it complete first.
    const scan2 = await scanner.scan(windowId);
    expect(scan2.status).toBe("ready");
    if (scan2.status !== "ready") return;
    const scan2FolderId = scan2.groups[0]?.folders[0]?.id;
    expect(scan2FolderId).toBeDefined();
    if (scan2FolderId === undefined) return;

    // Let older scan #1 finish after scan #2 already committed its candidates.
    releaseScan1?.([]);
    await scan1Promise;

    // Also start scan #3 and abort its signal mid-flight; it must not wipe scan #2's IDs either.
    const abortController = new AbortController();
    const scan3Promise = scanner.scan(windowId, abortController.signal);
    await scan3Paused;
    abortController.abort();
    releaseScan3?.([]);
    await scan3Promise;

    const imported = await scanner.importFolders(windowId, { folderIds: [scan2FolderId] });
    expect(imported.status).toBe("completed");
    if (imported.status === "completed") {
      expect(imported.results[0]).toMatchObject({ status: "created" });
    }
    expect(fakeProjects.created.map((entry) => entry.canonicalRoot)).toEqual([repo]);
  });

  it("stops reading remaining session files immediately when a scan is canceled", async () => {
    const home = makeTempDir("octant-scan-cancel-");
    const claudeProjectDir = join(home, ".claude", "projects", "-tmp-empty");
    mkdirSync(claudeProjectDir, { recursive: true });
    for (let index = 0; index < 12; index += 1) {
      writeFileSync(
        join(claudeProjectDir, `session-${String(index).padStart(2, "0")}.jsonl`),
        `${JSON.stringify({ type: "system", message: "no working directory here" })}\n`,
      );
    }

    const abortController = new AbortController();
    let nowCalls = 0;
    const receipts = new BindingReceiptStore();
    const fakeProjects = createFakeProjectService(receipts);
    const scanner = new ProviderFolderScanService({
      homeDirectory: home,
      env: {},
      readProviderInstances: () => [],
      readActiveCodeProjects: () => [],
      isHostStrict: () => false,
      bindingReceiptStore: receipts,
      projectRootPort: new ProjectRootPort(),
      projectService: fakeProjects.service,
      now: () => {
        nowCalls += 1;
        // Abort after the first file budget check inside Claude discovery.
        if (nowCalls === 7) abortController.abort();
        return 1_000;
      },
    });

    const scanned = await scanner.scan(decodeWindowId(randomUUID()), abortController.signal);
    expect(scanned.status).toBe("ready");
    if (scanned.status === "ready") {
      expect(scanned.groups).toEqual([]);
    }
    // Stopping immediately after file #1 avoids inspecting the remaining 11 files.
    expect(nowCalls).toBeLessThanOrEqual(8);
  });

  it("evicts expired closed-window candidates during a later scan and imports the later scan's folder", async () => {
    const home = makeTempDir("octant-scan-expiry-");
    const repo = join(home, "code", "ephemeral");
    createGitRepo(repo, "https://github.com/acme/ephemeral.git");
    writeClaudeSession(
      join(home, ".claude"),
      repo,
      "11111111-1111-4111-8111-111111111111",
      "2026-11-21T10:00:00.000Z",
    );

    const initialTimeMs = 10_000;
    let currentTimeMs = initialTimeMs;
    const clock = () => currentTimeMs;
    const receipts = new BindingReceiptStore();
    const fakeProjects = createFakeProjectService(receipts, clock);
    const scanner = new ProviderFolderScanService({
      homeDirectory: home,
      env: {},
      readProviderInstances: () => [],
      readActiveCodeProjects: () => [],
      isHostStrict: () => false,
      bindingReceiptStore: receipts,
      projectRootPort: new ProjectRootPort(),
      projectService: fakeProjects.service,
      now: clock,
    });

    const closedWindowId = decodeWindowId(randomUUID());
    const first = await scanner.scan(closedWindowId);
    expect(first.status).toBe("ready");
    if (first.status !== "ready") return;
    const expiredFolderId = first.groups[0]?.folders[0]?.id;
    expect(expiredFolderId).toBeDefined();
    if (expiredFolderId === undefined) return;

    // Advance past the 10-minute candidate TTL and scan from a different window.
    const activeScanTimeMs = initialTimeMs + 11 * 60_000;
    currentTimeMs = activeScanTimeMs;
    const activeWindowId = decodeWindowId(randomUUID());
    const second = await scanner.scan(activeWindowId);
    expect(second.status).toBe("ready");
    if (second.status !== "ready") return;
    const freshFolderId = second.groups[0]?.folders[0]?.id;
    expect(freshFolderId).toBeDefined();
    if (freshFolderId === undefined) return;

    // Rewind the clock before the first scan's TTL so importFolders' own expiry
    // check cannot mask a missing scan-time eviction.
    currentTimeMs = initialTimeMs;
    const staleImport = await scanner.importFolders(closedWindowId, {
      folderIds: [expiredFolderId],
    });
    expect(staleImport.status).toBe("completed");
    if (staleImport.status === "completed") {
      expect(staleImport.results[0]).toMatchObject({ status: "refused", reason: "not-found" });
    }
    expect(fakeProjects.created).toHaveLength(0);

    // Importing the fresh folder ID from the second scan still succeeds.
    currentTimeMs = activeScanTimeMs;
    const freshImport = await scanner.importFolders(activeWindowId, {
      folderIds: [freshFolderId],
    });
    expect(freshImport.status).toBe("completed");
    if (freshImport.status === "completed") {
      expect(freshImport.results[0]).toMatchObject({ status: "created" });
    }
    expect(fakeProjects.created.map((entry) => entry.canonicalRoot)).toEqual([repo]);
  });
});
