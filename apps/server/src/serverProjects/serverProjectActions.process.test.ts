import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  decodeCodeCheckoutId,
  decodeCodeTerminalId,
  decodeCodeThreadId,
  decodeProjectActions,
  decodeWindowId,
} from "@octant/contracts";
import type { ShieldServer } from "@octant/contracts/shield-servers";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { ProjectTerminalService } from "../code/projectTerminalService";
import { TerminalService } from "../code/terminalService";
import { ServerConnection } from "./serverConnection";
import { ServerProjectStore } from "./serverProjectStore";
import { createServerProjectActions } from "./serverProjectActions";
import { serverCodeCheckout } from "./serverProjectThreads";
import { serverTerminalLogin } from "./serverTerminal";
import { createServerWorkActionTask } from "./serverWorkProjectActions";
import { serverWorkBindingRevisionId } from "./serverWorkThreads";
import { decodeWorkThread } from "@octant/contracts/work-threads";
import { contextKeyForProject, defaultWindowWorkspace } from "@octant/domain";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import {
  canRunThrowawaySshd,
  startThrowawaySshd,
  type ThrowawaySshd,
} from "./throwawaySshd.test-support";

describe.skipIf(!canRunThrowawaySshd)("saved actions on a throwaway server", () => {
  let sshd: ThrowawaySshd;
  let maximumLife: ReturnType<typeof setTimeout>;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    sshd?.stop();
  };
  beforeAll(async () => {
    sshd = await startThrowawaySshd();
    process.once("exit", stop);
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    maximumLife = setTimeout(stop, 120000);
    maximumLife.unref();
  }, 30000);
  afterAll(() => {
    clearTimeout(maximumLife);
    stop();
    process.removeListener("exit", stop);
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  });

  async function fixture(
    command = "printf '%s\\n' remote-action > result.txt",
    plan = false,
    work = false,
  ) {
    const scratch = mkdtempSync(join(tmpdir(), "octant-server-action-"));
    const localRoot = join(scratch, "local");
    const remoteRoot = join(sshd.root, randomUUID());
    const taskRoot = join(remoteRoot, "checkout");
    mkdirSync(localRoot);
    mkdirSync(taskRoot, { recursive: true });
    writeFileSync(
      join(localRoot, "package.json"),
      JSON.stringify({ scripts: { wrong: "echo local" } }),
    );
    writeFileSync(
      join(remoteRoot, "package.json"),
      JSON.stringify({ scripts: { build: "echo remote", postinstall: "echo never" } }),
    );
    writeFileSync(join(remoteRoot, "bun.lock"), "lockfileVersion = 1");
    spawnSync("git", ["init", "--quiet", taskRoot]);
    const sqlite = openSqlite(join(scratch, "journal.sqlite"));
    applyMigrations(sqlite, MIGRATIONS, () => new Date().toISOString());
    const registry = createPhase1RuntimeRegistries();
    const journal = new Journal({
      connection: sqlite,
      registry: registry.events,
      projections: registry.projections,
      clock: () => new Date().toISOString(),
    });
    const connection = new ServerConnection({
      configFile: sshd.configFile,
      agentSocket: () => sshd.agentSocket,
    });
    let server: ShieldServer = {
      serverId: "5e7e1111-0000-4000-8000-000000000001" as ShieldServer["serverId"],
      alias: sshd.alias,
      user: sshd.user,
      profile: "operate",
      deployCommands: [],
    };
    const store = new ServerProjectStore({
      journal,
      connection,
      servers: () => [server],
      personActor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
    });
    const bound = await store.bind({
      name: "Remote",
      serverId: String(server.serverId),
      folder: remoteRoot,
      principal: "local-window",
      ...(work ? { mode: "work" as const } : {}),
    });
    if (bound.kind !== "changed" || bound.project === undefined)
      throw Error("Expected server fixture binding");
    const project = bound.project;
    const actions = decodeProjectActions([
      { id: randomUUID(), name: "Build", command, directory: "." },
    ]);
    store.setActions({
      projectId: String(project.id),
      actions,
      expectedVersion: 0,
      principal: "local-window",
    });
    const action = actions[0];
    if (action === undefined) throw Error("Expected fixture action");
    const windowId = decodeWindowId(randomUUID());
    const emptyWorkspace = defaultWindowWorkspace(windowId);
    let workspace = {
      ...emptyWorkspace,
      contextByMode: {
        ...emptyWorkspace.contextByMode,
        work: contextKeyForProject("work", LOCAL_HOST_ID, project.id, remoteRoot),
      },
    };
    let windowLive = true;
    let workThread = decodeWorkThread({
      id: randomUUID(),
      projectId: project.id,
      title: "Synthetic Work task",
      lifecycle: "active",
      bindingRevisionId: serverWorkBindingRevisionId(project),
      workingDirectory: "checkout",
      access: "ask-first",
      providerInstanceId: randomUUID(),
      modelId: "synthetic-model",
      version: 1,
      createdAt: "2026-11-07T10:00:00.000Z",
      updatedAt: "2026-11-07T10:00:00.000Z",
    });
    let taskCurrent = true;
    const thread = {
      threadId: decodeCodeThreadId(randomUUID()),
      checkoutId: decodeCodeCheckoutId(randomUUID()),
    };
    const remoteActions = createServerProjectActions({
      store,
      connection,
      workTask: createServerWorkActionTask({
        store,
        readThread: (id) => (id === workThread.id ? workThread : undefined),
        workspace: () => workspace,
        isWindowLive: () => windowLive,
        workEnabled: () => true,
      }),
      task: async () => ({
        ...thread,
        root: taskRoot,
        executionPolicy: plan ? "plan" : "approval-gated",
        authorityRevision: "reviewed-task",
        current: () => taskCurrent,
      }),
    });
    const localStart = vi.fn(() => {
      throw Error("No local process may run");
    });
    const terminals = new TerminalService({
      port: { start: localStart },
      inheritedEnvironment: {},
      credentials: {
        resolve: async () => {
          throw Error("No local credential may be read");
        },
      },
    });
    const localResolve = vi.fn(async () => localRoot);
    const localSuggestions = vi.fn(async () => []);
    const service = new ProjectTerminalService({
      terminals,
      ...remoteActions,
      readProject: () => undefined,
      canAccessProject: (candidate, id) => candidate === windowId && id === project.id,
      resolveRoot: localResolve,
      suggestActions: localSuggestions,
      readRunning: () => [],
      journal,
      actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
      serverProject: (id) => {
        const current = store.project(String(id));
        return current === undefined
          ? undefined
          : {
              ...(current.mode === "work" ? { actionsOnly: true as const } : {}),
              bindingRevisionId:
                current.mode === "work"
                  ? serverWorkBindingRevisionId(current)
                  : serverCodeCheckout(current).bindingRevisionId,
              login: () =>
                current.mode === "work"
                  ? undefined
                  : serverTerminalLogin(connection, server, remoteRoot),
            };
      },
    });
    const target = {
      projectId: project.id,
      actionId: action.id,
      ...(work ? { workThreadId: workThread.id } : { thread }),
    };
    const preview = () =>
      service.execute(windowId, "local-window", { kind: "preview-action", ...target });
    const start = async () => {
      const checked = await preview();
      if (checked.kind !== "project-action-preview") throw Error("Expected fixture preview");
      const terminalId = decodeCodeTerminalId(randomUUID());
      return {
        terminalId,
        checked,
        result: await service.execute(windowId, "local-window", {
          kind: "start-action",
          ...target,
          terminalId,
          projectVersion: checked.projectVersion,
          placementRevision: checked.action.server?.placementRevision,
          columns: 100,
          rows: 30,
        }),
      };
    };
    return {
      store,
      service,
      terminals,
      project,
      target,
      windowId,
      remoteRoot,
      taskRoot,
      localRoot,
      localStart,
      localResolve,
      localSuggestions,
      changeWorkAccess: () => {
        workThread = { ...workThread, access: "full-access" };
      },
      changeWorkModel: () => {
        workThread = decodeWorkThread({ ...workThread, modelId: "changed-model" });
      },
      loseWorkProject: () => {
        workspace = emptyWorkspace;
      },
      closeWindow: () => {
        windowLive = false;
      },
      preview,
      start,
      changeProfile: () => {
        server = { ...server, profile: "read-only" };
      },
      endTask: () => {
        taskCurrent = false;
      },
      close: async () => {
        await terminals.closeAll();
        sqlite.close();
        rmSync(scratch, { recursive: true, force: true });
      },
    };
  }

  it("reads remote suggestions and runs a dedicated reviewed checkout command without writing into a busy terminal", async () => {
    const f = await fixture();
    try {
      const suggestions = await f.service.execute(f.windowId, "local-window", {
        kind: "suggest-actions",
        projectId: f.project.id,
      });
      expect(suggestions).toMatchObject({
        kind: "project-action-suggestions",
        suggestions: [{ command: "bun run build" }],
      });
      const busyId = decodeCodeTerminalId(randomUUID());
      await f.service.execute(f.windowId, "local-window", {
        kind: "start",
        projectId: f.project.id,
        terminalId: busyId,
        columns: 100,
        rows: 30,
      });
      f.terminals.write(String(busyId), "printf 'busy-%s\\n' ready; sleep 20\n");
      await vi.waitFor(
        () =>
          expect(f.terminals.attach(String(busyId)).transcript.chunks.join("")).toContain(
            "busy-ready",
          ),
        { timeout: 15000 },
      );
      const writes = vi.spyOn(f.terminals, "write");
      const { result, terminalId, checked } = await f.start();
      expect(checked.action).toMatchObject({
        folder: f.taskRoot,
        server: {
          alias: sshd.alias,
          user: sshd.user,
          profile: "operate",
          confinement: "none",
          taskExecutionPolicy: "approval-gated",
        },
      });
      expect(result.kind).toBe("project-terminal");
      await vi.waitFor(() => expect(f.terminals.attach(String(terminalId)).status).toBe("exited"), {
        timeout: 15000,
      });
      expect(readFileSync(join(f.taskRoot, "result.txt"), "utf8")).toBe("remote-action\n");
      expect(f.terminals.attach(String(busyId)).status).toBe("running");
      expect(writes).not.toHaveBeenCalled();
      expect(f.localStart).not.toHaveBeenCalled();
      expect(f.localResolve).not.toHaveBeenCalled();
      expect(f.localSuggestions).not.toHaveBeenCalled();
      const repeated = await f.service.execute(f.windowId, "local-window", {
        kind: "start-action",
        ...f.target,
        terminalId,
        projectVersion: checked.projectVersion,
        placementRevision: checked.action.server?.placementRevision,
        columns: 100,
        rows: 30,
      });
      expect(repeated.kind).toBe("project-terminal-refused");
    } finally {
      await f.close();
    }
  });

  it("refuses stale registry or physical checkout placement and a paired launch before executing", async () => {
    const f = await fixture();
    try {
      const checked = await f.preview();
      if (checked.kind !== "project-action-preview") throw Error("Expected fixture preview");
      const request = {
        kind: "start-action" as const,
        ...f.target,
        terminalId: decodeCodeTerminalId(randomUUID()),
        projectVersion: checked.projectVersion,
        placementRevision: checked.action.server?.placementRevision,
        columns: 100,
        rows: 30,
      };
      expect((await f.service.execute(f.windowId, "remote-device", request)).kind).toBe(
        "project-terminal-refused",
      );
      f.changeProfile();
      expect((await f.service.execute(f.windowId, "local-window", request)).kind).toBe(
        "project-terminal-refused",
      );
      const physical = await f.preview();
      if (physical.kind !== "project-action-preview") throw Error("Expected current placement");
      renameSync(f.taskRoot, `${f.taskRoot}-old`);
      mkdirSync(f.taskRoot);
      spawnSync("git", ["init", "--quiet", f.taskRoot]);
      expect(
        (
          await f.service.execute(f.windowId, "local-window", {
            ...request,
            projectVersion: physical.projectVersion,
            placementRevision: physical.action.server?.placementRevision,
          })
        ).kind,
      ).toBe("project-terminal-refused");
      expect(f.localStart).not.toHaveBeenCalled();
      f.endTask();
      expect((await f.preview()).kind).toBe("project-terminal-refused");
    } finally {
      await f.close();
    }
  });

  it("reports cancellation and dropped SSH as uncertain without restarting the command", async () => {
    const f = await fixture("printf ready; exec sleep 30");
    try {
      const run = await f.start();
      expect(run.result.kind).toBe("project-terminal");
      const stop = await f.service.execute(f.windowId, "local-window", {
        kind: "stop",
        projectId: f.project.id,
        terminalId: run.terminalId,
      });
      expect(stop).toMatchObject({
        kind: "project-terminal",
        terminal: { state: "interrupted", uncertainty: "server-stop-unconfirmed" },
      });
      const dropped = await f.start();
      await vi.waitFor(
        () =>
          expect(
            f.terminals.attach(String(dropped.terminalId)).transcript.chunks.join(""),
          ).toContain("ready"),
        { timeout: 15000 },
      );
      sshd.dropConnections();
      await vi.waitFor(
        () => expect(f.terminals.attach(String(dropped.terminalId)).status).toBe("exited"),
        { timeout: 15000 },
      );
      const read = await f.service.execute(f.windowId, "local-window", {
        kind: "read-output",
        projectId: f.project.id,
        terminalId: dropped.terminalId,
        afterCharacters: 0,
      });
      expect(read).toMatchObject({
        kind: "project-terminal",
        terminal: { state: "interrupted", uncertainty: "server-transport-lost" },
      });
    } finally {
      await f.close();
    }
  });

  it("refuses Plan and removed Projects without launching an action", async () => {
    const f = await fixture(undefined, true);
    try {
      expect((await f.start()).result).toMatchObject({
        kind: "project-terminal-refused",
        message: "Plan cannot launch a server action.",
      });
      expect(f.localStart).not.toHaveBeenCalled();
      f.store.remove({ projectId: String(f.project.id), principal: "local-window" });
      expect((await f.preview()).kind).toBe("project-terminal-refused");
    } finally {
      await f.close();
    }
  });

  it("runs a reviewed Work task on its server and retires it when task authority changes without enabling a general terminal", async () => {
    const f = await fixture("pwd; printf ready; exec sleep 30", false, true);
    try {
      expect(f.store.project(String(f.project.id))?.developerTools).toBeUndefined();
      expect(
        await f.service.execute(f.windowId, "local-window", {
          kind: "start",
          projectId: f.project.id,
          terminalId: decodeCodeTerminalId(randomUUID()),
          columns: 80,
          rows: 24,
        }),
      ).toMatchObject({ kind: "project-terminal-refused" });
      const run = await f.start();
      expect(run.checked.action).toMatchObject({
        workThreadId: "workThreadId" in f.target ? f.target.workThreadId : undefined,
        folder: f.taskRoot,
        server: { taskExecutionPolicy: "approval-gated", confinement: "none" },
      });
      expect(run.checked.action.thread).toBeUndefined();
      expect(
        await f.service.execute(f.windowId, "local-window", {
          kind: "write",
          projectId: f.project.id,
          terminalId: run.terminalId,
          data: "echo never\n",
        }),
      ).toMatchObject({ kind: "project-terminal-refused", reason: "unavailable" });
      await vi.waitFor(
        () =>
          expect(f.terminals.attach(String(run.terminalId)).transcript.chunks.join("")).toContain(
            `${f.taskRoot}\r\nready`,
          ),
        { timeout: 15000 },
      );
      f.changeWorkAccess();
      await f.service.settleActionAuthorities();
      expect(
        await f.service.execute(f.windowId, "local-window", {
          kind: "read-output",
          projectId: f.project.id,
          terminalId: run.terminalId,
          afterCharacters: 0,
        }),
      ).toMatchObject({ kind: "project-terminal-refused", reason: "authority-revoked" });
      expect(f.terminals.attach(String(run.terminalId)).status).not.toBe("running");
      const reviewed = await f.preview();
      if (reviewed.kind !== "project-action-preview") throw Error("Expected current Work review");
      f.changeWorkModel();
      expect(
        await f.service.execute(f.windowId, "local-window", {
          kind: "start-action",
          ...f.target,
          terminalId: decodeCodeTerminalId(randomUUID()),
          columns: 80,
          rows: 24,
          projectVersion: reviewed.projectVersion,
          placementRevision: reviewed.action.server?.placementRevision,
        }),
      ).toMatchObject({ kind: "project-terminal-refused" });
      f.loseWorkProject();
      expect((await f.preview()).kind).toBe("project-terminal-refused");
      expect(f.localStart).not.toHaveBeenCalled();
      expect(f.localResolve).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it("gives a saved Work server command end-of-input rather than an interactive shell", async () => {
    const f = await fixture(
      "if IFS= read -r line; then printf unexpected-input; else printf stdin-closed; fi",
      false,
      true,
    );
    try {
      const run = await f.start();
      expect(run.result.kind).toBe("project-terminal");
      await vi.waitFor(
        () => expect(f.terminals.attach(String(run.terminalId)).status).toBe("exited"),
        { timeout: 15000 },
      );
      expect(f.terminals.attach(String(run.terminalId)).transcript.chunks.join("")).toContain(
        "stdin-closed",
      );
    } finally {
      await f.close();
    }
  });
});
