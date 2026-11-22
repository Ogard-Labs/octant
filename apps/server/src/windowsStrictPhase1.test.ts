import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeCodeTerminalId,
  decodeProjectId,
  decodeWindowId,
  EventActor,
  Project,
  ProjectActionId,
} from "@octant/contracts";
import { decodeSandboxPolicy } from "@octant/contracts/sandbox-policy";
import {
  WINDOWS_KEPT_SANDBOX_REFUSAL,
  WINDOWS_SANDBOX_OPERATION_REFUSAL,
  WINDOWS_STRICT_NETWORK_REFUSAL,
  WINDOWS_STRICT_REFUSAL,
  windowsStrictRuntimeRefusal,
} from "@octant/domain/guardrail-policy";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectTerminalService } from "./code/projectTerminalService";
import { AggregateHeadsProjection } from "./persistence/aggregateHeadsProjection";
import { EventRegistry } from "./persistence/eventRegistry";
import { Journal } from "./persistence/journal";
import { applyMigrations, MIGRATIONS } from "./persistence/migrations";
import { ProjectionRegistry } from "./persistence/projection";
import { openSqlite, type SqliteConnection } from "./persistence/sqlitePort";
import {
  configureSandboxRestrictionsAuthority,
  configureSandboxToolNetwork,
} from "./process/sandboxRuntimePolicy";
import { makeProcessConfinementLive, ProcessConfinementError } from "./process/seatbeltProfile";
import {
  registerSandboxRestrictionsEvents,
  SandboxRestrictionsService,
} from "./sandboxRestrictionsService";
import { strictKeptForLaunch } from "./strictResolution";

const tempDirs: string[] = [];
const connections: SqliteConnection[] = [];

