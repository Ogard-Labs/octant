import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeCodeBootstrap,
  decodeCodeOperationResult,
  decodeCodeThread,
  decodeWorkThreadBootstrap,
  decodeProviderInstance,
  decodeStableHostId,
  type ProviderDriverKind,
  MAX_AGENT_RUN_ADMITTED_CONTEXT_BLOCKS,
} from "@octant/contracts";
import { PersistenceStartupFailed, makePersistenceLive } from "./persistence/persistenceService";
import { applyMigrations, MIGRATIONS } from "./persistence/migrations";
import { Journal } from "./persistence/journal";
import { createPhase1RuntimeRegistries } from "./persistence/runtimeRegistry";
import { openSqlite } from "./persistence/sqlitePort";
import {
  PRIVATE_LISTENER_TEST_CERT,
  PRIVATE_LISTENER_TEST_KEY,
} from "./privateListener.test-certs";
import {
  admittedParentChatContext,
  fatalStartupOutput,
  makeConfiguredProviderDriver,
  MAX_CHAT_ATTACHMENT_BYTES,
  MAX_CODE_FILE_BODY_SIZE,
  MAX_JSON_REQUEST_BODY_SIZE,
  createExistingWorktreeCodeCheckoutObservation,
  createExistingWorktreeCodeFileRootAuthority,
  deriveExistingWorktreeCheckoutId,
  pathIsProjectConfined,
  startOctantServer,
} from "./server";
import { ProviderRuntimeRegistry } from "./providers/providerRuntimeRegistry";
import type { ClaudeAgentSdkPort } from "./providers/claudeAgentSdkPort";
import type { ClaudeProcessPort } from "./providers/claudeProcess";
import type { AcpProcessPort } from "./providers/acpProcess";
import { ClaudeResumeIdentityStore } from "./providers/claudeResumeIdentityStore";
import { ChatService } from "./chat/chatService";
import { WorkThreadService } from "./work/workThreadService";
import { AgentRunPersistenceService } from "./agentRun/agentRunPersistenceService";
import { GhAuthenticationPort } from "./github/ghAuthenticationPort";

