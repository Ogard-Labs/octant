import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActorId,
  ReplayCursor,
  decodeCodeTerminalId,
  decodeProject,
  decodeProjectId,
  decodeWindowId,
  type Project,
  type ProjectId,
  type ProjectTerminalCommand,
  type ProjectTerminalResult,
} from "@octant/contracts";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import {
  ProjectTerminalProjection,
  readRunningProjectTerminals,
} from "../persistence/projectTerminalProjection";
import { rebuildProjection } from "../persistence/projection";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { ProjectTerminalService } from "./projectTerminalService";
import type {
  TerminalLaunchRequest,
  TerminalOutputEmission,
  TerminalSnapshot,
} from "./terminalService";

const now = "2026-09-25T10:00:00.000Z";
const decodeReplayCursor = Schema.decodeUnknownSync(ReplayCursor);
const ids = {
  actor: "90000000-0000-4000-8000-000000000001",
  project: "90000000-0000-4000-8000-000000000002",
  otherProject: "90000000-0000-4000-8000-000000000003",
  revision: "90000000-0000-4000-8000-000000000004",
  relinked: "90000000-0000-4000-8000-000000000005",
  window: "90000000-0000-4000-8000-000000000006",
  otherWindow: "90000000-0000-4000-8000-000000000007",
  terminal: "90000000-0000-4000-8000-000000000008",
  secondTerminal: "90000000-0000-4000-8000-000000000009",
} as const;
const actor = {
  kind: "local-user",
  actorId: Schema.decodeUnknownSync(ActorId)(ids.actor),
} as const;
const projectId = decodeProjectId(ids.project);
const windowId = decodeWindowId(ids.window);
const otherWindowId = decodeWindowId(ids.otherWindow);
const terminalId = decodeCodeTerminalId(ids.terminal);
const root = "/Users/person/code/octant";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function project(
  overrides: {
    readonly id?: string;
    readonly type?: "code" | "work";
    readonly lifecycle?: "active" | "archived";
    readonly revisionId?: string;
    readonly codeAccessPersistence?: "current-session" | "project-default";
  } = {},
): Project {
  const actor = { kind: "local-user", actorId: ids.actor } as const;
  return decodeProject({
    id: overrides.id ?? ids.project,
    name: "Octant",
    lifecycle: overrides.lifecycle ?? "active",
    pinned: false,
    rank: "1/1",
    version: 1,
    createdAt: now,
    updatedAt: now,
    type: overrides.type ?? "code",
    binding: { canonicalRoot: root },
    bindingHistory: [
      {
        revisionId: overrides.revisionId ?? ids.revision,
        revision: 1,
        currentBinding: { canonicalRoot: root },
        actor,
        changedAt: now,
      },
    ],
    ...((overrides.type ?? "code") === "code"
      ? { codeAccessPersistence: overrides.codeAccessPersistence ?? "current-session" }
      : {}),
  });
}

/** A shell stand-in: records what the service asked for and prints on demand. */
class FakeTerminals {
  readonly launches: TerminalLaunchRequest[] = [];
  readonly writes: string[] = [];
  readonly terminated: string[] = [];
  #output = "";
  #status: TerminalSnapshot["status"] = "running";
  #exitCode: number | undefined;
  readonly #listeners = new Set<(emission: TerminalOutputEmission) => void>();