afterEach(() => {
  configureSandboxRestrictionsAuthority(undefined);
  configureSandboxToolNetwork(undefined, () => true);
  for (const db of connections.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

const now = "2026-11-21T12:00:00.000Z";
const actor = Schema.decodeUnknownSync(EventActor)({
  kind: "local-user",
  actorId: "99999999-9999-4999-8999-999999999999",
});
const projectId = decodeProjectId("20000000-0000-4000-8000-000000000010");
const windowId = decodeWindowId("10000000-0000-4000-8000-000000000010");

function makeCodeProject(root: string, includeAction = false) {
  return Schema.decodeUnknownSync(Project)({
    id: String(projectId),
    type: "code",
    name: "Windows Strict Project",
    lifecycle: "active",
    pinned: false,
    rank: "0/1",
    version: 1,
    createdAt: now,
    updatedAt: now,
    codeAccessPersistence: "current-session",
    binding: { canonicalRoot: root },
    bindingHistory: [
      {
        revisionId: "30000000-0000-4000-8000-000000000010",
        revision: 1,
        currentBinding: { canonicalRoot: root },
        actor,
        changedAt: now,
      },
    ],
    ...(includeAction
      ? {
          actions: [
            {
              id: "40000000-0000-4000-8000-000000000010",
              name: "Run tests",
              command: "bun run test",
              directory: ".",
            },
          ],
        }
      : {}),
  });
}

function makeSandboxService(input: {
  readonly executionPolicy: "full-access" | "approval-gated" | "auto-accept-edits" | "plan";
  readonly strict?: boolean;
  readonly fullAccessSandbox?: boolean;
  readonly launcherAvailable?: boolean;
}) {
  const base = makeTempDir("octant-win-strict-");
  const root = join(base, "project");
  mkdirSync(root);
  const project = makeCodeProject(root);
  const connection = openSqlite(join(base, "journal.sqlite3"));
  connections.push(connection);
  applyMigrations(connection, MIGRATIONS, () => now);
  const journal = new Journal({
    connection,
    registry: registerSandboxRestrictionsEvents(new EventRegistry()),
    projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
    clock: () => now,
  });

  let executionPolicy = input.executionPolicy;
  let strict = input.strict;
  let fullAccessSandbox = input.fullAccessSandbox;

  const service = new SandboxRestrictionsService({
    platform: "win32",
    dataDirectory: base,
    windowsConfinementAvailable: () => input.launcherAvailable !== false,
    enrollmentEnabled: true,
    hostId: "local-host",
    actor,
    journal,
    project: (id) => (id === String(projectId) ? project : undefined),
    thread: () => ({ projectId: String(projectId), mode: "code" }),
    strictPreferences: () => ({
      executionPolicy,
      thread: {
        ...(strict === undefined ? {} : { strict }),
        ...(fullAccessSandbox === undefined ? {} : { fullAccessSandbox }),
      },
    }),
  });
  return {
    root,
    service,
    setPreferences: (next: {
      readonly executionPolicy?: typeof executionPolicy;
      readonly strict?: boolean | undefined;
      readonly fullAccessSandbox?: boolean | undefined;
    }) => {
      if (next.executionPolicy !== undefined) executionPolicy = next.executionPolicy;
      if ("strict" in next) strict = next.strict;
      if ("fullAccessSandbox" in next) fullAccessSandbox = next.fullAccessSandbox;
    },
  };
}

describe("Windows Strict, phase 1 admission, isolation, and tool refusals", () => {
  it("admits canonical Strict at Full access with Codex, refuses non-Codex providers, lower levels, legacy sandbox, and proxied network by name", async () => {
    configureSandboxToolNetwork(undefined, () => false);

    const { root, service, setPreferences } = makeSandboxService({
      executionPolicy: "full-access",
      strict: true,
    });

    // Codex at Full access under canonical Strict is admitted with an immutable selection.
    const codexThreadId = "50000000-0000-4000-8000-000000000001";
    const admitted = service.beginTurn({
      threadId: codexThreadId,
      projectId: String(projectId),
      mode: "code",
      root,
      provider: "codex",
    });
    expect(admitted.status).toBe("admitted");
    if (admitted.status === "admitted") {
      expect(admitted.turn.strict).toBe(true);
      expect(admitted.turn.legacy).toBe(false);
      expect(admitted.turn.selection).toBeDefined();

      // Editing preferences mid-turn cannot widen the active job; snapshot marks changes pending.
      setPreferences({ strict: false });
      const snap = service.snapshot({ kind: "session", threadId: codexThreadId });
      expect(snap.activeStrict).toBe(true);
      expect(snap.pending).toBe(true);
      await admitted.turn.end();
      setPreferences({ strict: true });
    }

    // Non-Codex providers at Full access under Strict refuse by name.
    let index = 2;
    for (const provider of ["claude", "opencode", "pi", "acp-agent"] as const) {
      const refused = service.beginTurn({
        threadId: `50000000-0000-4000-8000-00000000000${String(index++)}`,
        projectId: String(projectId),
        mode: "code",
        root,
        provider,
      });
      expect(refused).toEqual({
        status: "refused",
        message: windowsStrictRuntimeRefusal(provider),
      });
    }

    // Lower access levels refuse under Windows Strict even on Codex.
    setPreferences({ executionPolicy: "approval-gated", strict: true });
    expect(
      service.beginTurn({
        threadId: "50000000-0000-4000-8000-000000000011",
        projectId: String(projectId),
        mode: "code",
        root,
        provider: "codex",
      }),
    ).toEqual({ status: "refused", message: WINDOWS_STRICT_REFUSAL });

    // Legacy fullAccessSandbox without canonical Strict is refused (not reused).
    setPreferences({ executionPolicy: "full-access", strict: undefined, fullAccessSandbox: true });
    expect(
      service.beginTurn({
        threadId: "50000000-0000-4000-8000-000000000012",
        projectId: String(projectId),
        mode: "code",
        root,
        provider: "codex",
      }),
    ).toEqual({ status: "refused", message: WINDOWS_KEPT_SANDBOX_REFUSAL });

    // Proxy-only Network limits refuse by name rather than falling back to direct network.
    setPreferences({ executionPolicy: "full-access", strict: true, fullAccessSandbox: undefined });
    configureSandboxToolNetwork(undefined, () => true);
    expect(
      service.beginTurn({
        threadId: "50000000-0000-4000-8000-000000000013",
        projectId: String(projectId),
        mode: "code",
        root,
        provider: "codex",
      }),
    ).toEqual({ status: "refused", message: WINDOWS_STRICT_NETWORK_REFUSAL });

    // Terminal execution route under Windows Strict refuses with the exact operation message.
    configureSandboxToolNetwork(undefined, () => false);
    expect(
      service.beginTurn({
        threadId: "50000000-0000-4000-8000-000000000014",
        projectId: String(projectId),
        mode: "code",
        root,
        provider: "terminal",
        executionRoute: "terminal",
      }),
    ).toEqual({ status: "refused", message: WINDOWS_SANDBOX_OPERATION_REFUSAL });
  });

  it("refuses Windows Strict when the packaged octant-windows-confine.exe launcher is unavailable", () => {
    configureSandboxToolNetwork(undefined, () => false);
    const { root, service } = makeSandboxService({
      executionPolicy: "full-access",
      strict: true,
      launcherAvailable: false,
    });
    const refused = service.beginTurn({
      threadId: "50000000-0000-4000-8000-000000000015",
      projectId: String(projectId),
      mode: "code",
      root,
      provider: "codex",
    });
    expect(refused.status).toBe("refused");
    if (refused.status === "refused") {
      expect(refused.message).toMatch(/octant-windows-confine\.exe/u);
    }
  });

  it("records strictKept as sandboxed for Windows Strict Codex at Full access and unsandboxed otherwise", () => {
    const codexFull = strictKeptForLaunch({
      strict: true,
      driverKind: "codex",
      executionPolicy: "full-access",
      platform: "win32",
    });
    expect(codexFull).toContain("octant-sandbox");

    const claudeFull = strictKeptForLaunch({
      strict: true,
      driverKind: "claude",
      executionPolicy: "full-access",
      platform: "win32",
    });
    expect(claudeFull).not.toContain("octant-sandbox");
  });

  it("refuses Project terminals and Project actions under Windows Strict before journaling or spawning", async () => {
    const root = makeTempDir("octant-win-proj-term-");
    const append = vi.fn();
    const launch = vi.fn();
    const project = makeCodeProject(root, true);

    const service = new ProjectTerminalService({
      platform: "win32",
      strict: () => true,
      readProject: () => project,
      canAccessProject: () => true,
      resolveRoot: async () => root,
      suggestActions: async () => [],
      readRunning: () => [],
      journal: { append },
      actor,
      uuid: () => "uuid-1",
      clock: () => now,
      terminals: {
        launch,
        observe: vi.fn(),
        readSince: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        terminate: vi.fn(),
      },
    });

    const terminalRefused = await service.execute(windowId, "local-window", {
      kind: "start",
      projectId,
      terminalId: decodeCodeTerminalId("30000000-0000-4000-8000-000000000001"),
      columns: 80,
      rows: 24,
    });
    expect(terminalRefused).toMatchObject({
      kind: "project-terminal-refused",
      reason: "unavailable",
      message: WINDOWS_SANDBOX_OPERATION_REFUSAL,
    });

    const actionRefused = await service.execute(windowId, "local-window", {
      kind: "start-action",
      projectId,
      terminalId: decodeCodeTerminalId("30000000-0000-4000-8000-000000000002"),
      actionId: Schema.decodeUnknownSync(ProjectActionId)("40000000-0000-4000-8000-000000000010"),
      columns: 80,
      rows: 24,
    });
    expect(actionRefused).toMatchObject({
      kind: "project-terminal-refused",
      reason: "unavailable",
      message: WINDOWS_SANDBOX_OPERATION_REFUSAL,
    });
    expect(append).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it("refuses hostServices blocked policy on Windows Strict", () => {
    configureSandboxToolNetwork(undefined, () => false);
    const policy = decodeSandboxPolicy({
      schemaVersion: 1,
      revision: 1,
      filesystem: { readOnlyRoots: [], readWriteRoots: [], protectedPaths: [] },
      network: "unrestricted",
      credentials: "existing-policy",
      hostServices: "blocked",
    });
    const { root, service } = makeSandboxService({
      executionPolicy: "full-access",
      strict: true,
    });
    const saved = service.change({
      kind: "set-policy",
      scope: { kind: "project", projectId },
      expectedVersion: 0,
      policy,
    });
    expect(saved.kind).toBe("sandbox-restrictions");
    if (saved.kind === "sandbox-restrictions") {
      expect(saved.capabilities.blockedHostServices).toBe(false);
    }
    const refused = service.beginTurn({
      threadId: "50000000-0000-4000-8000-000000000016",
      projectId: String(projectId),
      mode: "code",
      root,
      provider: "codex",
    });
    expect(refused).toEqual({
      status: "refused",
      message: WINDOWS_STRICT_NETWORK_REFUSAL,
    });
  });

  it("admits a SandboxRestrictionsService Windows Strict selection through makeProcessConfinementLive and refuses unsupported custom rules", async () => {
    configureSandboxToolNetwork(undefined, () => false);
    const { root, service } = makeSandboxService({
      executionPolicy: "full-access",
      strict: true,
    });
    configureSandboxRestrictionsAuthority(service);
    const threadId = "50000000-0000-4000-8000-000000000021";
    const admitted = service.beginTurn({
      threadId,
      projectId: String(projectId),
      mode: "code",
      root,
      provider: "codex",
    });
    expect(admitted.status).toBe("admitted");
    if (admitted.status !== "admitted") return;
    try {
      expect(admitted.turn.selection).toBeDefined();
      const launcherPath =
        "C:\\Program Files\\Octant\\resources\\native\\octant-windows-confine.exe";
      const port = makeProcessConfinementLive({
        platform: "win32",
        windowsConfinement: {
          launcherPath,
          homeDirectory: "C:\\Users\\Ada",
          launchId: "0123456789abcdef0123456789abcdef",
          readDirectory: () => [],
        },
      });
      const prepared = port.prepare({
        executable: "C:\\Tools\\Codex\\codex.exe",
        args: ["app-server"],
        boundRoot: "C:\\Work\\repo",
        temporaryDirectory: "C:\\Temp\\octant-scratch",
        networkEgress: "allow",
        ...(admitted.turn.selection === undefined
          ? {}
          : { sandboxPolicy: admitted.turn.selection }),
      });
      expect(prepared.command).toBe(launcherPath);
      expect(prepared.args).toContain("--container");
      expect(prepared.args).toContain("Octant.Confined.0123456789abcdef0123456789abcdef");
      expect(prepared.policyReceipt?.backend).toBe("windows-appcontainer-v1");

      // Passing the original selection reference records the Windows backend
      // and grants on SandboxRestrictionsService via WeakMap identity.
      const recordedSnapshot = service.snapshot({ kind: "session", threadId });
      expect(recordedSnapshot.runtimeDetails).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            provider: "codex",
            backend: expect.stringMatching(/^Windows AppContainer \+ Job Object/u),
            writes: expect.arrayContaining(["C:\\Work\\repo", "C:\\Temp\\octant-scratch"]),
          }),
        ]),
      );

      // Unsupported custom restrictions (network: "deny", custom protectedPaths,
      // or isolated credentials) fail closed cleanly as incompatible rather than
      // hitting the POSIX-only compiler or granting broad network.
      configureSandboxRestrictionsAuthority(undefined);
      if (admitted.turn.selection !== undefined) {
        const denyNetwork = {
          ...admitted.turn.selection,
          policy: decodeSandboxPolicy({
            ...admitted.turn.selection.policy,
            network: "deny",
          }),
        };
        let denyNetworkError: unknown;
        try {
          port.prepare({
            executable: "C:\\Tools\\Codex\\codex.exe",
            args: ["app-server"],
            boundRoot: "C:\\Work\\repo",
            temporaryDirectory: "C:\\Temp\\octant-scratch",
            networkEgress: "allow",
            sandboxPolicy: denyNetwork,
          });
        } catch (error) {
          denyNetworkError = error;
        }
        expect(denyNetworkError).toBeInstanceOf(ProcessConfinementError);
        expect((denyNetworkError as ProcessConfinementError).message).toBe(
          WINDOWS_STRICT_NETWORK_REFUSAL,
        );

        const unsupportedProtected = {
          ...admitted.turn.selection,
          policy: decodeSandboxPolicy({
            ...admitted.turn.selection.policy,
            filesystem: {
              ...admitted.turn.selection.policy.filesystem,
              protectedPaths: [{ path: "/work/repo/secrets", mode: "deny" }],
            },
          }),
        };
        let protectedError: unknown;
        try {
          port.prepare({
            executable: "C:\\Tools\\Codex\\codex.exe",
            args: ["app-server"],
            boundRoot: "C:\\Work\\repo",
            temporaryDirectory: "C:\\Temp\\octant-scratch",
            networkEgress: "allow",
            sandboxPolicy: unsupportedProtected,
          });
        } catch (error) {
          protectedError = error;
        }
        expect(protectedError).toBeInstanceOf(ProcessConfinementError);
        expect((protectedError as ProcessConfinementError).message).toMatch(/protected-path/u);

        const unsupportedCredentials = {
          ...admitted.turn.selection,
          policy: decodeSandboxPolicy({
            ...admitted.turn.selection.policy,
            credentials: "isolated",
          }),
        };
        let credentialsError: unknown;
        try {
          port.prepare({
            executable: "C:\\Tools\\Codex\\codex.exe",
            args: ["app-server"],
            boundRoot: "C:\\Work\\repo",
            temporaryDirectory: "C:\\Temp\\octant-scratch",
            networkEgress: "allow",
            sandboxPolicy: unsupportedCredentials,
          });
        } catch (error) {
          credentialsError = error;
        }
        expect(credentialsError).toBeInstanceOf(ProcessConfinementError);
        expect((credentialsError as ProcessConfinementError).message).toMatch(
          /isolated credential/u,
        );
      }
    } finally {
      await admitted.turn.end();
    }

    // Saving Block network access (`network: "deny"`) refuses Windows Strict Codex
    // turns at beginTurn before dispatch rather than breaking model inference or
    // silently granting broad network.
    const denyPolicy = decodeSandboxPolicy({
      schemaVersion: 1,
      revision: 1,
      filesystem: { readOnlyRoots: [], readWriteRoots: [], protectedPaths: [] },
      network: "deny",
      credentials: "existing-policy",
      hostServices: "existing-policy",
    });
    const savedDeny = service.change({
      kind: "set-policy",
      scope: { kind: "project", projectId },
      expectedVersion: 0,
      policy: denyPolicy,
    });
    expect(savedDeny.kind).toBe("sandbox-restrictions");
    expect(
      service.beginTurn({
        threadId: "50000000-0000-4000-8000-000000000022",
        projectId: String(projectId),
        mode: "code",
        root,
        provider: "codex",
      }),
    ).toEqual({
      status: "refused",
      message: WINDOWS_STRICT_NETWORK_REFUSAL,
    });
  });
});