const directories: Array<string> = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("startOctantServer", () => {
  it("recovers Chat sessions, attachments, and pending deletions before accepting requests", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-server-chat-recovery-"));
    directories.push(directory);
    const reconcile = vi.spyOn(AgentRunPersistenceService.prototype, "reconcileAfterRestart");
    const recover = vi.spyOn(ChatService.prototype, "recoverPendingDeletions").mockResolvedValue();
    const recoverAttachments = vi
      .spyOn(ChatService.prototype, "recoverManagedAttachments")
      .mockResolvedValue();
    const reapSessions = vi
      .spyOn(ChatService.prototype, "reapStaleProviderSessions")
      .mockResolvedValue({ reaped: 0, resumable: 0 });

    await Effect.runPromise(
      Effect.scoped(
        startOctantServer({
          hostname: "127.0.0.1",
          port: 0,
          serve: () => {
            expect(reapSessions).toHaveBeenCalledOnce();
            expect(recoverAttachments).toHaveBeenCalledOnce();
            expect(recover).toHaveBeenCalledOnce();
            expect(reconcile).toHaveBeenCalledOnce();
            return {
              url: new URL("http://127.0.0.1:13773"),
              stop: () => undefined,
            };
          },
        }).pipe(Effect.provide(makePersistenceLive({ dataDirectory: directory }))),
      ),
    );
    recover.mockRestore();
    recoverAttachments.mockRestore();
    reapSessions.mockRestore();
    reconcile.mockRestore();
  });

  it("releases server-owned GitHub authentication children during shutdown", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-server-github-auth-shutdown-"));
    directories.push(directory);
    const close = vi.fn();
    const githubAuthenticationPort = new GhAuthenticationPort({
      command: {
        run: async () => ({ exitCode: 0, stdout: JSON.stringify({ hosts: {} }) }),
        close,
      },
      inheritedEnvironment: {},
    });

    await Effect.runPromise(
      Effect.scoped(
        startOctantServer({
          hostname: "127.0.0.1",
          port: 0,
          githubAuthenticationPort,
          serve: () => ({
            url: new URL("http://127.0.0.1:13773"),
            stop: () => undefined,
          }),
        }).pipe(Effect.provide(makePersistenceLive({ dataDirectory: directory }))),
      ),
    );

    expect(close).toHaveBeenCalledOnce();
  });

  it("registers local device administration routes and fails closed when the gateway is disabled", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-server-local-devices-"));
    directories.push(directory);
    let fetchHandler:
      | ((
          request: Request,
          facts?: import("./server").RequestTransportFacts,
        ) => Response | Promise<Response>)
      | undefined;
    await Effect.runPromise(
      Effect.scoped(
        startOctantServer({
          hostname: "127.0.0.1",
          port: 0,
          desktopBridgeSecret: "desktop-secret",
          serve: (options) => {
            fetchHandler = options.fetch;
            return {
              url: new URL("http://127.0.0.1:13774"),
              stop: () => undefined,
            };
          },
        }).pipe(Effect.provide(makePersistenceLive({ dataDirectory: directory }))),
      ),
    );
    expect(fetchHandler).toBeTypeOf("function");
    const response = await fetchHandler!(
      new Request("http://127.0.0.1:13774/api/desktop/remote/devices", {
        headers: {
          "x-octant-desktop-secret": "desktop-secret",
          "x-octant-window-capability": "C".repeat(43),
        },
      }),
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ category: "unavailable" });
  });

  it("serves owner-mediated verified backups and honest platform capabilities", async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "octant-server-owner-backup-")));
    directories.push(directory);
    const started = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* startOctantServer({
            hostname: "127.0.0.1",
            port: 0,
            platformCapabilities: ["platform:process-inspection"],
            serve: () => ({
              url: new URL("http://127.0.0.1:13775"),
              stop: () => undefined,
            }),
          });
          expect(server.backup).toBeTypeOf("function");
          const receipt = server.backup!("owner-routed");
          expect(receipt).toMatchObject({
            path: join(directory, "octant.sqlite3.backup-owner-routed"),
            migrationVersion: MIGRATIONS.at(-1)!.version,
          });
          expect(server.diagnostics?.().capabilities).toContain("platform:process-inspection");
          return receipt;
        }).pipe(Effect.provide(makePersistenceLive({ dataDirectory: directory }))),
      ),
    );
    expect(started.byteLength).toBeGreaterThan(0);
  });

  it("rejects disabled provider instances before constructing a driver", () => {
    const instance = decodeProviderInstance({
      id: "80000000-0000-4000-8000-000000000400",
      displayName: "Disabled provider",
      driverKind: "openai-compatible",
      configuration: {
        kind: "openai-compatible-http",
        baseUrl: "https://gateway.example/v1/",
        authentication: "none",
        protocol: "auto",
        manualModelIds: [],
      },
      enabled: false,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: "2026-07-15T10:00:00.000Z",
      updatedAt: "2026-07-15T10:00:00.000Z",
    });

    expect(() =>
      makeConfiguredProviderDriver(instance, {
        openCodeProcess: { start: () => Effect.die("must not start OpenCode") },
        codexProcess: { start: () => Effect.die("must not start Codex") },
        runtimeRegistry: new ProviderRuntimeRegistry(),
        permissionPersistence: () => "current-session",
      }),
    ).toThrow(/disabled/i);
  });

  it("rejects constructing a driver when its provider-driver plugin is not effective", () => {
    const instance = decodeProviderInstance({
      id: "80000000-0000-4000-8000-000000000410",
      displayName: "Codex local",
      driverKind: "codex",
      configuration: { kind: "codex-cli", binaryPath: "/missing/codex" },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: "2026-07-15T10:00:00.000Z",
      updatedAt: "2026-07-15T10:00:00.000Z",
    });

    expect(() =>
      makeConfiguredProviderDriver(instance, {
        openCodeProcess: { start: () => Effect.die("must not start OpenCode") },
        codexProcess: { start: () => Effect.die("must not start Codex") },
        runtimeRegistry: new ProviderRuntimeRegistry(),
        permissionPersistence: () => "current-session",
        admittedDriverKinds: new Set<ProviderDriverKind>(),
      }),
    ).toThrow(/not effective/i);
  });

  it.each(["openai-image", "gemini-native-image"] as const)(
    "refuses to construct a turn driver for an %s image profile",
    (driverKind) => {
      const instance = decodeProviderInstance({
        id: "80000000-0000-4000-8000-000000000441",
        displayName: driverKind === "openai-image" ? "GPT Image" : "Gemini Image",
        driverKind,
        configuration:
          driverKind === "openai-image"
            ? {
                kind: "openai-image-http",
                modelAllowlist: ["gpt-image-2"],
                defaultModel: "gpt-image-2",
              }
            : {
                kind: "gemini-native-image-http",
                modelAllowlist: ["gemini-3.1-flash-image"],
                defaultModel: "gemini-3.1-flash-image",
              },
        enabled: true,
        environmentPolicy: "inherit-host",
        version: 1,
        createdAt: "2026-08-28T10:00:00.000Z",
        updatedAt: "2026-08-28T10:00:00.000Z",
      });

      expect(() =>
        makeConfiguredProviderDriver(instance, {
          openCodeProcess: { start: () => Effect.die("must not start OpenCode") },
          codexProcess: { start: () => Effect.die("must not start Codex") },
          runtimeRegistry: new ProviderRuntimeRegistry(),
          permissionPersistence: () => "current-session",
        }),
      ).toThrow(/invalid/i);
    },
  );

  it("rejects existing and future paths that escape through a Project symlink", () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-server-paths-"));
    directories.push(directory);
    const projectRoot = join(directory, "project");
    const outside = join(directory, "outside");
    mkdirSync(projectRoot);
    mkdirSync(outside);
    symlinkSync(outside, join(projectRoot, "escape"));
    const canonicalRoot = realpathSync(projectRoot);

    expect(pathIsProjectConfined(canonicalRoot, join(canonicalRoot, "escape"))).toBe(false);
    expect(pathIsProjectConfined(canonicalRoot, join(canonicalRoot, "escape", "future.txt"))).toBe(
      false,
    );
    expect(pathIsProjectConfined(canonicalRoot, join(canonicalRoot, "future.txt"))).toBe(true);
  });

  it("dispatches HTTP providers without starting an OpenCode process", () => {
    const instance = decodeProviderInstance({
      id: "80000000-0000-4000-8000-000000000401",
      displayName: "Private gateway",
      driverKind: "openai-compatible",
      configuration: {
        kind: "openai-compatible-http",
        baseUrl: "https://gateway.example/v1/",
        authentication: "bearer",
        protocol: "auto",
        manualModelIds: [],
      },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: "2026-07-15T10:00:00.000Z",
      updatedAt: "2026-07-15T10:00:00.000Z",
    });

    const fetch = vi.fn(async () => Response.json({ data: [] }));
    const driver = makeConfiguredProviderDriver(instance, {
      openCodeProcess: { start: () => Effect.die("must not start OpenCode") },
      codexProcess: { start: () => Effect.die("must not start Codex") },
      runtimeRegistry: new ProviderRuntimeRegistry(),
      permissionPersistence: () => "current-session",
      credentialResolver: { has: async () => true, resolve: async () => "private-key" },
      fetch,
    });
    expect(driver.kind).toBe("openai-compatible");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("dispatches Claude with only the injected Claude runtime ports", async () => {
    const instance = decodeProviderInstance({
      id: "80000000-0000-4000-8000-000000000402",
      displayName: "Claude local",
      driverKind: "claude",
      configuration: {
        kind: "claude-agent-sdk",
        binaryPath: "/missing/claude",
        authentication: "subscription",
      },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: "2026-07-16T10:00:00.000Z",
      updatedAt: "2026-07-16T10:00:00.000Z",
    });
    const probeVersion = vi.fn(() =>
      Effect.fail({ category: "unavailable" as const, message: "Claude process selected." }),
    );
    const driver = makeConfiguredProviderDriver(instance, {
      openCodeProcess: { start: () => Effect.die("must not start OpenCode") },
      codexProcess: { start: () => Effect.die("must not start Codex") },
      claudeProcess: { probeVersion } as unknown as ClaudeProcessPort,
      claudeSdk: {} as ClaudeAgentSdkPort,
      claudeResumeIdentityPort: {
        lookup: async () => undefined,
        put: async () => undefined,
        remove: async () => undefined,
      },
      isProjectConfinedPath: () => false,
      runtimeRegistry: new ProviderRuntimeRegistry(),
      permissionPersistence: () => "current-session",
    });

    await expect(
      Effect.runPromise(Effect.scoped(driver.probe({ instanceId: instance.id }))),
    ).rejects.toThrow(/Claude process selected/);
    expect(probeVersion).toHaveBeenCalledOnce();
  });

  it.each([
    {
      id: "80000000-0000-4000-8000-000000000403",
      displayName: "Kimi local",
      driverKind: "kimi-code",
      configuration: { kind: "kimi-code-acp", binaryPath: "/missing/kimi" },
    },
    {
      id: "80000000-0000-4000-8000-000000000404",
      displayName: "Mistral Vibe local",
      driverKind: "mistral-vibe",
      configuration: {
        kind: "mistral-vibe-acp",
        binaryPath: "/missing/vibe-acp",
        authentication: "subscription",
      },
    },
    {
      id: "80000000-0000-4000-8000-000000000405",
      displayName: "Devin local",
      driverKind: "devin",
      configuration: {
        kind: "devin-acp",
        binaryPath: "/missing/devin",
        authentication: "subscription",
      },
    },
    {
      id: "80000000-0000-4000-8000-000000000406",
      displayName: "Kilo local",
      driverKind: "kilo",
      configuration: { kind: "kilo-acp", binaryPath: "/missing/kilo" },
    },
  ] as const)(
    "dispatches $driverKind through the shared ACP runtime port and per-kind managed home",
    async (candidate) => {
      const instance = decodeProviderInstance({
        ...candidate,
        enabled: true,
        environmentPolicy: "inherit-host",
        version: 1,
        createdAt: "2026-07-17T10:00:00.000Z",
        updatedAt: "2026-07-17T10:00:00.000Z",
      });
      const start = vi.fn(() =>
        Effect.fail({ category: "unavailable" as const, message: "ACP process selected." }),
      );
      const acpHome = vi.fn((kind: string, instanceId: string) => `/managed/${kind}/${instanceId}`);
      const driver = makeConfiguredProviderDriver(instance, {
        openCodeProcess: { start: () => Effect.die("must not start OpenCode") },
        codexProcess: { start: () => Effect.die("must not start Codex") },
        acpProcess: { start } as unknown as AcpProcessPort,
        acpHome,
        runtimeRegistry: new ProviderRuntimeRegistry(),
        permissionPersistence: () => "current-session",
      });

      await expect(
        Effect.runPromise(Effect.scoped(driver.probe({ instanceId: instance.id }))),
      ).rejects.toThrow(/ACP process selected/);
      expect(start).toHaveBeenCalledOnce();
      expect(start).toHaveBeenCalledWith(
        expect.objectContaining({
          profile: expect.objectContaining({ kind: candidate.driverKind }),
          managedHome: `/managed/${candidate.driverKind}/${instance.id}`,
        }),
      );
      expect(acpHome).toHaveBeenCalledWith(candidate.driverKind, instance.id);
    },
  );

  it("returns Octant storage readiness and keeps unknown routes at 404", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-server-"));
    directories.push(directory);
    const windowId = "00000000-0000-4000-8000-000000000401";
    const capability = "A".repeat(43);
    const rendererIdentity = `${"C".repeat(42)}A`;
    const desktopSecret = `${"B".repeat(42)}A`;
    const shellHeaders = {
      "content-type": "application/json",
      "x-octant-window-capability": capability,
      "x-octant-renderer-identity": rendererIdentity,
    };
    let stoppedWithActiveConnections = false;
    let maxRequestBodySize: number | undefined;
    let routeHandler: ((request: Request) => Response | Promise<Response>) | undefined;

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* startOctantServer({
            hostname: "127.0.0.1",
            port: 0,
            instanceId: "managed-instance",
            desktopBridgeSecret: desktopSecret,
            serve: (options) => {
              routeHandler = options.fetch;
              maxRequestBodySize = options.maxRequestBodySize;
              return {
                url: new URL("http://127.0.0.1:13773"),
                stop: (closeActiveConnections) => {
                  stoppedWithActiveConnections = closeActiveConnections === true;
                },
              };
            },
          });
          const health = yield* Effect.promise(() =>
            Promise.resolve(routeHandler?.(new Request(new URL("/health", server.url)))).then(
              assertResponse,
            ),
          );
          const healthBody = yield* Effect.promise(() => health.json());
          expect(healthBody).toEqual({
            product: "Octant",
            status: "ok",
            storage: "ready",
            version: "0.0.0-dev",
            instanceId: "managed-instance",
            activeAgentCount: 0,
            attentionRequired: false,
          });

          const rendererOrigin = "http://127.0.0.1:5181";
          const hosts = yield* Effect.promise(() =>
            Promise.resolve(
              routeHandler?.(
                new Request(new URL("/api/hosts", server.url), {
                  headers: { origin: rendererOrigin },
                }),
              ),
            ).then(assertResponse),
          );
          expect(hosts.status).toBe(200);
          expect(hosts.headers.get("access-control-allow-origin")).toBe(rendererOrigin);
          expect(hosts.headers.get("vary")).toBe("Origin");

          const authority = yield* Effect.promise(() =>
            Promise.resolve(
              routeHandler?.(
                new Request(new URL("/api/desktop/window-authorities", server.url), {
                  method: "POST",
                  headers: { "x-octant-desktop-secret": desktopSecret },
                  body: JSON.stringify({ windowId, capability, rendererIdentity }),
                }),
              ),
            ).then(assertResponse),
          );
          expect(authority.status).toBe(204);

          const bootstrap = yield* Effect.promise(() =>
            Promise.resolve(
              routeHandler?.(
                new Request(new URL("/api/shell/bootstrap", server.url), {
                  method: "POST",
                  headers: {
                    "x-octant-window-capability": capability,
                    "x-octant-renderer-identity": rendererIdentity,
                  },
                }),
              ),
            ).then(assertResponse),
          );
          expect(bootstrap.status).toBe(200);
          expect(yield* Effect.promise(() => bootstrap.json())).toMatchObject({
            connectionStatus: "connected",
            settingsVersion: 0,
            workspaceVersion: 0,
          });

          const switchToCode = yield* Effect.promise(() =>
            Promise.resolve(
              routeHandler?.(
                new Request(new URL("/api/shell/commands", server.url), {
                  method: "POST",
                  headers: shellHeaders,
                  body: JSON.stringify({
                    kind: "apply-workspace-operation",
                    windowId,
                    expectedVersion: 0,
                    operation: { kind: "set-active-mode", mode: "code" },
                  }),
                }),
              ),
            ).then(assertResponse),
          );
          expect(switchToCode.status).toBe(200);

          const command = yield* Effect.promise(() =>
            Promise.resolve(
              routeHandler?.(
                new Request(new URL("/api/shell/commands", server.url), {
                  method: "POST",
                  headers: shellHeaders,
                  body: JSON.stringify({
                    kind: "replace-settings",
                    windowId,
                    expectedVersion: 0,
                    settings: {
                      chatEnabled: false,
                      workEnabled: false,
                      sidebarWidth: 320,
                      contextSidebarWidth: 360,
                      lastContextSurface: "project-memory",
                      sidebarMaterial: "opaque",
                      modeSwitcherPresentation: "dropdown",
                    },
                  }),
                }),
              ),
            ).then(assertResponse),
          );
          expect(command.status).toBe(200);
          expect(yield* Effect.promise(() => command.json())).toMatchObject({
            kind: "settings-replaced",
            version: 1,
          });

          const committedBootstrap = yield* Effect.promise(() =>
            Promise.resolve(
              routeHandler?.(
                new Request(new URL("/api/shell/bootstrap", server.url), {
                  headers: {
                    "x-octant-window-capability": capability,
                    "x-octant-renderer-identity": rendererIdentity,
                  },
                }),
              ),
            ).then(assertResponse),
          );
          expect(yield* Effect.promise(() => committedBootstrap.json())).toMatchObject({
            settings: {
              chatEnabled: false,
              workEnabled: false,
              sidebarWidth: 320,
              contextSidebarWidth: 360,
              lastContextSurface: "project-memory",
              modeSwitcherPresentation: "dropdown",
            },
            settingsVersion: 1,
            workspaceVersion: 1,
          });

          for (const operation of [
            { kind: "set-active-mode", mode: "chat" },
            { kind: "reset-mode", mode: "work" },
          ]) {
            const rejected = yield* Effect.promise(() =>
              Promise.resolve(
                routeHandler?.(
                  new Request(new URL("/api/shell/commands", server.url), {
                    method: "POST",
                    headers: shellHeaders,
                    body: JSON.stringify({
                      kind: "apply-workspace-operation",
                      windowId,
                      expectedVersion: 1,
                      operation,
                    }),
                  }),
                ),
              ).then(assertResponse),
            );
            expect(rejected.status).toBe(400);
            expect(yield* Effect.promise(() => rejected.json())).toMatchObject({
              category: "unsupported",
            });
          }

          const afterRejection = yield* Effect.promise(() =>
            Promise.resolve(
              routeHandler?.(
                new Request(new URL("/api/shell/bootstrap", server.url), {
                  headers: {
                    "x-octant-window-capability": capability,
                    "x-octant-renderer-identity": rendererIdentity,
                  },
                }),
              ),
            ).then(assertResponse),
          );
          expect(yield* Effect.promise(() => afterRejection.json())).toMatchObject({
            workspace: { activeMode: "code", version: 1 },
            workspaceVersion: 1,
          });

          const codeCommand = yield* Effect.promise(() =>
            Promise.resolve(
              routeHandler?.(
                new Request(new URL("/api/shell/commands", server.url), {
                  method: "POST",
                  headers: shellHeaders,
                  body: JSON.stringify({
                    kind: "apply-workspace-operation",
                    windowId,
                    expectedVersion: 1,
                    operation: { kind: "reset-mode", mode: "code" },
                  }),
                }),
              ),
            ).then(assertResponse),
          );
          expect(codeCommand.status).toBe(200);
          expect(yield* Effect.promise(() => codeCommand.json())).toMatchObject({
            kind: "workspace-replaced",
            version: 2,
            workspace: { activeMode: "code", version: 2 },
          });

          const missing = yield* Effect.promise(() =>
            Promise.resolve(routeHandler?.(new Request(new URL("/api/missing", server.url)))).then(
              assertResponse,
            ),
          );
          expect(missing.status).toBe(404);
        }).pipe(Effect.provide(makePersistenceLive({ dataDirectory: directory }))),
      ),
    );

    expect(stoppedWithActiveConnections).toBe(true);
    expect(maxRequestBodySize).toBe(MAX_CHAT_ATTACHMENT_BYTES);
    expect(MAX_JSON_REQUEST_BODY_SIZE).toBe(1_048_576);
  });

  it("keeps JSON route handlers on the 1 MiB ceiling while transport allows attachments", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-server-json-limit-"));
    directories.push(directory);
    let routeHandler: ((request: Request) => Response | Promise<Response>) | undefined;

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* startOctantServer({
            hostname: "127.0.0.1",
            port: 0,
            desktopBridgeSecret: "desktop-secret",
            serve: (options) => {
              routeHandler = options.fetch;
              expect(options.maxRequestBodySize).toBe(MAX_CHAT_ATTACHMENT_BYTES);
              return { url: new URL("http://127.0.0.1:13773"), stop: () => undefined };
            },
          });

          const capability = "A".repeat(43);
          const windowId = "00000000-0000-4000-8000-000000000480";
          yield* Effect.promise(() =>
            Promise.resolve(
              routeHandler?.(
                new Request("http://127.0.0.1:13773/api/desktop/window-authorities", {
                  method: "POST",
                  headers: { "x-octant-desktop-secret": "desktop-secret" },
                  body: JSON.stringify({ windowId, capability }),
                }),
              ),
            ),
          );

          const oversizedBody = JSON.stringify({
            kind: "inspect",
            subject: {
              aggregateType: "project",
              aggregateId: "00000000-0000-4000-8000-000000000481",
            },
            padding: "x".repeat(MAX_JSON_REQUEST_BODY_SIZE),
          });

          const response = yield* Effect.promise(() =>
            Promise.resolve(
              routeHandler?.(
                new Request("http://127.0.0.1:13773/api/context/inspect", {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    "content-length": String(Buffer.byteLength(oversizedBody, "utf8")),
                    "x-octant-window-capability": capability,
                  },
                  body: oversizedBody,
                }),
              ),
            ).then(assertResponse),
          );

          expect(response.status).toBe(413);
        }).pipe(Effect.provide(makePersistenceLive({ dataDirectory: directory }))),
      ),
    );
  });

  it("serves provider limits through the authenticated local product route", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-server-provider-limits-route-"));
    directories.push(directory);
    let routeHandler: ((request: Request) => Response | Promise<Response>) | undefined;
    const capability = "A".repeat(43);
    const windowId = "00000000-0000-4000-8000-000000000482";

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* startOctantServer({
            hostname: "127.0.0.1",
            port: 0,
            desktopBridgeSecret: "desktop-secret",
            serve: (options) => {
              routeHandler = options.fetch;
              return { url: new URL("http://127.0.0.1:13773"), stop: () => undefined };
            },
          });

          const registered = yield* Effect.promise(() =>
            Promise.resolve(
              routeHandler?.(
                new Request("http://127.0.0.1:13773/api/desktop/window-authorities", {
                  method: "POST",
                  headers: { "x-octant-desktop-secret": "desktop-secret" },
                  body: JSON.stringify({ windowId, capability }),
                }),
              ),
            ),
          );
          expect(registered?.status).toBe(204);

          const response = yield* Effect.promise(() =>
            Promise.resolve(
              routeHandler?.(
                new Request("http://127.0.0.1:13773/api/provider-usage-limits", {
                  headers: { "x-octant-window-capability": capability },
                }),
              ),
            ),
          );
          expect(response?.status).toBe(200);
          const body = yield* Effect.promise(() => Promise.resolve(response?.json()));
          expect(body).toMatchObject({ version: 1, entries: [] });
        }).pipe(Effect.provide(makePersistenceLive({ dataDirectory: directory }))),
      ),
    );
  });

  it("registers authenticated Code routes while preserving the larger Chat outer ceiling", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-server-code-routes-"));
    directories.push(directory);
    let routeHandler: ((request: Request) => Response | Promise<Response>) | undefined;
    const bootstrap = vi.fn(async () =>
      decodeCodeBootstrap({
        settings: {
          defaultExecutionPolicy: "approval-gated",
          defaultPermissionPersistence: "current-session",
          version: 0,
          updatedAt: "2026-07-20T23:00:00.000Z",
        },
        threads: [],
        checkouts: [],
        activity: [],
      }),
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* startOctantServer({
            hostname: "127.0.0.1",
            port: 0,
            desktopBridgeSecret: "desktop-secret",
            codeService: {
              bootstrap,
              navigation: vi.fn(async () => ({ threads: [], activity: [], runtime: [] })),
              read: vi.fn(),
              execute: vi.fn(),
              subscribe: vi.fn(async function* () {}),
              readContent: vi.fn(),
              saveFile: vi.fn(),
              openFile: vi.fn(),
            },
            serve: (options) => {
              routeHandler = options.fetch;
              expect(options.maxRequestBodySize).toBe(MAX_CHAT_ATTACHMENT_BYTES);
              expect(MAX_CHAT_ATTACHMENT_BYTES).toBeGreaterThan(MAX_CODE_FILE_BODY_SIZE);
              expect(MAX_CODE_FILE_BODY_SIZE).toBeGreaterThan(MAX_JSON_REQUEST_BODY_SIZE);
              return { url: new URL("http://127.0.0.1:13773"), stop: () => undefined };
            },
          });

          const capability = "A".repeat(43);
          const windowId = "00000000-0000-4000-8000-000000001201";
          yield* Effect.promise(() =>
            Promise.resolve(
              routeHandler?.(
                new Request("http://127.0.0.1:13773/api/desktop/window-authorities", {
                  method: "POST",
                  headers: { "x-octant-desktop-secret": "desktop-secret" },
                  body: JSON.stringify({ windowId, capability }),
                }),
              ),
            ),
          );
          const response = yield* Effect.promise(() =>
            Promise.resolve(
              routeHandler?.(
                new Request("http://127.0.0.1:13773/api/code/bootstrap", {
                  headers: { "x-octant-window-capability": capability },
                }),
              ),
            ).then(assertResponse),
          );

          expect(response.status).toBe(200);
          expect(bootstrap).toHaveBeenCalledWith(windowId);
        }).pipe(Effect.provide(makePersistenceLive({ dataDirectory: directory }))),
      ),
    );
  });

  it("wires the server-owned Code operation runtime into commands, replay, and shutdown", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-server-code-operations-"));
    directories.push(directory);
    let routeHandler: ((request: Request) => Response | Promise<Response>) | undefined;
    const operationId = "00000000-0000-4000-8000-000000001211";
    const threadId = "00000000-0000-4000-8000-000000001212";
    const checkoutId = "00000000-0000-4000-8000-000000001213";
    const result = decodeCodeOperationResult({
      kind: "operation-failed",
      operationId,
      failure: { category: "unavailable", message: "Injected operation runtime." },
    });
    const runtime = {
      prepareApproval: vi.fn(async () => undefined),
      confirmApproval: vi.fn(async () => undefined),
      validateAppleApproval: vi.fn(async () => false),
      revokeApprovals: vi.fn(),
      execute: vi.fn(async () => result),
      inspectTerminal: vi.fn(),
      subscribe: vi.fn(async () => []),
      conversation: vi.fn(async (_windowId, threadId, _afterCursor, _limit) => ({
        version: 3 as const,
        threadId,
        turns: [],
        nextCursor: 0,
        hasMore: false,
      })),
      readEvidence: vi.fn(),
      readEvidenceBatch: vi.fn(async (_windowId, input) => ({
        threadId: input.threadId,
        items: [],
      })),
      close: vi.fn(async () => undefined),
    };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* startOctantServer({
            hostname: "127.0.0.1",
            port: 0,
            desktopBridgeSecret: "desktop-secret",
            codeOperationRuntime: runtime,
            serve: (options) => {
              routeHandler = options.fetch;
              return { url: new URL("http://127.0.0.1:13773"), stop: () => undefined };
            },
          });
          const capability = "A".repeat(43);
          const windowId = "00000000-0000-4000-8000-000000001214";
          yield* Effect.promise(() =>
            Promise.resolve(
              routeHandler?.(
                new Request("http://127.0.0.1:13773/api/desktop/window-authorities", {
                  method: "POST",
                  headers: { "x-octant-desktop-secret": "desktop-secret" },
                  body: JSON.stringify({ windowId, capability }),
                }),
              ),
            ),
          );
          const command = {
            kind: "observe-git",
            operationId,
            threadId,
            checkoutId,
            gitOperationId: "00000000-0000-4000-8000-000000001215",
            maxDiffBytes: 1024,
          };
          const response = yield* Effect.promise(() =>
            Promise.resolve(
              routeHandler?.(
                new Request("http://127.0.0.1:13773/api/code/commands", {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    "x-octant-window-capability": capability,
                  },
                  body: JSON.stringify(command),
                }),
              ),
            ).then(assertResponse),
          );
          expect(response.status).toBe(200);
          expect(yield* Effect.promise(() => response.json())).toEqual(result);
          // The HTTP route speaks for the person at the window.
          expect(runtime.execute).toHaveBeenCalledWith(windowId, command, { initiator: "user" });

          const replay = yield* Effect.promise(() =>
            Promise.resolve(
              routeHandler?.(
                new Request(
                  `http://127.0.0.1:13773/api/code/threads/${threadId}/operations/${operationId}/events?afterCursor=0`,
                  { headers: { "x-octant-window-capability": capability } },
                ),
              ),
            ).then(assertResponse),
          );
          expect(replay.status).toBe(200);
          expect(runtime.subscribe).toHaveBeenCalledWith(windowId, threadId, operationId, 0, 100);

          const evidenceBatch = yield* Effect.promise(() =>
            Promise.resolve(
              routeHandler?.(
                new Request("http://127.0.0.1:13773/api/code/evidence/batch", {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    "x-octant-window-capability": capability,
                  },
                  body: JSON.stringify({ threadId, items: [] }),
                }),
              ),
            ).then(assertResponse),
          );
          expect(evidenceBatch.status).toBe(200);
          expect(runtime.readEvidenceBatch).toHaveBeenCalledWith(windowId, {
            threadId,
            items: [],
          });
        }).pipe(Effect.provide(makePersistenceLive({ dataDirectory: directory }))),
      ),
    );
    expect(runtime.close).toHaveBeenCalledOnce();
  });

  it("derives existing-worktree file roots from current Project and repository authority", async () => {
    const projectId = "00000000-0000-4000-8000-000000001301";
    const revisionId = "00000000-0000-4000-8000-000000001302";
    const repositoryId = `repo_${"a".repeat(64)}` as `repo_${string}`;
    const root = "/private/authorized-project";
    const checkoutId = deriveExistingWorktreeCheckoutId({
      projectId,
      bindingRevisionId: revisionId,
      repositoryId,
      canonicalRoot: root,
    });
    const observed = {
      status: "available" as const,
      repositoryId,
      repositoryRoot: root,
      commonDirectory: "/private/git",
      objectDirectory: "/private/git/objects",
      checkout: {
        status: "present" as const,
        canonicalPath: root,
        reportedPath: root,
        head: "b".repeat(40),
        detached: true,
      },
      worktrees: [],
    };
    const observe = vi
      .fn()
      .mockResolvedValueOnce(observed)
      .mockResolvedValueOnce({
        ...observed,
        checkout: { ...observed.checkout, locked: "in use" },
      });
    const authority = createExistingWorktreeCodeFileRootAuthority({
      projects: {
        bootstrap: vi.fn(
          async () =>
            ({
              active: [{ id: projectId, type: "code", binding: { canonicalRoot: root } }],
              archived: [],
              availability: [],
              memory: [],
            }) as never,
        ),
      },
      readProject: vi.fn(
        () =>
          ({
            id: projectId,
            type: "code",
            lifecycle: "active",
            binding: { canonicalRoot: root },
            bindingHistory: [{ revisionId, currentBinding: { canonicalRoot: root } }],
          }) as never,
      ),
      repository: { observe },
      statIdentity: vi.fn(async () => ({ device: "7", inode: "8" })),
    });
    const thread = {
      id: "00000000-0000-4000-8000-000000001303",
      projectId,
      bindingRevisionId: revisionId,
      repositoryId,
    } as never;
    const checkout = {
      id: checkoutId,
      kind: "existing-worktree",
      repositoryId,
      availability: "available",
      head: { kind: "detached", oid: "b".repeat(40) },
    } as never;

    await expect(
      authority.resolve(
        "00000000-0000-4000-8000-000000001305" as never,
        thread,
        checkout,
        "src/file.ts" as never,
      ),
    ).resolves.toMatchObject({
      rootPath: root,
      rootIdentity: { device: "7", inode: "8" },
    });

    await expect(
      authority.resolve(
        "00000000-0000-4000-8000-000000001305" as never,
        thread,
        {
          id: "00000000-0000-4000-8000-000000001399",
          kind: "existing-worktree",
          repositoryId,
          availability: "available",
          head: { kind: "detached", oid: "b".repeat(40) },
        } as never,
        "src/file.ts" as never,
      ),
    ).resolves.toBeUndefined();

    await expect(
      authority.resolve(
        "00000000-0000-4000-8000-000000001305" as never,
        thread,
        checkout,
        "src/file.ts" as never,
      ),
    ).resolves.toBeUndefined();

    await expect(
      authority.resolve(
        "00000000-0000-4000-8000-000000001305" as never,
        thread,
        {
          id: "00000000-0000-4000-8000-000000001304",
          kind: "managed-worktree",
          repositoryId,
          availability: "available",
        } as never,
        "src/file.ts" as never,
      ),
    ).resolves.toBeUndefined();
    expect(observe).toHaveBeenCalledTimes(2);
  });

  it("keeps a branch checkout's file root after new commits but not after a branch switch", async () => {
    const projectId = "00000000-0000-4000-8000-000000001401" as never;
    const revisionId = "00000000-0000-4000-8000-000000001402" as never;
    const repositoryId = `repo_${"c".repeat(64)}` as `repo_${string}`;
    const root = "/private/authorized-project";
    const checkoutId = deriveExistingWorktreeCheckoutId({
      projectId,
      bindingRevisionId: revisionId,
      repositoryId,
      canonicalRoot: root,
    });
    const observation = (head: string, branch: string) => ({
      status: "available" as const,
      repositoryId,
      repositoryRoot: root,
      commonDirectory: "/private/git",
      objectDirectory: "/private/git/objects",
      checkout: {
        status: "present" as const,
        canonicalPath: root,
        reportedPath: root,
        head,
        detached: false,
        branch: `refs/heads/${branch}`,
      },
      worktrees: [],
    });
    const observe = vi
      .fn()
      // A commit landed: same branch, new HEAD.
      .mockResolvedValueOnce(observation("d".repeat(40), "main"))
      // The user switched branches under us.
      .mockResolvedValueOnce(observation("d".repeat(40), "feature/other"));
    const authority = createExistingWorktreeCodeFileRootAuthority({
      projects: {
        bootstrap: vi.fn(
          async () =>
            ({
              active: [{ id: projectId, type: "code", binding: { canonicalRoot: root } }],
              archived: [],
              availability: [],
              memory: [],
            }) as never,
        ),
      },
      readProject: vi.fn(
        () =>
          ({
            id: projectId,
            type: "code",
            lifecycle: "active",
            binding: { canonicalRoot: root },
            bindingHistory: [{ revisionId, currentBinding: { canonicalRoot: root } }],
          }) as never,
      ),
      repository: { observe },
      statIdentity: vi.fn(async () => ({ device: "7", inode: "8" })),
    });
    const thread = {
      id: "00000000-0000-4000-8000-000000001403",
      projectId,
      bindingRevisionId: revisionId,
      repositoryId,
    } as never;
    const checkout = {
      id: checkoutId,
      kind: "existing-worktree",
      repositoryId,
      availability: "available",
      head: { kind: "branch", name: "main", oid: "b".repeat(40) },
    } as never;
    const windowId = "00000000-0000-4000-8000-000000001405" as never;

    await expect(
      authority.resolve(windowId, thread, checkout, "src/file.ts" as never),
    ).resolves.toMatchObject({ rootPath: root });
    await expect(
      authority.resolve(windowId, thread, checkout, "src/file.ts" as never),
    ).resolves.toBeUndefined();
  });

  it("derives managed-worktree file roots only from an exact ready ownership receipt", async () => {
    const projectId = "00000000-0000-4000-8000-000000001321";
    const revisionId = "00000000-0000-4000-8000-000000001322";
    const threadId = "00000000-0000-4000-8000-000000001323";
    const checkoutId = "00000000-0000-4000-8000-000000001324";
    const receiptId = "00000000-0000-4000-8000-000000001325";
    const repositoryId = `repo_${"e".repeat(64)}` as `repo_${string}`;
    const repositoryRoot = "/private/authorized-project";
    const worktreeRoot = "/private/managed-worktrees/issue-487";
    const head = "f".repeat(40);
    const receipt = {
      version: 1 as const,
      receiptId,
      repositoryId,
      threadId,
      checkoutId,
      canonicalRepositoryPath: repositoryRoot,
      canonicalWorktreePath: worktreeRoot,
      branchIntent: "feature/issue-487",
      refIntent: "refs/heads/development",
      expectedHead: head,
      state: "ready" as const,
      createdAt: "2026-07-31T22:00:00.000Z",
      updatedAt: "2026-07-31T22:00:00.000Z",
    };
    const observation = {
      status: "available" as const,
      repositoryId,
      repositoryRoot,
      commonDirectory: "/private/git",
      objectDirectory: "/private/git/objects",
      checkout: {
        status: "present" as const,
        canonicalPath: repositoryRoot,
        reportedPath: repositoryRoot,
        head,
        branch: "refs/heads/development",
        detached: false,
      },
      worktrees: [
        {
          status: "present" as const,
          canonicalPath: worktreeRoot,
          reportedPath: worktreeRoot,
          head,
          branch: "refs/heads/feature/issue-487",
          detached: false,
        },
      ],
    };
    const load = vi
      .fn()
      .mockResolvedValueOnce(receipt)
      .mockResolvedValueOnce({
        ...receipt,
        state: "cleanup-pending" as const,
      });
    const authority = createExistingWorktreeCodeFileRootAuthority({
      projects: {
        bootstrap: vi.fn(
          async () =>
            ({
              active: [{ id: projectId, type: "code", binding: { canonicalRoot: repositoryRoot } }],
              archived: [],
              availability: [],
              memory: [],
            }) as never,
        ),
      },
      readProject: vi.fn(
        () =>
          ({
            id: projectId,
            type: "code",
            lifecycle: "active",
            binding: { canonicalRoot: repositoryRoot },
            bindingHistory: [{ revisionId, currentBinding: { canonicalRoot: repositoryRoot } }],
          }) as never,
      ),
      repository: { observe: vi.fn(async () => observation) },
      managedReceipts: { load },
      statIdentity: vi.fn(async () => ({ device: "9", inode: "10" })),
    });
    const thread = {
      id: threadId,
      projectId,
      bindingRevisionId: revisionId,
      repositoryId,
    } as never;
    const checkout = {
      id: checkoutId,
      kind: "managed-worktree",
      repositoryId,
      availability: "available",
      ownershipReceiptId: receiptId,
      head: { kind: "branch", name: "feature/issue-487", oid: head },
    } as never;

    await expect(
      authority.resolve(
        "00000000-0000-4000-8000-000000001326" as never,
        thread,
        checkout,
        "src/file.ts" as never,
      ),
    ).resolves.toMatchObject({
      rootPath: worktreeRoot,
      rootIdentity: { device: "9", inode: "10" },
    });
    await expect(
      authority.resolve(
        "00000000-0000-4000-8000-000000001326" as never,
        thread,
        checkout,
        "src/file.ts" as never,
      ),
    ).resolves.toBeUndefined();
  });

  it("prepares only the authenticated Project's current unlocked checkout", async () => {
    const projectId = "00000000-0000-4000-8000-000000001311";
    const revisionId = "00000000-0000-4000-8000-000000001312";
    const root = "/private/current-code-project";
    const repositoryId = `repo_${"c".repeat(64)}` as `repo_${string}`;
    const observation = {
      status: "available" as const,
      repositoryId,
      repositoryRoot: root,
      commonDirectory: "/private/git",
      objectDirectory: "/private/git/objects",
      checkout: {
        status: "present" as const,
        canonicalPath: root,
        reportedPath: root,
        head: "d".repeat(40),
        branch: "refs/heads/development",
        detached: false,
      },
      worktrees: [],
    };
    const observe = vi
      .fn()
      .mockResolvedValueOnce(observation)
      .mockResolvedValueOnce({
        ...observation,
        checkout: { ...observation.checkout, locked: "in use" },
      });
    const checkoutAuthority = createExistingWorktreeCodeCheckoutObservation({
      projects: {
        bootstrap: vi.fn(
          async () =>
            ({
              active: [{ id: projectId, type: "code", binding: { canonicalRoot: root } }],
              archived: [],
              availability: [],
              memory: [],
            }) as never,
        ),
      },
      readProject: vi.fn(
        () =>
          ({
            id: projectId,
            type: "code",
            lifecycle: "active",
            binding: { canonicalRoot: root },
            bindingHistory: [{ revisionId, currentBinding: { canonicalRoot: root } }],
          }) as never,
      ),
      repository: { observe },
      clock: () => "2026-07-21T17:00:00.000Z",
    });

    const prepared = await checkoutAuthority.observe(
      "00000000-0000-4000-8000-000000001315" as never,
      projectId as never,
    );
    expect(prepared).toMatchObject({
      bindingRevisionId: revisionId,
      checkout: {
        kind: "existing-worktree",
        repositoryId,
        head: { kind: "branch", name: "development", oid: "d".repeat(40) },
      },
    });
    expect(JSON.stringify(prepared)).not.toContain(root);

    await expect(
      checkoutAuthority.observe(
        "00000000-0000-4000-8000-000000001315" as never,
        projectId as never,
      ),
    ).rejects.toThrow(/unavailable/i);
  });

  it("names why a Code checkout could not be observed instead of always prescribing git init", async () => {
    // Every one of these used to reach the composer as "this folder has no Git
    // checkout, run git init in it", which is true of exactly one of them.
    const projectId = "00000000-0000-4000-8000-000000001321";
    const revisionId = "00000000-0000-4000-8000-000000001322";
    const root = "/private/some-code-project";
    const authorityFor = (observed: unknown) =>
      createExistingWorktreeCodeCheckoutObservation({
        projects: {
          bootstrap: vi.fn(
            async () =>
              ({
                active: [{ id: projectId, type: "code", binding: { canonicalRoot: root } }],
                archived: [],
                availability: [],
                memory: [],
              }) as never,
          ),
        },
        readProject: vi.fn(
          () =>
            ({
              id: projectId,
              type: "code",
              lifecycle: "active",
              binding: { canonicalRoot: root },
              bindingHistory: [{ revisionId, currentBinding: { canonicalRoot: root } }],
            }) as never,
        ),
        repository: { observe: vi.fn(async () => observed as never) },
        clock: () => "2026-07-21T17:00:00.000Z",
      });
    const observing = (observed: unknown) =>
      authorityFor(observed).observe(
        "00000000-0000-4000-8000-000000001325" as never,
        projectId as never,
      );

    await expect(observing({ status: "unavailable", reason: "not-repository" })).rejects.toThrow(
      /not a Git repository.*git init/i,
    );
    await expect(
      observing({ status: "unavailable", reason: "root-missing-or-moved" }),
    ).rejects.toThrow(/missing or has moved/i);
    await expect(observing({ status: "ineligible", reason: "bare" })).rejects.toThrow(/bare/i);
    await expect(observing({ status: "ineligible", reason: "submodule" })).rejects.toThrow(
      /submodule/i,
    );
    await expect(observing({ status: "failed" })).rejects.toThrow(/could not be inspected/i);

    // Only the genuinely repository-less folder is told to run git init.
    for (const observed of [
      { status: "unavailable", reason: "root-missing-or-moved" },
      { status: "ineligible", reason: "bare" },
      { status: "ineligible", reason: "submodule" },
      { status: "failed" },
    ]) {
      await expect(observing(observed)).rejects.not.toThrow(/git init/i);
    }
  });

  it("owns and closes a configured Code file helper transport", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-server-code-helper-"));
    directories.push(directory);
    const close = vi.fn(async () => undefined);
    const createCodeFileHelperTransport = vi.fn(() => ({
      write: vi.fn(),
      onData: vi.fn(() => () => undefined),
      onExit: vi.fn(() => () => undefined),
      close,
    }));

    await Effect.runPromise(
      Effect.scoped(
        startOctantServer({
          hostname: "127.0.0.1",
          port: 0,
          codeFileHelperPath: "/Applications/Octant/helper",
          createCodeFileHelperTransport,
          serve: () => ({ url: new URL("http://127.0.0.1:13773"), stop: () => undefined }),
        }).pipe(Effect.provide(makePersistenceLive({ dataDirectory: directory }))),
      ),
    );

    expect(createCodeFileHelperTransport).toHaveBeenCalledWith("/Applications/Octant/helper");
    expect(close).toHaveBeenCalledOnce();
  });

  it("refuses non-loopback binding before calling the server runtime", async () => {
    let serveCalls = 0;
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        startOctantServer({
          hostname: "0.0.0.0",
          port: 0,
          acquirePersistence: Effect.die("persistence must not be acquired for remote binding"),
          serve: (options) => {
            serveCalls += 1;
            return Bun.serve(options as unknown as Parameters<typeof Bun.serve>[0]);
          },
        }),
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(serveCalls).toBe(0);
  });

  it("keeps loopback serving when the optional private listener is not TLS-ready", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-server-private-listener-"));
    directories.push(directory);
    let localServeCalls = 0;

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* startOctantServer({
            hostname: "127.0.0.1",
            port: 0,
            remoteListener: {
              config: {
                hostname: "192.168.1.20",
                port: 9443,
                origin: "https://192.168.1.20:9443",
                tls: { cert: "not-a-certificate", key: "not-a-key" },
              },
              services: (() => {
                const remoteConnection = openSqlite(join(directory, "remote.sqlite3"));
                applyMigrations(remoteConnection, MIGRATIONS, () => new Date().toISOString());
                const remoteRuntime = createPhase1RuntimeRegistries();
                const remoteJournal = new Journal({
                  connection: remoteConnection,
                  registry: remoteRuntime.events,
                  projections: remoteRuntime.projections,
                  clock: () => new Date().toISOString(),
                });
                return {
                  connection: remoteConnection,
                  journal: remoteJournal,
                  hostId: decodeStableHostId("11111111-1111-4111-8111-111111111111"),
                  displayName: "This Mac",
                  serverBuildVersion: "0.1.0",
                  signing: {
                    hostKeyFingerprint: "a".repeat(64),
                    signHostPayload: () => "signature",
                  },
                  webAssets: () => Promise.resolve(new Response("web", { status: 200 })),
                };
              })(),
            },
            serve: () => {
              localServeCalls += 1;
              return { url: new URL("http://127.0.0.1:13773"), stop: () => undefined };
            },
          });

          expect(localServeCalls).toBe(1);
          expect(server.remoteListener).toBeUndefined();
          expect(server.remoteListenerError).toBe("invalid-tls");
        }).pipe(Effect.provide(makePersistenceLive({ dataDirectory: directory }))),
      ),
    );
  });

  it("composes a private listener lifecycle controller for the packaged server without an injected remote listener", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-server-private-listener-packaged-"));
    directories.push(directory);
    let routeHandler: ((request: Request) => Response | Promise<Response>) | undefined;

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* startOctantServer({
            hostname: "127.0.0.1",
            port: 0,
            desktopBridgeSecret: "desktop-secret",
            serve: (serveOptions) => {
              routeHandler = serveOptions.fetch;
              return { url: new URL("http://127.0.0.1:13773"), stop: () => undefined };
            },
          });
          const capability = "A".repeat(43);
          const windowId = "00000000-0000-4000-8000-000000000661";
          yield* Effect.promise(() =>
            Promise.resolve(
              routeHandler?.(
                new Request("http://127.0.0.1:13773/api/desktop/window-authorities", {
                  method: "POST",
                  headers: { "x-octant-desktop-secret": "desktop-secret" },
                  body: JSON.stringify({ windowId, capability }),
                }),
              ),
            ),
          );
          const response = yield* Effect.promise(() =>
            Promise.resolve(
              routeHandler?.(
                new Request("http://127.0.0.1:13773/api/desktop/private-listener/status", {
                  headers: {
                    "x-octant-desktop-secret": "desktop-secret",
                    "x-octant-window-capability": capability,
                  },
                }),
              ),
            ).then(assertResponse),
          );
          // The packaged server composes the controller from its own graph, so
          // the loopback administration route projects an authoritative disabled
          // status instead of the 503 an undefined controller would return.
          expect(response.status).toBe(200);
          const body = yield* Effect.promise(() => response.json());
          expect(body).toEqual({
            status: {
              enabled: false,
              state: "disabled",
              hostname: null,
              port: null,
              origin: null,
              exposureClass: null,
              certificateFingerprint: null,
              certificateReady: false,
            },
          });
        }).pipe(Effect.provide(makePersistenceLive({ dataDirectory: directory }))),
      ),
    );
  });

  it("F3: propagates remote stop failure while still attempting local stop", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-server-remote-stop-fail-"));
    directories.push(directory);
    let localStopCalled = false;
    let localServeCalls = 0;
    let explicitStopError: unknown;

    // The scoped block starts the server. We call server.stop() inside the
    // scope to verify the error is propagated. The scope's release action
    // will also call server.stop() (which retries — the remote serve always
    // rejects here), so we catch the overall Effect.runPromise rejection.
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const server = yield* startOctantServer({
              hostname: "127.0.0.1",
              port: 0,
              remoteListener: {
                config: {
                  hostname: "192.168.1.20",
                  port: 9443,
                  origin: "https://192.168.1.20:9443",
                  tls: { cert: PRIVATE_LISTENER_TEST_CERT, key: PRIVATE_LISTENER_TEST_KEY },
                },
                services: (() => {
                  const remoteConnection = openSqlite(join(directory, "remote.sqlite3"));
                  applyMigrations(remoteConnection, MIGRATIONS, () => new Date().toISOString());
                  const remoteRuntime = createPhase1RuntimeRegistries();
                  const remoteJournal = new Journal({
                    connection: remoteConnection,
                    registry: remoteRuntime.events,
                    projections: remoteRuntime.projections,
                    clock: () => new Date().toISOString(),
                  });
                  return {
                    connection: remoteConnection,
                    journal: remoteJournal,
                    hostId: decodeStableHostId("11111111-1111-4111-8111-111111111111"),
                    displayName: "This Mac",
                    serverBuildVersion: "0.1.0",
                    signing: {
                      hostKeyFingerprint: "a".repeat(64),
                      signHostPayload: () => "signature",
                    },
                    webAssets: () => Promise.resolve(new Response("web", { status: 200 })),
                  };
                })(),
              },
              remoteServe: () => ({
                url: new URL("https://192.168.1.20:9443"),
                stop: async () => {
                  throw Object.assign(new Error("remote unbind failed"), {
                    code: "shutdown-failed",
                  });
                },
              }),
              serve: () => {
                localServeCalls += 1;
                return {
                  url: new URL("http://127.0.0.1:13773"),
                  stop: () => {
                    localStopCalled = true;
                  },
                };
              },
            });

            expect(server.remoteListener).toBeDefined();
            expect(server.remoteListenerError).toBeUndefined();

            // Call stop() explicitly — must propagate the remote failure.
            // We catch the rejection inside the promise so the Effect
            // succeeds with either "ok" or the error object.
            explicitStopError = yield* Effect.promise(() =>
              Promise.resolve(server.stop()).then(
                () => "ok" as const,
                (error) => error as unknown,
              ),
            );
            expect(localStopCalled).toBe(true);
          }).pipe(Effect.provide(makePersistenceLive({ dataDirectory: directory }))),
        ),
      );
    } catch {
      // Scope release also calls server.stop() which retries and fails again.
    }

    // F3: the explicit stop propagated the remote failure, and local stop
    // was still attempted.
    expect(explicitStopError).not.toBe("ok");
    expect(explicitStopError).toBeDefined();
    expect(localStopCalled).toBe(true);
  });

  it("R4: attempts remote stop even when local stop throws synchronously", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-server-sync-local-throw-"));
    directories.push(directory);
    let remoteStopCalled = false;

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const server = yield* startOctantServer({
              hostname: "127.0.0.1",
              port: 0,
              remoteListener: {
                config: {
                  hostname: "192.168.1.20",
                  port: 9443,
                  origin: "https://192.168.1.20:9443",
                  tls: { cert: PRIVATE_LISTENER_TEST_CERT, key: PRIVATE_LISTENER_TEST_KEY },
                },
                services: (() => {
                  const remoteConnection = openSqlite(join(directory, "remote.sqlite3"));
                  applyMigrations(remoteConnection, MIGRATIONS, () => new Date().toISOString());
                  const remoteRuntime = createPhase1RuntimeRegistries();
                  const remoteJournal = new Journal({
                    connection: remoteConnection,
                    registry: remoteRuntime.events,
                    projections: remoteRuntime.projections,
                    clock: () => new Date().toISOString(),
                  });
                  return {
                    connection: remoteConnection,
                    journal: remoteJournal,
                    hostId: decodeStableHostId("11111111-1111-4111-8111-111111111111"),
                    displayName: "This Mac",
                    serverBuildVersion: "0.1.0",
                    signing: {
                      hostKeyFingerprint: "a".repeat(64),
                      signHostPayload: () => "signature",
                    },
                    webAssets: () => Promise.resolve(new Response("web", { status: 200 })),
                  };
                })(),
              },
              remoteServe: () => ({
                url: new URL("https://192.168.1.20:9443"),
                stop: async () => {
                  remoteStopCalled = true;
                },
              }),
              serve: () => ({
                url: new URL("http://127.0.0.1:13773"),
                // Synchronous throw — must not prevent remote stop
                stop: () => {
                  throw new Error("local stop threw synchronously");
                },
              }),
            });

            expect(server.remoteListener).toBeDefined();

            // Call stop() explicitly — local stop throws synchronously,
            // but remote stop must still be attempted.
            const stopResult = yield* Effect.promise(() =>
              Promise.resolve(server.stop()).then(
                () => "ok" as const,
                (error) => error as unknown,
              ),
            );
            // The local stop error must be propagated
            expect(stopResult).not.toBe("ok");
            // The remote stop must have been called despite the local throw
            expect(remoteStopCalled).toBe(true);
          }).pipe(Effect.provide(makePersistenceLive({ dataDirectory: directory }))),
        ),
      );
    } catch {
      // Scope release may also fail — that's expected
    }

    // Verify outside the scope too
    expect(remoteStopCalled).toBe(true);
  });

  it("stops HTTP acceptance before closing runtimes during an acquisition race", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-server-"));
    directories.push(directory);
    const runtime = new ProviderRuntimeRegistry();
    const events: Array<string> = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* runtime.acquireRuntime("80000000-0000-4000-8000-000000000099" as never, {
            idleMs: 30_000,
            start: async () => ({
              value: "runtime",
              close: async () => {
                events.push("runtime-close");
              },
            }),
          });
          yield* startOctantServer({
            hostname: "127.0.0.1",
            port: 0,
            providerRuntimeRegistry: runtime,
            serve: () => ({
              url: new URL("http://127.0.0.1:13773"),
              stop: (closeActiveConnections) => {
                expect(closeActiveConnections).toBe(true);
                events.push("http-stop");
              },
            }),
          });
        }).pipe(Effect.provide(makePersistenceLive({ dataDirectory: directory }))),
      ),
    );
    expect(events).toEqual(["http-stop", "runtime-close"]);
  });

  it("releases active Git observations after stopping HTTP acceptance", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-server-"));
    directories.push(directory);
    const events: Array<string> = [];
    const gitEnvironmentPort = {
      observe: vi.fn(),
      close: vi.fn(async () => {
        events.push("git-close");
      }),
    };

    await Effect.runPromise(
      Effect.scoped(
        startOctantServer({
          hostname: "127.0.0.1",
          port: 0,
          gitEnvironmentPort,
          serve: () => ({
            url: new URL("http://127.0.0.1:13773"),
            stop: () => {
              events.push("http-stop");
            },
          }),
        }).pipe(Effect.provide(makePersistenceLive({ dataDirectory: directory }))),
      ),
    );

    expect(gitEnvironmentPort.close).toHaveBeenCalledOnce();
    expect(events).toEqual(["http-stop", "git-close"]);
  });

  it("does not wait for active HTTP shutdown before aborting Git observations", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-server-"));
    directories.push(directory);
    let finishHttpStop!: () => void;
    const stop = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishHttpStop = resolve;
        }),
    );
    const close = vi.fn(async () => undefined);
    let listening = false;

    const completion = Effect.runPromise(
      Effect.scoped(
        startOctantServer({
          hostname: "127.0.0.1",
          port: 0,
          gitEnvironmentPort: { observe: vi.fn(), close },
          serve: () => {
            listening = true;
            return { url: new URL("http://127.0.0.1:13773"), stop };
          },
        }).pipe(Effect.provide(makePersistenceLive({ dataDirectory: directory }))),
      ),
    );
    await vi.waitFor(() => expect(listening).toBe(true), { timeout: 10_000 });
    await vi.waitFor(() => expect(stop).toHaveBeenCalledWith(true));
    const closeCallsBeforeHttpSettled = close.mock.calls.length;
    finishHttpStop();
    await completion;

    expect(closeCallsBeforeHttpSettled).toBe(1);
  });

  it("attempts both shutdown paths when either cleanup rejects", async () => {
    for (const failing of ["http", "runtime"] as const) {
      const directory = mkdtempSync(join(tmpdir(), "octant-server-"));
      directories.push(directory);
      const runtime = new ProviderRuntimeRegistry();
      const closeAll = vi.spyOn(runtime, "closeAll").mockImplementation(async () => {
        if (failing === "runtime") throw new Error("runtime cleanup failed");
      });
      const stop = vi.fn(async () => {
        if (failing === "http") throw new Error("HTTP stop failed");
      });
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          startOctantServer({
            hostname: "127.0.0.1",
            port: 0,
            providerRuntimeRegistry: runtime,
            serve: () => ({ url: new URL("http://127.0.0.1:13773"), stop }),
          }).pipe(Effect.provide(makePersistenceLive({ dataDirectory: directory }))),
        ),
      );
      expect(exit._tag).toBe("Failure");
      expect(stop).toHaveBeenCalledWith(true);
      expect(closeAll).toHaveBeenCalledOnce();
    }
  });

  it("closes the process-lifetime Claude resume identity store on shutdown", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-server-"));
    directories.push(directory);
    const store = new ClaudeResumeIdentityStore();
    const close = vi.spyOn(store, "close");

    await Effect.runPromise(
      Effect.scoped(
        startOctantServer({
          hostname: "127.0.0.1",
          port: 0,
          claudeResumeIdentityStore: store,
          serve: () => ({
            url: new URL("http://127.0.0.1:13773"),
            stop: () => undefined,
          }),
        }).pipe(Effect.provide(makePersistenceLive({ dataDirectory: directory }))),
      ),
    );

    expect(close).toHaveBeenCalledOnce();
    await expect(
      store.lookup(
        {
          providerInstanceId: "80000000-0000-4000-8000-000000000499" as never,
          sdkSessionId: "closed",
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ name: "ClaudeResumeIdentityStoreClosed" });
  });

  it("wires process-private binding routes and keeps them unavailable without a secret", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-server-"));
    directories.push(directory);
    let routeHandler: ((request: Request) => Response | Promise<Response>) | undefined;

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* startOctantServer({
            hostname: "127.0.0.1",
            port: 0,
            serve: (options) => {
              routeHandler = options.fetch;
              return { url: new URL("http://127.0.0.1:13773"), stop: () => undefined };
            },
          });
          const response = yield* Effect.promise(() =>
            Promise.resolve(
              routeHandler?.(
                new Request("http://127.0.0.1:13773/api/desktop/window-authorities", {
                  method: "POST",
                  body: "{}",
                }),
              ),
            ).then(assertResponse),
          );
          expect(response.status).toBe(503);
        }).pipe(Effect.provide(makePersistenceLive({ dataDirectory: directory }))),
      ),
    );
  });

  it("registers the authenticated Context RPC boundary", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-server-"));
    directories.push(directory);
    let routeHandler: ((request: Request) => Response | Promise<Response>) | undefined;

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* startOctantServer({
            hostname: "127.0.0.1",
            port: 0,
            desktopBridgeSecret: "desktop-secret",
            serve: (options) => {
              routeHandler = options.fetch;
              return { url: new URL("http://127.0.0.1:13773"), stop: () => undefined };
            },
          });
          const capability = "A".repeat(43);
          const windowId = "00000000-0000-4000-8000-000000000470";
          yield* Effect.promise(() =>
            Promise.resolve(
              routeHandler?.(
                new Request("http://127.0.0.1:13773/api/desktop/window-authorities", {
                  method: "POST",
                  headers: { "x-octant-desktop-secret": "desktop-secret" },
                  body: JSON.stringify({ windowId, capability }),
                }),
              ),
            ),
          );
          const response = yield* Effect.promise(() =>
            Promise.resolve(
              routeHandler?.(
                new Request("http://127.0.0.1:13773/api/context/inspect", {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    "x-octant-window-capability": capability,
                  },
                  body: JSON.stringify({
                    subject: {
                      aggregateType: "project",
                      aggregateId: "00000000-0000-4000-8000-000000000471",
                    },
                  }),
                }),
              ),
            ).then(assertResponse),
          );
          // The boundary is registered and authenticated; this subject simply
          // has no plan, which is an empty answer rather than a failed service.
          expect(response.status).toBe(404);
          const body = yield* Effect.promise(() => response.json());
          expect(body).toEqual({
            category: "not-planned",
            message: "This thread has no context plan yet.",
          });
        }).pipe(Effect.provide(makePersistenceLive({ dataDirectory: directory }))),
      ),
    );
  });

  it("wires Claude runtime ports into authenticated provider routes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-server-"));
    directories.push(directory);
    let routeHandler: ((request: Request) => Response | Promise<Response>) | undefined;
    const probeVersion = vi.fn(() =>
      Effect.fail({ category: "unavailable" as const, message: "Claude process selected." }),
    );
    const resumeStore = new ClaudeResumeIdentityStore();

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* startOctantServer({
            hostname: "127.0.0.1",
            port: 0,
            desktopBridgeSecret: "desktop-secret",
            claudeProcess: { probeVersion } as unknown as ClaudeProcessPort,
            claudeSdk: {} as ClaudeAgentSdkPort,
            claudeResumeIdentityStore: resumeStore,
            isProjectConfinedPath: () => false,
            serve: (options) => {
              routeHandler = options.fetch;
              return { url: new URL("http://127.0.0.1:13773"), stop: () => undefined };
            },
          });
          const capability = "A".repeat(43);
          const windowId = "00000000-0000-4000-8000-000000000461";
          yield* Effect.promise(() =>
            Promise.resolve(
              routeHandler?.(
                new Request("http://127.0.0.1:13773/api/desktop/window-authorities", {
                  method: "POST",
                  headers: { "x-octant-desktop-secret": "desktop-secret" },
                  body: JSON.stringify({ windowId, capability }),
                }),
              ),
            ),
          );
          const instanceId = "00000000-0000-4000-8000-000000000462";
          const create = yield* Effect.promise(() =>
            Promise.resolve(
              routeHandler?.(
                new Request("http://127.0.0.1:13773/api/providers/commands", {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    "x-octant-window-capability": capability,
                  },
                  body: JSON.stringify({
                    kind: "create-claude-provider",
                    instanceId,
                    expectedVersion: 0,
                    displayName: "Claude local",
                    configuration: {
                      kind: "claude-agent-sdk",
                      binaryPath: "/missing/claude",
                      authentication: "subscription",
                    },
                  }),
                }),
              ),
            ).then(assertResponse),
          );
          expect(create.status).toBe(200);
          const probe = yield* Effect.promise(() =>
            Promise.resolve(
              routeHandler?.(
                new Request(`http://127.0.0.1:13773/api/providers/${instanceId}/probe`, {
                  method: "POST",
                  headers: { "x-octant-window-capability": capability },
                }),
              ),
            ).then(assertResponse),
          );
          expect(probe.status).toBe(503);
          yield* Effect.promise(() =>
            resumeStore.put(
              {
                providerInstanceId: instanceId as never,
                octantSessionId: "00000000-0000-4000-8000-000000000463" as never,
                sdkSessionId: "sdk-session",
                projectRoot: "/tmp/project",
                modelId: "claude-sonnet" as never,
                authentication: "subscription",
              },
              new AbortController().signal,
            ),
          );
          const remove = yield* Effect.promise(() =>
            Promise.resolve(
              routeHandler?.(
                new Request("http://127.0.0.1:13773/api/providers/commands", {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    "x-octant-window-capability": capability,
                  },
                  body: JSON.stringify({
                    kind: "remove-provider",
                    instanceId,
                    expectedVersion: 1,
                  }),
                }),
              ),
            ).then(assertResponse),
          );
          expect(remove.status).toBe(200);
          yield* Effect.promise(async () => {
            await expect(
              resumeStore.lookup(
                { providerInstanceId: instanceId as never, sdkSessionId: "sdk-session" },
                new AbortController().signal,
              ),
            ).resolves.toBeUndefined();
          });
        }).pipe(Effect.provide(makePersistenceLive({ dataDirectory: directory }))),
      ),
    );
    expect(probeVersion).toHaveBeenCalledOnce();
  });

  it("wires the authenticated Project API through the shared window authority", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-server-"));
    directories.push(directory);
    let routeHandler: ((request: Request) => Response | Promise<Response>) | undefined;
    const codexStart = vi.fn(() =>
      Effect.fail({ category: "unavailable" as const, message: "Codex process selected." }),
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* startOctantServer({
            hostname: "127.0.0.1",
            port: 0,
            desktopBridgeSecret: "desktop-secret",
            codexProcess: { start: codexStart },
            serve: (options) => {
              routeHandler = options.fetch;
              return { url: new URL("http://127.0.0.1:13773"), stop: () => undefined };
            },
          });
          const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
          const windowId = "00000000-0000-4000-8000-000000000451";
          const register = yield* Effect.promise(() =>
            Promise.resolve(
              routeHandler?.(
                new Request("http://127.0.0.1:13773/api/desktop/window-authorities", {
                  method: "POST",
                  headers: { "x-octant-desktop-secret": "desktop-secret" },
                  body: JSON.stringify({ windowId, capability }),
                }),
              ),
            ).then(assertResponse),
          );
          expect(register.status).toBe(204);
          const bootstrap = yield* Effect.promise(() =>
            Promise.resolve(
              routeHandler?.(
                new Request("http://127.0.0.1:13773/api/projects/bootstrap", {
                  headers: { "x-octant-window-capability": capability },
                }),
              ),
            ).then(assertResponse),
          );
          expect(bootstrap.status).toBe(200);
          expect(yield* Effect.promise(() => bootstrap.json())).toEqual({
            active: [],
            archived: [],
            availability: [],
            memory: [],
          });
          const providers = yield* Effect.promise(() =>
            Promise.resolve(
              routeHandler?.(
                new Request("http://127.0.0.1:13773/api/providers/bootstrap", {
                  headers: { "x-octant-window-capability": capability },
                }),
              ),
            ).then(assertResponse),
          );
          expect(providers.status).toBe(200);
          expect(yield* Effect.promise(() => providers.json())).toEqual({
            instances: [],
            defaults: { permissionPersistence: "current-session", version: 0 },
            observedStates: [],
          });
          const codexId = "00000000-0000-4000-8000-000000000453";
          const createCodex = yield* Effect.promise(() =>
            Promise.resolve(
              routeHandler?.(
                new Request("http://127.0.0.1:13773/api/providers/commands", {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    "x-octant-window-capability": capability,
                  },
                  body: JSON.stringify({
                    kind: "create-codex-provider",
                    instanceId: codexId,
                    expectedVersion: 0,
                    displayName: "Codex local",
                    binaryPath: "/missing/codex",
                  }),
                }),
              ),
            ).then(assertResponse),
          );
          expect(createCodex.status).toBe(200);
          expect(yield* Effect.promise(() => createCodex.json())).toMatchObject({
            kind: "provider-created",
            instance: {
              driverKind: "codex",
              configuration: { kind: "codex-cli", binaryPath: "/missing/codex" },
            },
          });
          const probeCodex = yield* Effect.promise(() =>
            Promise.resolve(
              routeHandler?.(
                new Request(`http://127.0.0.1:13773/api/providers/${codexId}/probe`, {
                  method: "POST",
                  headers: { "x-octant-window-capability": capability },
                }),
              ),
            ).then(assertResponse),
          );
          expect(probeCodex.status).toBe(503);
          // The driver's typed refusal reaches the route as itself; the generic
          // service line is only for a failure that never carried a category.
          expect(yield* Effect.promise(() => probeCodex.json())).toEqual({
            category: "unavailable",
            message: "Codex process selected.",
          });
          expect(codexStart).toHaveBeenCalledOnce();
          const created = yield* Effect.promise(() =>
            Promise.resolve(
              routeHandler?.(
                new Request("http://127.0.0.1:13773/api/projects/commands", {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    "x-octant-window-capability": capability,
                  },
                  body: JSON.stringify({
                    kind: "create-chat-project",
                    projectId: "00000000-0000-4000-8000-000000000452",
                    expectedVersion: 0,
                    name: "Research",
                    hostId: "local",
                  }),
                }),
              ),
            ).then(assertResponse),
          );
          expect(created.status).toBe(200);
          expect(yield* Effect.promise(() => created.json())).toMatchObject({
            kind: "chat-project-created",
            project: { name: "Research", type: "chat", version: 1 },
          });
        }).pipe(Effect.provide(makePersistenceLive({ dataDirectory: directory }))),
      ),
    );
  });

  it("does not bind a healthy server for an incompatible store", async () => {
    let serveCalls = 0;

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        startOctantServer({
          hostname: "127.0.0.1",
          port: 0,
          acquirePersistence: Effect.fail(
            new PersistenceStartupFailed({
              category: "migration-incompatible",
              message: "Octant cannot use this database migration state.",
            }),
          ),
          serve: (options) => {
            serveCalls += 1;
            return Bun.serve(options as unknown as Parameters<typeof Bun.serve>[0]);
          },
        }),
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(serveCalls).toBe(0);
  });

  it("offers Work and Code threads to the cross-mode thread-mention picker", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-server-thread-mentions-"));
    directories.push(directory);
    let routeHandler: ((request: Request) => Response | Promise<Response>) | undefined;
    const now = "2026-08-15T09:00:00.000Z";
    const codeThread = decodeCodeThread({
      id: "00000000-0000-4000-8000-000000001501",
      projectId: "00000000-0000-4000-8000-000000001502",
      bindingRevisionId: "00000000-0000-4000-8000-000000001503",
      repositoryId: `repo_${"b".repeat(64)}`,
      checkoutId: "00000000-0000-4000-8000-000000001504",
      title: "Code mention target",
      lifecycle: "active",
      providerInstanceId: "00000000-0000-4000-8000-000000001505",
      modelId: "model-a",
      executionPolicy: "approval-gated",
      permissionPersistence: "current-session",
      deliveryTarget: {
        branchIntent: "feature/mentions",
        remoteName: "origin",
        proposedBaseRepository: "octant/octant",
        proposedBaseBranch: "development",
        outcomeKind: "opened-pr",
        confirmedAt: now,
      },
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const workBootstrap = vi.spyOn(WorkThreadService.prototype, "bootstrap").mockResolvedValue(
      decodeWorkThreadBootstrap({
        threads: [
          {
            id: "00000000-0000-4000-8000-000000001511",
            projectId: "00000000-0000-4000-8000-000000001512",
            title: "Work mention target",
            lifecycle: "active",
            providerInstanceId: "00000000-0000-4000-8000-000000001513",
            modelId: "model-a",
            version: 1,
            createdAt: now,
            updatedAt: now,
          },
        ],
      }),
    );
    const codeBootstrap = vi.fn(async () =>
      decodeCodeBootstrap({
        settings: {
          defaultExecutionPolicy: "approval-gated",
          defaultPermissionPersistence: "current-session",
          version: 0,
          updatedAt: now,
        },
        threads: [codeThread],
        checkouts: [],
        activity: [],
      }),
    );

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* startOctantServer({
              hostname: "127.0.0.1",
              port: 0,
              desktopBridgeSecret: "desktop-secret",
              codeService: {
                bootstrap: codeBootstrap,
                navigation: vi.fn(async () => ({ threads: [], activity: [], runtime: [] })),
                read: vi.fn(),
                execute: vi.fn(),
                subscribe: vi.fn(async function* () {}),
                readContent: vi.fn(),
                saveFile: vi.fn(),
                openFile: vi.fn(),
              },
              serve: (options) => {
                routeHandler = options.fetch;
                return { url: new URL("http://127.0.0.1:13773"), stop: () => undefined };
              },
            });

            const capability = "A".repeat(43);
            const windowId = "00000000-0000-4000-8000-000000001500";
            yield* Effect.promise(() =>
              Promise.resolve(
                routeHandler?.(
                  new Request("http://127.0.0.1:13773/api/desktop/window-authorities", {
                    method: "POST",
                    headers: { "x-octant-desktop-secret": "desktop-secret" },
                    body: JSON.stringify({ windowId, capability }),
                  }),
                ),
              ),
            );

            const searched = yield* Effect.promise(() =>
              Promise.resolve(
                routeHandler?.(
                  new Request("http://127.0.0.1:13773/api/thread-mentions/commands", {
                    method: "POST",
                    headers: {
                      "content-type": "application/json",
                      "x-octant-window-capability": capability,
                    },
                    body: JSON.stringify({
                      kind: "search-mentions",
                      requestId: "00000000-0000-4000-8000-000000001520",
                      query: "mention target",
                    }),
                  }),
                ),
              ).then(assertResponse),
            );

            expect(searched.status).toBe(200);
            const body = (yield* Effect.promise(() => searched.json())) as {
              readonly candidates: ReadonlyArray<{ readonly mode: string }>;
            };
            // §2/§8: a `#` search from a Chat composer resolves every mode the
            // principal can already Open, not Chat alone.
            expect(body.candidates.map((candidate) => candidate.mode).sort()).toEqual([
              "code",
              "work",
            ]);
            // Both listings are the mode's own authorized bootstrap for this
            // exact window, never a raw projection read.
            expect(workBootstrap).toHaveBeenCalledWith(windowId);
            expect(codeBootstrap).toHaveBeenCalledWith(windowId);
          }).pipe(Effect.provide(makePersistenceLive({ dataDirectory: directory }))),
        ),
      );
    } finally {
      workBootstrap.mockRestore();
    }
  });

  it("redacts fatal startup details to an actionable category", () => {
    const output = fatalStartupOutput(
      new PersistenceStartupFailed({
        category: "storage-unavailable",
        message: "Octant storage is unavailable.",
      }),
    );

    expect(output).toBe(
      '{"product":"Octant","status":"failed","category":"storage-unavailable","message":"Octant storage is unavailable."}',
    );
    expect(output).not.toContain("sqlite");
  });
});