  async launch(request: TerminalLaunchRequest): Promise<TerminalSnapshot> {
    this.launches.push(request);
    this.#status = "running";
    return this.#snapshot(request.terminalId);
  }
  observe(_terminalId: string, listener: (emission: TerminalOutputEmission) => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  readSince(terminalId: string, afterCharacters: number) {
    return {
      text: this.#output.slice(afterCharacters),
      replace: false,
      characters: this.#output.length,
      snapshot: this.#snapshot(terminalId),
    };
  }
  write(_terminalId: string, data: string) {
    if (this.#status !== "running") throw new Error("Terminal is not running.");
    this.writes.push(data);
    this.#output += data;
  }
  resize() {}
  async terminate(terminalId: string): Promise<TerminalSnapshot> {
    this.terminated.push(terminalId);
    if (this.#status === "running") this.#status = "interrupted";
    return this.#snapshot(terminalId);
  }
  exit(terminalId: string, exitCode: number) {
    this.#status = "exited";
    this.#exitCode = exitCode;
    for (const listener of this.#listeners) {
      listener({ text: "", replace: false, snapshot: this.#snapshot(terminalId) });
    }
  }
  #snapshot(terminalId: string): TerminalSnapshot {
    return {
      terminalId,
      status: this.#status,
      canRerun: this.#status !== "running",
      ...(this.#exitCode === undefined ? {} : { exitCode: this.#exitCode }),
      transcript: {
        chunks: [this.#output],
        byteLength: this.#output.length,
        truncated: false,
        characters: this.#output.length,
      },
    };
  }
}

function harness(
  options: {
    readonly projects?: Map<string, Project>;
    readonly access?: (window: string, project: string) => boolean;
    readonly root?: string | undefined;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "octant-project-terminal-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
  const projects = options.projects ?? new Map([[ids.project, project()]]);
  const terminals = new FakeTerminals();
  let sequence = 0;
  const service = new ProjectTerminalService({
    terminals,
    readProject: (id) => projects.get(String(id)),
    canAccessProject: (window, id) =>
      options.access?.(String(window), String(id)) ??
      (String(window) === ids.window && String(id) === ids.project),
    resolveRoot: async () => ("root" in options ? options.root : root),
    readRunning: () => readRunningProjectTerminals(connection),
    journal,
    actor,
    uuid: () => `91000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    clock: () => now,
  });
  const events = () =>
    journal
      .replay(decodeReplayCursor({ afterSequence: 0, limit: 100 }))
      .filter((event) => event.aggregateType === "project-terminal")
      .map((event) => ({ name: event.eventName, payload: event.payload }));
  return { service, terminals, journal, connection, projects, events };
}

const start = (overrides: Partial<{ projectId: ProjectId; terminalId: string }> = {}) =>
  ({
    kind: "start",
    projectId: overrides.projectId ?? projectId,
    terminalId: decodeCodeTerminalId(overrides.terminalId ?? ids.terminal),
    columns: 100,
    rows: 30,
  }) satisfies ProjectTerminalCommand;

function refusal(result: ProjectTerminalResult) {
  return result.kind === "project-terminal-refused" ? result.reason : undefined;
}

describe("Project terminals", () => {
  it("opens the person's shell at the Project's own root with no credentials and records who opened it", async () => {
    const { service, terminals, events } = harness();

    const result = await service.execute(windowId, "local-window", start());

    expect(result).toMatchObject({
      kind: "project-terminal",
      terminal: { projectId: ids.project, terminalId: ids.terminal, state: "running" },
    });
    expect(terminals.launches).toEqual([
      expect.objectContaining({
        cwd: root,
        credentialReferences: [],
        executionPolicy: "approval-gated",
        stateScope: `project:${ids.project}`,
      }),
    ]);
    expect(events()).toEqual([
      {
        name: "code.project-terminal-started@1",
        payload: expect.objectContaining({
          projectId: ids.project,
          terminalId: ids.terminal,
          windowId: ids.window,
          bindingRevisionId: ids.revision,
          posture: "approval-gated",
        }),
      },
    ]);
  });

  it("runs under Full access only where the Project remembers it", async () => {
    const { service, terminals } = harness({
      projects: new Map([[ids.project, project({ codeAccessPersistence: "project-default" })]]),
    });

    const result = await service.execute(windowId, "local-window", start());

    expect(result).toMatchObject({ terminal: { posture: "full-access" } });
    expect(terminals.launches[0]?.executionPolicy).toBe("full-access");
  });

  it("refuses a paired device outright, even for a shell its window already owns", async () => {
    const { service, terminals, events } = harness();
    await service.execute(windowId, "local-window", start());

    const started = await service.execute(
      windowId,
      "remote-device",
      start({ terminalId: ids.secondTerminal }),
    );
    const typed = await service.execute(windowId, "remote-device", {
      kind: "write",
      projectId,
      terminalId,
      data: "rm -rf .\r",
    });

    expect(refusal(started)).toBe("unauthorized");
    expect(refusal(typed)).toBe("unauthorized");
    expect(terminals.launches).toHaveLength(1);
    expect(terminals.writes).toEqual([]);
    expect(events()).toHaveLength(1);
  });

  it("gives a Work Project no shell, so Work never gains one this way", async () => {
    const { service, terminals } = harness({
      projects: new Map([[ids.project, project({ type: "work" })]]),
      access: () => true,
    });

    const result = await service.execute(windowId, "local-window", start());

    expect(refusal(result)).toBe("unavailable");
    expect(terminals.launches).toEqual([]);
  });

  it("refuses a Project this window has not opened, and an archived one", async () => {
    const projects = new Map([
      [ids.project, project()],
      [ids.otherProject, project({ id: ids.otherProject, lifecycle: "archived" })],
    ]);
    const { service, terminals } = harness({ projects });

    const elsewhere = await service.execute(otherWindowId, "local-window", start());
    const archived = await service.execute(
      windowId,
      "local-window",
      start({ projectId: decodeProjectId(ids.otherProject) }),
    );

    expect(refusal(elsewhere)).toBe("unauthorized");
    expect(refusal(archived)).toBe("authority-revoked");
    expect(terminals.launches).toEqual([]);
  });

  it("does not start a shell when the Project's folder cannot be verified", async () => {
    const { service, terminals, events } = harness({ root: undefined });

    const result = await service.execute(windowId, "local-window", start());

    expect(refusal(result)).toBe("unavailable");
    expect(terminals.launches).toEqual([]);
    expect(events()).toEqual([]);
  });

  it("lets only the window that opened the shell attach to it or type into it", async () => {
    const { service, terminals } = harness({ access: () => true });
    await service.execute(windowId, "local-window", start());

    const attached = await service.execute(otherWindowId, "local-window", {
      kind: "attach",
      projectId,
      terminalId,
    });
    const typed = await service.execute(otherWindowId, "local-window", {
      kind: "write",
      projectId,
      terminalId,
      data: "ls\r",
    });
    const own = await service.execute(windowId, "local-window", {
      kind: "write",
      projectId,
      terminalId,
      data: "pwd\r",
    });

    expect(refusal(attached)).toBe("unauthorized");
    expect(refusal(typed)).toBe("unauthorized");
    expect(own.kind).toBe("project-terminal");
    expect(terminals.writes).toEqual(["pwd\r"]);
  });

  it("hands back what the shell printed after the reader's offset", async () => {
    const { service } = harness();
    await service.execute(windowId, "local-window", start());
    await service.execute(windowId, "local-window", {
      kind: "write",
      projectId,
      terminalId,
      data: "hello",
    });

    const read = await service.execute(windowId, "local-window", {
      kind: "read-output",
      projectId,
      terminalId,
      afterCharacters: 2,
    });

    expect(read).toMatchObject({ output: { text: "llo", replace: false, characters: 5 } });
  });

  it("keeps the shell when the window switches Project, and refuses it until the window comes back", async () => {
    let bound: string = ids.project;
    const { service, terminals } = harness({
      access: (window, id) => window === ids.window && id === bound,
    });
    await service.execute(windowId, "local-window", start());

    bound = ids.otherProject;
    const away = await service.execute(windowId, "local-window", {
      kind: "write",
      projectId,
      terminalId,
      data: "ls\r",
    });
    bound = ids.project;
    const back = await service.execute(windowId, "local-window", {
      kind: "write",
      projectId,
      terminalId,
      data: "ls\r",
    });

    expect(refusal(away)).toBe("unauthorized");
    expect(back.kind).toBe("project-terminal");
    expect(terminals.terminated).toEqual([]);
  });

  it("ends every shell of an archived Project and refuses it afterwards", async () => {
    const { service, terminals, projects, events } = harness();
    await service.execute(windowId, "local-window", start());

    projects.set(ids.project, project({ lifecycle: "archived" }));
    await service.settleProject(projectId);
    const typed = await service.execute(windowId, "local-window", {
      kind: "write",
      projectId,
      terminalId,
      data: "ls\r",
    });

    expect(terminals.terminated).toEqual([ids.terminal]);
    expect(refusal(typed)).toBe("authority-revoked");
    expect(events().map((event) => event.payload)).toEqual([
      expect.objectContaining({ kind: "project-terminal-started" }),
      expect.objectContaining({ kind: "project-terminal-ended", reason: "authority-revoked" }),
    ]);
  });

  it("ends a shell whose Project was relinked the moment a command finds the new root", async () => {
    const { service, terminals, projects, events } = harness();
    await service.execute(windowId, "local-window", start());

    projects.set(ids.project, project({ revisionId: ids.relinked }));
    const typed = await service.execute(windowId, "local-window", {
      kind: "write",
      projectId,
      terminalId,
      data: "ls\r",
    });

    expect(refusal(typed)).toBe("authority-revoked");
    expect(terminals.writes).toEqual([]);
    expect(terminals.terminated).toEqual([ids.terminal]);
    expect(events().at(-1)?.payload).toMatchObject({ reason: "authority-revoked" });
  });

  it("leaves a shell running when its Project changes something that is not its folder", async () => {
    const { service, terminals } = harness();
    await service.execute(windowId, "local-window", start());

    await service.settleProject(projectId);

    expect(terminals.terminated).toEqual([]);
  });

  it("records a shell that exits once, even when a stop races the exit", async () => {
    const { service, terminals, events } = harness();
    await service.execute(windowId, "local-window", start());

    terminals.exit(ids.terminal, 0);
    await service.execute(windowId, "local-window", { kind: "stop", projectId, terminalId });

    const ended = events().filter((event) => event.name === "code.project-terminal-ended@1");
    expect(ended).toEqual([
      {
        name: "code.project-terminal-ended@1",
        payload: expect.objectContaining({ reason: "exited", exitCode: 0 }),
      },
    ]);
  });

  it("ends a shell still recorded as running after a restart, and replays to the same record", async () => {
    const { service, connection, journal, events } = harness();
    await service.execute(windowId, "local-window", start());
    expect(readRunningProjectTerminals(connection)).toHaveLength(1);

    const restarted = new ProjectTerminalService({
      terminals: new FakeTerminals(),
      readProject: () => project(),
      canAccessProject: () => true,
      resolveRoot: async () => root,
      readRunning: () => readRunningProjectTerminals(connection),
      journal,
      actor,
      uuid: () => "92000000-0000-4000-8000-000000000001",
      clock: () => now,
    });
    restarted.reconcile();

    expect(events().at(-1)?.payload).toMatchObject({ reason: "host-restarted" });
    expect(readRunningProjectTerminals(connection)).toEqual([]);
    rebuildProjection({
      connection,
      journal,
      projection: new ProjectTerminalProjection(),
      clock: () => now,
    });
    expect(readRunningProjectTerminals(connection)).toEqual([]);
  });
});