describe("admittedParentChatContext", () => {
  /** One attempt that ended with `outcome` after emitting `contentId`. */
  const attempt = (outcome: string, contentId: string) => ({
    outcome,
    responseRefs: [{ contentId }],
    updatedAt: "2026-08-15T10:00:01.000Z",
  });

  const view = (input: {
    readonly turns: ReadonlyArray<unknown>;
    readonly contents: ReadonlyArray<{ readonly contentId: string; readonly body: string }>;
  }) => input as unknown as Parameters<typeof admittedParentChatContext>[0];

  it("admits the prompt but not the partial text of a parent attempt that failed", () => {
    // A child briefed with an abandoned fragment answers from text the parent
    // never accepted as its answer; the question it was created from stands.
    const blocks = admittedParentChatContext(
      view({
        turns: [
          {
            id: "turn-1",
            userMessageRef: { contentId: "c1" },
            createdAt: "2026-08-15T10:00:00.000Z",
            attempts: [attempt("failed", "c2")],
          },
        ],
        contents: [
          { contentId: "c1", body: "Which service paged first?" },
          { contentId: "c2", body: "The service that paged" },
        ],
      }),
    );

    expect(blocks).toEqual([{ kind: "user-message", text: "Which service paged first?" }]);
  });

  it("admits only the answer a retry produced, not the abandoned attempt before it", () => {
    const blocks = admittedParentChatContext(
      view({
        turns: [
          {
            id: "turn-1",
            userMessageRef: { contentId: "c1" },
            createdAt: "2026-08-15T10:00:00.000Z",
            attempts: [attempt("failed", "c2"), attempt("completed", "c3")],
          },
        ],
        contents: [
          { contentId: "c1", body: "Which service paged first?" },
          { contentId: "c2", body: "The service that paged" },
          { contentId: "c3", body: "Billing paged first." },
        ],
      }),
    );

    expect(blocks).toEqual([
      { kind: "user-message", text: "Which service paged first?" },
      { kind: "assistant-message", text: "Billing paged first." },
    ]);
  });

  it("admits a completed exchange, and never the branch an edit superseded", () => {
    const blocks = admittedParentChatContext(
      view({
        turns: [
          {
            id: "turn-1",
            userMessageRef: { contentId: "c1" },
            createdAt: "2026-08-15T10:00:00.000Z",
            attempts: [attempt("completed", "c2")],
          },
          {
            id: "turn-2",
            supersedes: "turn-1",
            userMessageRef: { contentId: "c3" },
            createdAt: "2026-08-15T10:05:00.000Z",
            attempts: [attempt("completed", "c4")],
          },
        ],
        contents: [
          { contentId: "c1", body: "Ship on Friday?" },
          { contentId: "c2", body: "Friday works." },
          { contentId: "c3", body: "Ship on Monday?" },
          { contentId: "c4", body: "Monday works." },
        ],
      }),
    );

    expect(blocks).toEqual([
      { kind: "user-message", text: "Ship on Monday?" },
      { kind: "assistant-message", text: "Monday works." },
    ]);
  });

  it("spends the block budget on admitted exchanges, never on abandoned text", () => {
    // Thirteen retried turns yield twenty-six admitted blocks, two over the
    // cap, so the window lands exactly on the boundary. Were the abandoned
    // attempts admitted first and filtered after, they would occupy slots the
    // cap then spent, and the parent's real exchanges would fall out of the
    // window in their place.
    const turns = Array.from({ length: 13 }, (_, index) => ({
      id: `turn-${index + 1}`,
      userMessageRef: { contentId: `ask-${index + 1}` },
      createdAt: "2026-08-15T10:00:00.000Z",
      attempts: [
        attempt("failed", `partial-${index + 1}`),
        attempt("completed", `answer-${index + 1}`),
      ],
    }));
    const contents = turns.flatMap((_, index) => [
      { contentId: `ask-${index + 1}`, body: `ask ${index + 1}` },
      { contentId: `partial-${index + 1}`, body: `partial ${index + 1}` },
      { contentId: `answer-${index + 1}`, body: `answer ${index + 1}` },
    ]);

    const blocks = admittedParentChatContext(view({ turns, contents }));

    expect(blocks).toHaveLength(MAX_AGENT_RUN_ADMITTED_CONTEXT_BLOCKS);
    expect(blocks.every((block) => !block.text.startsWith("partial"))).toBe(true);
    expect(blocks.at(0)).toEqual({ kind: "user-message", text: "ask 2" });
    expect(blocks.at(-1)).toEqual({ kind: "assistant-message", text: "answer 13" });
  });
});

function assertResponse(response: Response | undefined): Response {
  if (response === undefined) throw new Error("route handler was not installed");
  return response;
}
