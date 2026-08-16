import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionEffectiveSnapshot } from "@octant/contracts/extension-rpc";
import { MAX_PROVIDER_TOOLS } from "@octant/contracts";
import {
  AGENT_PLUGINS_MCP_SCHEMA,
  AGENT_PLUGINS_PLUGIN_SCHEMA,
} from "@octant/plugin-host/agent-plugins";
import { loadAgentPluginDirectory, readVerifiedPluginFile } from "./agentPluginFilesystem";
import { connectAgentPluginMcpSession } from "./agentPluginMcpClient";
import { AgentPluginMcpSessionManager } from "./agentPluginMcpSessionManager";
import { LocalPluginFolderRegistry } from "./localPluginFolderRegistry";
import { CodexPluginPackageResolver } from "./codexPluginResolver";
import { inspectExtensionPackage } from "./packageInspector";
import { ExtensionSupervisor } from "./extensionSupervisor";
import { createNodeExtensionProcessPort } from "./nodeExtensionProcessPort";

async function writeAgentPlugin(
  root: string,
  options: { readonly mcpJson?: unknown } = {},
): Promise<void> {
  await mkdir(join(root, "skills", "greet"), { recursive: true });
  await mkdir(join(root, "bin"), { recursive: true });
  await writeFile(
    join(root, "plugin.json"),
    JSON.stringify({
      $schema: AGENT_PLUGINS_PLUGIN_SCHEMA,
      name: "hello-plugin",
      version: "1.0.0",
      license: "MIT",
    }),
  );
  await writeFile(
    join(root, "skills", "greet", "SKILL.md"),
    `---
name: greet
description: Greet the user and offer help.
---
Hello
`,
  );
  await writeFile(
    join(root, "mcp.json"),
    JSON.stringify(
      options.mcpJson ?? {
        $schema: AGENT_PLUGINS_MCP_SCHEMA,
        mcpServers: {
          remote: {
            type: "streamable-http",
            url: "https://example.test/mcp",
          },
        },
      },
    ),
  );
}

describe("Agent Plugins filesystem loader", () => {
  it("loads a real directory with realpath containment", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-agent-plugins-"));
    try {
      await writeAgentPlugin(root);
      const loaded = await loadAgentPluginDirectory(root);
      expect(loaded.pluginRoot).toBe(await realpath(root));
      expect(loaded.plugin.manifest.name).toBe("hello-plugin");
      expect(loaded.plugin.skills.map((skill) => skill.name)).toEqual(["greet"]);
      expect(loaded.plugin.servers.map((server) => server.name)).toEqual(["remote"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects package symlinks that escape the plugin root", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-agent-plugins-"));
    const outside = await mkdtemp(join(tmpdir(), "octant-agent-plugins-outside-"));
    try {
      await writeAgentPlugin(root);
      await writeFile(join(outside, "secret.txt"), "secret");
      await symlink(join(outside, "secret.txt"), join(root, "leak.txt"));
      await expect(loadAgentPluginDirectory(root)).rejects.toThrow(/escapes/i);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("does not follow a file swapped to a symlink after discovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-agent-plugins-"));
    const outside = await mkdtemp(join(tmpdir(), "octant-agent-plugins-outside-"));
    try {
      const packageFile = join(root, "plugin.json");
      const secretFile = join(outside, "secret.txt");
      await writeFile(packageFile, "safe");
      await writeFile(secretFile, "secret");
      const discovered = await lstat(packageFile);
      await rm(packageFile);
      await symlink(secretFile, packageFile);

      await expect(
        readVerifiedPluginFile(await realpath(root), packageFile, "plugin.json", discovered, 64),
      ).rejects.toThrow(/changed|symlink|unsafe/i);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("counts directories against the local package entry limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-agent-plugins-"));
    try {
      await writeAgentPlugin(root);
      await expect(loadAgentPluginDirectory(root, { maximumEntries: 5 })).rejects.toThrow(
        /entry count/i,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Local Agent Plugins folder registry + resolver", () => {
  it("registers a disk folder and inspects it through the package resolver", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-agent-plugins-"));
    try {
      await writeAgentPlugin(root);
      const registry = new LocalPluginFolderRegistry({ platform: "darwin" });
      const registered = await registry.register(root);
      const resolver = new CodexPluginPackageResolver({
        localFolderRegistry: registry,
        platform: "darwin",
      });
      const resolved = await resolver.resolve({
        kind: "inspect-package",
        source: registered.source,
      });
      const inspected = inspectExtensionPackage(resolved);
      expect(inspected.manifest.slug).toBe("hello-plugin");
      expect(inspected.manifest.components).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "skill-greet", kind: "skill-instructions" }),
          expect.objectContaining({ id: "mcp-remote", kind: "mcp-server" }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists registered paths and rehydrates them on initialize", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-agent-plugins-"));
    const stateDir = await mkdtemp(join(tmpdir(), "octant-agent-plugins-state-"));
    try {
      await writeAgentPlugin(root);
      const statePath = join(stateDir, "local-plugin-folders.json");
      const registry = new LocalPluginFolderRegistry({ platform: "darwin", statePath });
      const registered = await registry.register(root);
      const restored = new LocalPluginFolderRegistry({ platform: "darwin", statePath });
      await restored.initialize();
      expect(restored.get(registered.source.sourceRef)?.absolutePath).toBe(await realpath(root));
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe("Agent Plugins MCP streamable-http connection", () => {
  it("collects bounded tools/list pages", async () => {
    const cursors: Array<string | undefined> = [];
    const fetchImpl = (async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        method?: string;
        id?: number;
        params?: { cursor?: string };
      };
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "tools/list") {
        cursors.push(body.params?.cursor);
        const first = body.params?.cursor === undefined;
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [{ name: first ? "first" : "second", inputSchema: { type: "object" } }],
            ...(first ? { nextCursor: "page-2" } : {}),
          },
        });
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { ok: true } });
    }) as typeof fetch;

    const session = await connectAgentPluginMcpSession(
      { transport: "streamable-http", name: "remote", url: "https://example.test", headers: {} },
      { fetch: fetchImpl },
    );
    expect(cursors).toEqual([undefined, "page-2"]);
    expect(session.tools.map((tool) => tool.name)).toEqual(["first", "second"]);
  });

  it("rejects an oversized JSON response before parsing it", async () => {
    const fetchImpl = (async () =>
      new Response(new Uint8Array(4 * 1024 * 1024 + 1), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    await expect(
      connectAgentPluginMcpSession(
        {
          transport: "streamable-http",
          name: "remote",
          url: "https://example.test/mcp",
          headers: {},
        },
        { fetch: fetchImpl },
      ),
    ).rejects.toThrow(/message limit/i);
  });

  it("returns the matching SSE response without waiting for the stream to close", async () => {
    const encoder = new TextEncoder();
    let requestCount = 0;
    const fetchImpl = (async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; id?: number };
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      requestCount += 1;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" })}\n\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                jsonrpc: "2.0",
                id: body.id,
                result:
                  body.method === "tools/list"
                    ? { tools: [{ name: "ping", inputSchema: { type: "object" } }] }
                    : { ok: true },
              })}\n\n`,
            ),
          );
          // Deliberately remain open: Streamable HTTP may continue emitting events.
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    const session = await connectAgentPluginMcpSession(
      {
        transport: "streamable-http",
        name: "remote",
        url: "https://example.test/mcp",
        headers: {},
      },
      { fetch: fetchImpl },
    );
    expect(requestCount).toBe(2);
    expect(session.tools).toEqual([expect.objectContaining({ name: "ping" })]);
    await session.close();
  });

  it("performs initialize and tools/list over Streamable HTTP", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; id?: number };
      calls.push(body.method ?? "unknown");
      if (body.method === "initialize") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }), {
          status: 200,
          headers: { "content-type": "application/json", "mcp-session-id": "sess-1" },
        });
      }
      if (body.method === "notifications/initialized") {
        expect(body.id).toBeUndefined();
        return new Response(null, { status: 202, headers: { "mcp-session-id": "sess-1" } });
      }
      if (body.method === "tools/list") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object" } }],
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json", "mcp-session-id": "sess-1" },
          },
        );
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 9, result: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const session = await connectAgentPluginMcpSession(
      {
        transport: "streamable-http",
        name: "remote",
        url: "https://example.test/mcp",
        headers: {},
      },
      { fetch: fetchImpl },
    );
    expect(calls).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    expect(session.tools).toEqual([expect.objectContaining({ name: "ping", description: "Ping" })]);
    await session.close();
  });

  it("bounds the best-effort Streamable HTTP session deletion", async () => {
    let deleteSignal: AbortSignal | undefined;
    const fetchImpl = (async (_input, init) => {
      if (init?.method === "DELETE") {
        deleteSignal = init.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          deleteSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; id?: number };
      const result =
        body.method === "tools/list"
          ? { tools: [] }
          : body.method === "notifications/initialized"
            ? undefined
            : { ok: true };
      return result === undefined
        ? new Response(null, { status: 202, headers: { "mcp-session-id": "sess-stalled" } })
        : Response.json(
            { jsonrpc: "2.0", id: body.id, result },
            { headers: { "mcp-session-id": "sess-stalled" } },
          );
    }) as typeof fetch;
    const session = await connectAgentPluginMcpSession(
      {
        transport: "streamable-http",
        name: "remote",
        url: "https://example.test/mcp",
        headers: {},
      },
      { fetch: fetchImpl, cleanupTimeoutMs: 10 },
    );

    await expect(session.close()).resolves.toBeUndefined();
    expect(deleteSignal?.aborted).toBe(true);
  });
});

describe("Agent Plugins MCP stdio connection", () => {
  it("rejects an oversized individual JSON-RPC message and stops the process", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let stopped = false;
    const connection = connectAgentPluginMcpSession(
      {
        transport: "stdio",
        name: "local",
        command: process.execPath,
        args: [],
        env: {},
        cwd: process.cwd(),
      },
      {
        stdioProcess: {
          start: async () => ({
            stdin,
            stdout,
            stop: async () => {
              stopped = true;
            },
            once: () => undefined,
          }),
        },
      },
    );
    stdout.write("x".repeat(5 * 1024 * 1024));

    await expect(connection).rejects.toThrow(/message.*limit/i);
    expect(stopped).toBe(true);
  });

  it("spawns a stdio MCP server and completes the handshake", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-agent-plugins-stdio-"));
    try {
      const serverPath = join(root, "mcp-server.mjs");
      await writeFile(
        serverPath,
        `#!/usr/bin/env node
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true } }) + "\\n");
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "tools/list") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }] },
    }) + "\\n");
    return;
  }
  if (message.method === "tools/call") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: { content: [{ type: "text", text: JSON.stringify(message.params) }] },
    }) + "\\n");
  }
});
`,
      );
      await chmod(serverPath, 0o755);
      const supervisor = new ExtensionSupervisor({
        process: createNodeExtensionProcessPort({ shutdownTimeoutMs: 100 }),
        clock: () => new Date().toISOString(),
        authorizeLaunch: async () => true,
      });
      const launch = {
        transport: "stdio" as const,
        name: "local",
        command: process.execPath,
        args: [serverPath],
        env: {},
        cwd: root,
      };
      const session = await connectAgentPluginMcpSession(launch, {
        stdioProcess: {
          start: async (_launch, signal) => {
            const started = await supervisor.startInteractive(
              {
                extensionId: "15000000-0000-4000-8000-000000000001",
                packageId: "15000000-0000-4000-8000-000000000002",
                componentId: "mcp-local",
                version: "1.0.0",
                digest: `sha256:${"c".repeat(64)}`,
                entryPoint: serverPath,
                command: launch.command,
                args: launch.args,
                cwd: launch.cwd,
                env: launch.env,
                effective: true,
                approved: true,
                authority: {
                  kind: "trusted-extension",
                  extensionId: "15000000-0000-4000-8000-000000000001",
                },
              },
              signal,
            );
            if (started.process.stdin === undefined || started.process.stdout === undefined) {
              throw new Error("Expected supervised stdio.");
            }
            return {
              stdin: started.process.stdin,
              stdout: started.process.stdout,
              stop: started.process.stop,
              once: (_event, listener) => started.process.once("exit", () => listener()),
            };
          },
        },
      });
      expect(session.tools).toEqual([expect.objectContaining({ name: "echo" })]);
      const result = await session.callTool("echo", { hello: "world" });
      expect(result).toEqual({
        content: [
          { type: "text", text: JSON.stringify({ name: "echo", arguments: { hello: "world" } }) },
        ],
      });
      await session.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Agent Plugin MCP session manager", () => {
  it("preserves oversized MCP catalogues for the downstream fail-closed capacity check", async () => {
    const manager = new AgentPluginMcpSessionManager({
      store: {
        contentRoot: () => "/tmp/plugin",
        pluginDataRoot: () => "/tmp/plugin-data",
        readVerifiedConfiguration: async () =>
          JSON.stringify({
            $schema: AGENT_PLUGINS_MCP_SCHEMA,
            mcpServers: { local: { type: "stdio", command: "./server" } },
          }),
      },
      stdioSupervisor: {
        startInteractive: async () => {
          const stdin = new PassThrough();
          const stdout = new PassThrough();
          let pending = "";
          stdin.setEncoding("utf8");
          stdin.on("data", (chunk) => {
            pending += String(chunk);
            for (
              let newline = pending.indexOf("\n");
              newline >= 0;
              newline = pending.indexOf("\n")
            ) {
              const line = pending.slice(0, newline);
              pending = pending.slice(newline + 1);
              const message = JSON.parse(line) as { id?: number; method?: string };
              if (message.id === undefined) continue;
              stdout.write(
                `${JSON.stringify({
                  jsonrpc: "2.0",
                  id: message.id,
                  result:
                    message.method === "tools/list"
                      ? {
                          tools: Array.from({ length: MAX_PROVIDER_TOOLS + 4 }, (_, index) => ({
                            name: `tool-${index}`,
                            description: `Tool ${index} description`,
                            inputSchema: { type: "object" },
                          })),
                        }
                      : { ok: true },
                })}\n`,
              );
            }
          });
          return {
            receipt: { state: "ready" },
            process: {
              pid: 9001,
              ready: Promise.resolve(),
              wait: new Promise(() => undefined),
              stop: async () => undefined,
              cancel: async () => undefined,
              stdin,
              stdout,
              once: () => undefined,
            },
          } as never;
        },
      },
    });

    const effective = effectiveMcpSnapshot("mcp-local", "local");
    await manager.reconcile(effective);

    const definitions = manager.toolDefinitionsFor(
      "15000000-0000-4000-8000-000000000002",
      "mcp-local",
      effective.scope,
    );
    expect(definitions).toHaveLength(MAX_PROVIDER_TOOLS + 4);
    expect(definitions[0]).toMatchObject({ description: "Tool 0 description" });
    await manager.drainAll();
  });

  it("omits MCP tools whose nested input schema exceeds provider bounds", async () => {
    const manager = new AgentPluginMcpSessionManager({
      store: {
        contentRoot: () => "/tmp/plugin",
        pluginDataRoot: () => "/tmp/plugin-data",
        readVerifiedConfiguration: async () =>
          JSON.stringify({
            $schema: AGENT_PLUGINS_MCP_SCHEMA,
            mcpServers: { local: { type: "stdio", command: "./server" } },
          }),
      },
      stdioSupervisor: {
        startInteractive: async () => {
          const stdin = new PassThrough();
          const stdout = new PassThrough();
          let pending = "";
          stdin.setEncoding("utf8");
          stdin.on("data", (chunk) => {
            pending += String(chunk);
            for (
              let newline = pending.indexOf("\n");
              newline >= 0;
              newline = pending.indexOf("\n")
            ) {
              const line = pending.slice(0, newline);
              pending = pending.slice(newline + 1);
              const message = JSON.parse(line) as { id?: number; method?: string };
              if (message.id === undefined) continue;
              stdout.write(
                `${JSON.stringify({
                  jsonrpc: "2.0",
                  id: message.id,
                  result:
                    message.method === "tools/list"
                      ? {
                          tools: [
                            {
                              name: "invalid",
                              inputSchema: { values: Array.from({ length: 257 }, () => null) },
                            },
                          ],
                        }
                      : { ok: true },
                })}\n`,
              );
            }
          });
          return {
            receipt: { state: "ready" },
            process: {
              pid: 9002,
              ready: Promise.resolve(),
              wait: new Promise(() => undefined),
              stop: async () => undefined,
              cancel: async () => undefined,
              stdin,
              stdout,
              once: () => undefined,
            },
          } as never;
        },
      },
    });

    await manager.reconcile(effectiveMcpSnapshot("mcp-local", "local"));

    expect(manager.toolDefinitions()).toEqual([]);
    await manager.drainAll();
  });

  it("isolates MCP sessions and tool identities by activation authority scope", async () => {
    let starts = 0;
    const manager = new AgentPluginMcpSessionManager({
      store: {
        contentRoot: () => "/tmp/plugin",
        pluginDataRoot: () => "/tmp/plugin-data",
        readVerifiedConfiguration: async () =>
          JSON.stringify({
            $schema: AGENT_PLUGINS_MCP_SCHEMA,
            mcpServers: { local: { type: "stdio", command: "./server" } },
          }),
      },
      stdioSupervisor: {
        startInteractive: async () => {
          starts += 1;
          const stdin = new PassThrough();
          const stdout = new PassThrough();
          let pending = "";
          stdin.setEncoding("utf8");
          stdin.on("data", (chunk) => {
            pending += String(chunk);
            for (
              let newline = pending.indexOf("\n");
              newline >= 0;
              newline = pending.indexOf("\n")
            ) {
              const line = pending.slice(0, newline);
              pending = pending.slice(newline + 1);
              const message = JSON.parse(line) as { id?: number; method?: string };
              if (message.id === undefined) continue;
              stdout.write(
                `${JSON.stringify({
                  jsonrpc: "2.0",
                  id: message.id,
                  result:
                    message.method === "tools/list"
                      ? { tools: [{ name: "echo", inputSchema: { type: "object" } }] }
                      : { ok: true },
                })}\n`,
              );
            }
          });
          return {
            receipt: { state: "ready" },
            process: {
              pid: 9050 + starts,
              ready: Promise.resolve(),
              wait: new Promise(() => undefined),
              stop: async () => undefined,
              cancel: async () => undefined,
              stdin,
              stdout,
              once: () => undefined,
            },
          } as never;
        },
      },
    });
    const first = effectiveMcpSnapshot("mcp-local", "local", {
      projectId: "16000000-0000-4000-8000-000000000001" as never,
      threadId: "17000000-0000-4000-8000-000000000001" as never,
    });
    const second = effectiveMcpSnapshot("mcp-local", "local", {
      projectId: "16000000-0000-4000-8000-000000000002" as never,
      threadId: "17000000-0000-4000-8000-000000000002" as never,
    });

    await manager.reconcile(first);
    await manager.reconcile(second);

    expect(starts).toBe(2);
    expect(manager.sessions()).toHaveLength(2);
    const firstTools = manager.toolDefinitionsFor(
      "15000000-0000-4000-8000-000000000002",
      "mcp-local",
      first.scope,
    );
    const secondTools = manager.toolDefinitionsFor(
      "15000000-0000-4000-8000-000000000002",
      "mcp-local",
      second.scope,
    );
    expect(firstTools).toHaveLength(1);
    expect(secondTools).toHaveLength(1);
    expect(firstTools[0]?.name).not.toBe(secondTools[0]?.name);

    await manager.reconcile({ ...first, packages: [] });
    expect(manager.sessions()).toHaveLength(1);
    expect(manager.sessions()[0]?.scope.threadId).toBe(second.scope.threadId);
    await manager.drainAll();
  });

  it("reconnects an exited stdio session only after authority reconciliation", async () => {
    const exitListeners: Array<() => void> = [];
    let starts = 0;
    let releaseReconnect!: () => void;
    let markReconnectStarted!: () => void;
    const reconnectGate = new Promise<void>((resolve) => {
      releaseReconnect = resolve;
    });
    const reconnectStarted = new Promise<void>((resolve) => {
      markReconnectStarted = resolve;
    });
    const manager = new AgentPluginMcpSessionManager({
      store: {
        contentRoot: () => "/tmp/plugin",
        pluginDataRoot: () => "/tmp/plugin-data",
        readVerifiedConfiguration: async () =>
          JSON.stringify({
            $schema: AGENT_PLUGINS_MCP_SCHEMA,
            mcpServers: { local: { type: "stdio", command: "./server" } },
          }),
      },
      stdioSupervisor: {
        startInteractive: async () => {
          starts += 1;
          if (starts === 2) {
            markReconnectStarted();
            await reconnectGate;
          }
          const stdin = new PassThrough();
          const stdout = new PassThrough();
          let pending = "";
          stdin.setEncoding("utf8");
          stdin.on("data", (chunk) => {
            pending += String(chunk);
            for (
              let newline = pending.indexOf("\n");
              newline >= 0;
              newline = pending.indexOf("\n")
            ) {
              const line = pending.slice(0, newline);
              pending = pending.slice(newline + 1);
              const message = JSON.parse(line) as { id?: number; method?: string };
              if (message.id === undefined) continue;
              stdout.write(
                `${JSON.stringify({
                  jsonrpc: "2.0",
                  id: message.id,
                  result: message.method === "tools/list" ? { tools: [] } : { ok: true },
                })}\n`,
              );
            }
          });
          return {
            receipt: { state: "ready" },
            process: {
              pid: 1000 + starts,
              ready: Promise.resolve(),
              wait: new Promise(() => undefined),
              stop: async () => undefined,
              cancel: async () => undefined,
              stdin,
              stdout,
              once: (_event: "exit", listener: () => void) => exitListeners.push(listener),
            },
          } as never;
        },
      },
    });

    const effective = effectiveMcpSnapshot("mcp-local", "local");
    await manager.reconcile(effective);
    expect(starts).toBe(1);
    expect(manager.sessions()).toHaveLength(1);

    exitListeners[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(starts).toBe(1);
    expect(manager.sessions()).toHaveLength(0);

    const foreground = manager.reconcile(effective);
    await reconnectStarted;
    const startsBeforeRelease = starts;
    releaseReconnect();
    await foreground;

    expect(startsBeforeRelease).toBe(2);
    expect(manager.sessions()).toHaveLength(1);
    await manager.drainAll();
  });

  it("projects an established MCP component unavailable when reconciliation cannot reconnect", async () => {
    const exitListeners: Array<() => void> = [];
    let starts = 0;
    const manager = new AgentPluginMcpSessionManager({
      store: {
        contentRoot: () => "/tmp/plugin",
        pluginDataRoot: () => "/tmp/plugin-data",
        readVerifiedConfiguration: async () =>
          JSON.stringify({
            $schema: AGENT_PLUGINS_MCP_SCHEMA,
            mcpServers: { local: { type: "stdio", command: "./server" } },
          }),
      },
      stdioSupervisor: {
        startInteractive: async () => {
          starts += 1;
          if (starts > 1) throw new Error("reconnect unavailable");
          const stdin = new PassThrough();
          const stdout = new PassThrough();
          let pending = "";
          stdin.setEncoding("utf8");
          stdin.on("data", (chunk) => {
            pending += String(chunk);
            for (
              let newline = pending.indexOf("\n");
              newline >= 0;
              newline = pending.indexOf("\n")
            ) {
              const line = pending.slice(0, newline);
              pending = pending.slice(newline + 1);
              const message = JSON.parse(line) as { id?: number; method?: string };
              if (message.id === undefined) continue;
              stdout.write(
                `${JSON.stringify({
                  jsonrpc: "2.0",
                  id: message.id,
                  result: message.method === "tools/list" ? { tools: [] } : { ok: true },
                })}\n`,
              );
            }
          });
          return {
            receipt: { state: "ready" },
            process: {
              pid: 2000,
              ready: Promise.resolve(),
              wait: new Promise(() => undefined),
              stop: async () => undefined,
              cancel: async () => undefined,
              stdin,
              stdout,
              once: (_event: "exit", listener: () => void) => exitListeners.push(listener),
            },
          } as never;
        },
      },
    });
    const effective = effectiveMcpSnapshot("mcp-local", "local");

    await manager.reconcile(effective);
    exitListeners[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(starts).toBe(1);
    expect(manager.sessions()).toHaveLength(0);

    await manager.reconcile(effective);

    expect(starts).toBe(2);
    expect(manager.sessions()).toHaveLength(0);
    expect(manager.failedComponents()).toEqual([
      expect.objectContaining({
        componentId: "mcp-local",
        reason: "reconnect unavailable",
      }),
    ]);
    expect(
      manager.projectEffectiveState(effective).packages[0]?.components[0]?.effectiveState,
    ).toEqual({ kind: "blocked", reason: "unavailable" });
    await manager.drainAll();
  });

  it("reconnects a protocol-limited stdio session only on reconciliation", async () => {
    const stdouts: PassThrough[] = [];
    let starts = 0;
    const manager = new AgentPluginMcpSessionManager({
      store: {
        contentRoot: () => "/tmp/plugin",
        pluginDataRoot: () => "/tmp/plugin-data",
        readVerifiedConfiguration: async () =>
          JSON.stringify({
            $schema: AGENT_PLUGINS_MCP_SCHEMA,
            mcpServers: { local: { type: "stdio", command: "./server" } },
          }),
      },
      stdioSupervisor: {
        startInteractive: async () => {
          starts += 1;
          const stdin = new PassThrough();
          const stdout = new PassThrough();
          stdouts.push(stdout);
          let pending = "";
          stdin.setEncoding("utf8");
          stdin.on("data", (chunk) => {
            pending += String(chunk);
            for (
              let newline = pending.indexOf("\n");
              newline >= 0;
              newline = pending.indexOf("\n")
            ) {
              const line = pending.slice(0, newline);
              pending = pending.slice(newline + 1);
              const message = JSON.parse(line) as { id?: number; method?: string };
              if (message.id === undefined) continue;
              stdout.write(
                `${JSON.stringify({
                  jsonrpc: "2.0",
                  id: message.id,
                  result: message.method === "tools/list" ? { tools: [] } : { ok: true },
                })}\n`,
              );
            }
          });
          return {
            receipt: { state: "ready" },
            process: {
              pid: 9100 + starts,
              ready: Promise.resolve(),
              wait: new Promise(() => undefined),
              stop: async () => undefined,
              cancel: async () => undefined,
              stdin,
              stdout,
              once: () => undefined,
            },
          } as never;
        },
      },
    });

    const effective = effectiveMcpSnapshot("mcp-local", "local");
    await manager.reconcile(effective);
    stdouts[0]!.write("x".repeat(4 * 1024 * 1024 + 1));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(starts).toBe(1);
    expect(manager.sessions()).toHaveLength(0);

    await manager.reconcile(effective);
    expect(starts).toBe(2);
    expect(manager.sessions()).toHaveLength(1);
    await manager.drainAll();
  });

  it("keeps unrelated sessions while reconciling lifecycle mutations", async () => {
    const manager = new AgentPluginMcpSessionManager({
      store: {
        contentRoot: () => "/tmp/plugin",
        pluginDataRoot: () => "/tmp/plugin-data",
        readVerifiedConfiguration: async () =>
          JSON.stringify({
            $schema: AGENT_PLUGINS_MCP_SCHEMA,
            mcpServers: { local: { type: "stdio", command: "./server" } },
          }),
      },
      stdioSupervisor: {
        startInteractive: async () => {
          const stdin = new PassThrough();
          const stdout = new PassThrough();
          let pending = "";
          stdin.setEncoding("utf8");
          stdin.on("data", (chunk) => {
            pending += String(chunk);
            for (
              let newline = pending.indexOf("\n");
              newline >= 0;
              newline = pending.indexOf("\n")
            ) {
              const line = pending.slice(0, newline);
              pending = pending.slice(newline + 1);
              const message = JSON.parse(line) as { id?: number; method?: string };
              if (message.id === undefined) continue;
              stdout.write(
                `${JSON.stringify({
                  jsonrpc: "2.0",
                  id: message.id,
                  result: message.method === "tools/list" ? { tools: [] } : { ok: true },
                })}\n`,
              );
            }
          });
          return {
            receipt: { state: "ready" },
            process: {
              pid: 9200,
              ready: Promise.resolve(),
              wait: new Promise(() => undefined),
              stop: async () => undefined,
              cancel: async () => undefined,
              stdin,
              stdout,
              once: () => undefined,
            },
          } as never;
        },
      },
    });
    const effective = effectiveMcpSnapshot("mcp-local", "local");
    const currentPackage = effective.packages[0]!;
    const currentComponent = currentPackage.components[0]!;

    await manager.reconcile(effective);
    await manager.reconcileLifecycleSnapshot({
      packages: [
        {
          ...currentPackage,
          components: [{ ...currentComponent, effectiveState: { kind: "effective" } }],
        },
        {
          ...currentPackage,
          extensionId: "15000000-0000-4000-8000-000000000099",
          packageId: "15000000-0000-4000-8000-000000000099",
        },
      ],
    } as never);
    expect(manager.sessions()).toHaveLength(1);

    await manager.reconcileLifecycleSnapshot({
      packages: [
        {
          ...currentPackage,
          components: [
            { ...currentComponent, effectiveState: { kind: "blocked", reason: "untrusted" } },
          ],
        },
      ],
    } as never);
    expect(manager.sessions()).toHaveLength(0);
  });

  it("resolves bare stdio commands through an approved scoped sandbox", async () => {
    let observed:
      | {
          entryPoint: string;
          command: string;
          env: Readonly<Record<string, string>>;
          sandbox: unknown;
        }
      | undefined;
    const manager = new AgentPluginMcpSessionManager({
      store: {
        contentRoot: () => "/tmp/plugin",
        pluginDataRoot: () => "/tmp/plugin-data",
        readVerifiedConfiguration: async () =>
          JSON.stringify({
            $schema: AGENT_PLUGINS_MCP_SCHEMA,
            mcpServers: {
              local: { type: "stdio", command: basename(process.execPath) },
            },
          }),
      },
      baseEnv: { PATH: dirname(process.execPath), HOME: "/tmp/approved-home" },
      stdioSupervisor: {
        startInteractive: async (runtime) => {
          observed = {
            entryPoint: runtime.entryPoint,
            command: runtime.command,
            env: runtime.env,
            sandbox: (runtime as { sandbox?: unknown }).sandbox,
          };
          throw new Error("stop after admission capture");
        },
      },
    });

    const effective = effectiveMcpSnapshot("mcp-local", "local", {
      mode: "chat",
      threadId: "17000000-0000-4000-8000-000000000001" as never,
    });
    await manager.reconcile(effective);

    expect(observed).toMatchObject({
      entryPoint: "/tmp/plugin/mcp.json",
      command: process.execPath,
      env: expect.objectContaining({
        PATH: dirname(process.execPath),
        HOME: expect.stringContaining("/tmp/plugin-data/"),
        PLUGIN_ROOT: "/tmp/plugin",
      }),
      sandbox: {
        kind: "macos-seatbelt",
        scope: effective.scope,
        allowRead: expect.arrayContaining([
          "/tmp/plugin",
          expect.stringContaining("/tmp/plugin-data/"),
        ]),
        allowWrite: [expect.stringContaining("/tmp/plugin-data/")],
        allowNetwork: false,
      },
    });
  });

  it("preserves package-owned MCP executables as the supervised entry point", async () => {
    let observed: { entryPoint: string; command: string } | undefined;
    const manager = new AgentPluginMcpSessionManager({
      store: {
        contentRoot: () => "/tmp/plugin",
        pluginDataRoot: () => "/tmp/plugin-data",
        readVerifiedConfiguration: async () =>
          JSON.stringify({
            $schema: AGENT_PLUGINS_MCP_SCHEMA,
            mcpServers: {
              local: { type: "stdio", command: "./bin/server" },
            },
          }),
      },
      stdioSupervisor: {
        startInteractive: async (runtime) => {
          observed = { entryPoint: runtime.entryPoint, command: runtime.command };
          throw new Error("stop after admission capture");
        },
      },
    });

    await manager.reconcile(effectiveMcpSnapshot("mcp-local", "local"));

    expect(observed).toEqual({
      entryPoint: "/tmp/plugin/bin/server",
      command: "/tmp/plugin/bin/server",
    });
  });

  it("removes stale tools after transport close and reconnects only on reconciliation", async () => {
    const exitListeners: Array<() => void> = [];
    let starts = 0;
    const manager = new AgentPluginMcpSessionManager({
      store: {
        contentRoot: () => "/tmp/plugin",
        pluginDataRoot: () => "/tmp/plugin-data",
        readVerifiedConfiguration: async () =>
          JSON.stringify({
            $schema: AGENT_PLUGINS_MCP_SCHEMA,
            mcpServers: { local: { type: "stdio", command: "./server" } },
          }),
      },
      stdioSupervisor: {
        startInteractive: async () => {
          starts += 1;
          const stdin = new PassThrough();
          const stdout = new PassThrough();
          let pending = "";
          stdin.setEncoding("utf8");
          stdin.on("data", (chunk) => {
            pending += String(chunk);
            for (
              let newline = pending.indexOf("\n");
              newline >= 0;
              newline = pending.indexOf("\n")
            ) {
              const line = pending.slice(0, newline);
              pending = pending.slice(newline + 1);
              const message = JSON.parse(line) as { id?: number; method?: string };
              if (message.id === undefined) continue;
              stdout.write(
                `${JSON.stringify({
                  jsonrpc: "2.0",
                  id: message.id,
                  result:
                    message.method === "initialize"
                      ? { protocolVersion: "2025-03-26" }
                      : message.method === "tools/list"
                        ? { tools: [{ name: "echo", inputSchema: { type: "object" } }] }
                        : {},
                })}\n`,
              );
            }
          });
          return {
            receipt: { state: "ready" },
            process: {
              stdin,
              stdout,
              stop: async () => undefined,
              once: (_event: "exit", listener: () => void) => exitListeners.push(listener),
            },
          } as never;
        },
      },
    });
    const effective = effectiveMcpSnapshot("mcp-local", "local", {
      mode: "chat",
      threadId: "15000000-0000-4000-8000-000000000003" as never,
    });

    await manager.reconcile(effective);
    expect(manager.toolDefinitions()).toHaveLength(1);
    exitListeners[0]?.();
    expect(manager.sessions()).toHaveLength(0);
    expect(manager.toolDefinitions()).toHaveLength(0);
    expect(manager.failedComponents()).toEqual([
      expect.objectContaining({
        componentId: "mcp-local",
        reason: expect.stringContaining("closed"),
      }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(starts).toBe(1);

    await manager.reconcile(effective);
    expect(starts).toBe(2);
    expect(manager.sessions()).toHaveLength(1);
    await manager.drainAll();
  });

  it("bounds stalled MCP connection attempts with an abort deadline", async () => {
    let observedSignal: AbortSignal | undefined;
    const manager = new AgentPluginMcpSessionManager({
      store: {
        contentRoot: () => "/tmp/plugin",
        pluginDataRoot: () => "/tmp/plugin-data",
        readVerifiedConfiguration: async () =>
          JSON.stringify({
            $schema: AGENT_PLUGINS_MCP_SCHEMA,
            mcpServers: {
              stalled: { type: "streamable-http", url: "https://example.test/stalled" },
            },
          }),
      },
      connectionTimeoutMs: 10,
      fetch: ((_input, init) => {
        observedSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          observedSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }) as typeof fetch,
    });

    await manager.reconcile({
      sequence: 1,
      snapshotAt: "2026-08-06T00:00:00.000Z",
      scope: {
        hostId: "local",
        mode: "code",
        projectId: null,
        threadId: null,
        providerFamily: "openai-compatible",
      },
      catalogEpoch: `sha256:${"a".repeat(64)}`,
      catalogStatus: "available",
      stale: false,
      packages: [
        {
          extensionId: "15000000-0000-4000-8000-000000000001",
          packageId: "15000000-0000-4000-8000-000000000002",
          slug: "hello-plugin",
          displayName: "hello-plugin",
          stateVersion: 1,
          version: "1.0.0",
          digest: `sha256:${"c".repeat(64)}`,
          source: { kind: "local-folder", sourceRef: "local-test" },
          components: [
            {
              component: {
                id: "mcp-stalled",
                kind: "mcp-server",
                displayName: "stalled",
                declaredCapabilities: ["mcp"],
                entryPoint: "mcp.json",
              },
              effectiveState: { kind: "effective" },
            },
          ],
        },
      ],
      collisions: [],
    } as never);

    expect(observedSignal?.aborted).toBe(true);
    expect(manager.sessions()).toEqual([]);
  });

  it("times out MCP tool calls and closes the underlying transport", async () => {
    let toolCallAborted = false;
    const fetchImpl = (async (_input, init) => {
      const method = init?.method ?? "GET";
      if (method === "DELETE") return new Response(null, { status: 204 });
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        method?: string;
        id?: number;
      };
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (body.method === "tools/call") {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              toolCallAborted = true;
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        });
      }
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result:
          body.method === "tools/list"
            ? { tools: [{ name: "stall", inputSchema: { type: "object" } }] }
            : {
                protocolVersion: "2025-03-26",
                capabilities: {},
                serverInfo: { name: "stall", version: "1.0.0" },
              },
      });
    }) as typeof fetch;
    const manager = new AgentPluginMcpSessionManager({
      store: {
        contentRoot: () => "/tmp/plugin",
        pluginDataRoot: () => "/tmp/plugin-data",
        readVerifiedConfiguration: async () =>
          JSON.stringify({
            $schema: AGENT_PLUGINS_MCP_SCHEMA,
            mcpServers: {
              stalled: { type: "streamable-http", url: "https://example.test/mcp" },
            },
          }),
      },
      fetch: fetchImpl,
      toolCallTimeoutMs: 10,
      authorizeToolCall: async () => true,
    } as never);
    const effective = effectiveMcpSnapshot("mcp-stalled", "stalled");
    await manager.reconcile(effective);
    const [definition] = manager.toolDefinitions();
    expect(definition).toBeDefined();

    const caller = new AbortController();
    const callerTimeout = setTimeout(() => caller.abort(), 100);
    const result = await manager.createToolExecutionPort().execute({
      thread: { id: effective.scope.threadId } as never,
      name: definition!.name,
      inputJson: "{}",
      signal: caller.signal,
    });
    clearTimeout(callerTimeout);

    expect(result).toMatchObject({ isError: true });
    expect(caller.signal.aborted).toBe(false);
    expect(toolCallAborted).toBe(true);
    expect(manager.sessions()).toHaveLength(0);
    await manager.drainAll();
  });

  it("requires exact thread and input approval before invoking an MCP tool", async () => {
    let toolCalls = 0;
    const authorizeToolCall = vi.fn(async () => false);
    const fetchImpl = (async (_input, init) => {
      if ((init?.method ?? "GET") === "DELETE") return new Response(null, { status: 204 });
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; id?: number };
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "tools/call") toolCalls += 1;
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result:
          body.method === "tools/list"
            ? { tools: [{ name: "mutate", inputSchema: { type: "object" } }] }
            : body.method === "tools/call"
              ? { content: [{ type: "text", text: "mutated" }] }
              : {
                  protocolVersion: "2025-03-26",
                  capabilities: {},
                  serverInfo: { name: "mutating", version: "1.0.0" },
                },
      });
    }) as typeof fetch;
    const manager = new AgentPluginMcpSessionManager({
      store: {
        contentRoot: () => "/tmp/plugin",
        pluginDataRoot: () => "/tmp/plugin-data",
        readVerifiedConfiguration: async () =>
          JSON.stringify({
            $schema: AGENT_PLUGINS_MCP_SCHEMA,
            mcpServers: {
              mutating: { type: "streamable-http", url: "https://example.test/mcp" },
            },
          }),
      },
      fetch: fetchImpl,
      authorizeToolCall,
    } as never);
    const effective = effectiveMcpSnapshot("mcp-mutating", "mutating", {
      mode: "chat",
      threadId: "17000000-0000-4000-8000-000000000099" as never,
    });
    await manager.reconcile(effective);
    const [definition] = manager.toolDefinitions();

    const mismatched = await manager.createToolExecutionPort().execute({
      thread: { id: "17000000-0000-4000-8000-000000000098" } as never,
      name: definition!.name,
      inputJson: '{"target":"production"}',
    });
    expect(mismatched).toEqual({
      result: { error: "extension-tool-authority-mismatch" },
      isError: true,
    });
    expect(authorizeToolCall).not.toHaveBeenCalled();

    const result = await manager.createToolExecutionPort().execute({
      windowId: "17000000-0000-4000-8000-000000000097" as never,
      thread: { id: effective.scope.threadId } as never,
      name: definition!.name,
      inputJson: '{"target":"production"}',
    });

    expect(result).toEqual({
      result: { error: "extension-tool-approval-required" },
      isError: true,
    });
    expect(authorizeToolCall).toHaveBeenCalledOnce();
    expect(authorizeToolCall).toHaveBeenCalledWith({
      windowId: "17000000-0000-4000-8000-000000000097",
      thread: { id: effective.scope.threadId },
      packageId: "15000000-0000-4000-8000-000000000002",
      componentId: "mcp-mutating",
      providerToolName: definition!.name,
      mcpToolName: "mutate",
      inputJson: '{"target":"production"}',
    });
    expect(toolCalls).toBe(0);
    await manager.drainAll();
  });

  it("rejects MCP tool results that exceed the provider answer contract", async () => {
    const fetchImpl = (async (_input, init) => {
      if ((init?.method ?? "GET") === "DELETE") return new Response(null, { status: 204 });
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; id?: number };
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result:
          body.method === "tools/list"
            ? { tools: [{ name: "large", inputSchema: { type: "object" } }] }
            : body.method === "tools/call"
              ? { content: [{ type: "text", text: "x".repeat(70_000) }] }
              : {
                  protocolVersion: "2025-03-26",
                  capabilities: {},
                  serverInfo: { name: "large", version: "1.0.0" },
                },
      });
    }) as typeof fetch;
    const manager = new AgentPluginMcpSessionManager({
      store: {
        contentRoot: () => "/tmp/plugin",
        pluginDataRoot: () => "/tmp/plugin-data",
        readVerifiedConfiguration: async () =>
          JSON.stringify({
            $schema: AGENT_PLUGINS_MCP_SCHEMA,
            mcpServers: {
              large: { type: "streamable-http", url: "https://example.test/mcp" },
            },
          }),
      },
      fetch: fetchImpl,
      authorizeToolCall: async () => true,
    } as never);
    const effective = effectiveMcpSnapshot("mcp-large", "large");
    await manager.reconcile(effective);
    const [definition] = manager.toolDefinitions();

    const result = await manager.createToolExecutionPort().execute({
      thread: { id: effective.scope.threadId } as never,
      name: definition!.name,
      inputJson: "{}",
    });

    expect(result).toEqual({
      result: { error: "MCP tool result exceeded provider limits." },
      isError: true,
    });
    await manager.drainAll();
  });

  it("retires idle scope-owned MCP sessions and reconnects them on demand", async () => {
    let closes = 0;
    const fetchImpl = (async (_input, init) => {
      if ((init?.method ?? "GET") === "DELETE") {
        closes += 1;
        return new Response(null, { status: 204 });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        method?: string;
        id?: number;
      };
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      return Response.json(
        {
          jsonrpc: "2.0",
          id: body.id,
          result:
            body.method === "tools/list"
              ? { tools: [{ name: "echo", inputSchema: { type: "object" } }] }
              : {
                  protocolVersion: "2025-03-26",
                  capabilities: {},
                  serverInfo: { name: "remote", version: "1.0.0" },
                },
        },
        { headers: { "mcp-session-id": "idle" } },
      );
    }) as typeof fetch;
    const manager = new AgentPluginMcpSessionManager({
      store: {
        contentRoot: () => "/tmp/plugin",
        pluginDataRoot: () => "/tmp/plugin-data",
        readVerifiedConfiguration: async () =>
          JSON.stringify({
            $schema: AGENT_PLUGINS_MCP_SCHEMA,
            mcpServers: {
              remote: { type: "streamable-http", url: "https://example.test/mcp" },
            },
          }),
      },
      fetch: fetchImpl,
      idleTimeoutMs: 10,
    } as never);
    const effective = effectiveMcpSnapshot("mcp-remote", "remote");

    await manager.reconcile(effective);
    expect(manager.sessions()).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(manager.sessions()).toHaveLength(0);
    expect(closes).toBe(1);

    await manager.reconcile(effective);
    expect(manager.sessions()).toHaveLength(1);
    await manager.drainAll();
  });

  it("connects effective servers, exposes tools, and isolates sibling failures", async () => {
    const contentRoot = await mkdtemp(join(tmpdir(), "octant-agent-plugins-content-"));
    const pluginDataRoot = await mkdtemp(join(tmpdir(), "octant-agent-plugins-data-"));
    try {
      await writeAgentPlugin(contentRoot, {
        mcpJson: {
          $schema: AGENT_PLUGINS_MCP_SCHEMA,
          mcpServers: {
            good: {
              type: "streamable-http",
              url: "https://example.test/good",
            },
            bad: {
              type: "streamable-http",
              url: "https://example.test/bad",
            },
          },
        },
      });
      const fetchImpl = (async (input, init) => {
        const url = String(input);
        const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; id?: number };
        if (url.includes("/bad")) {
          return new Response("boom", { status: 500 });
        }
        if (body.method === "tools/list") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id ?? 1,
              result: { tools: [{ name: "ok", inputSchema: { type: "object" } }] },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json", "mcp-session-id": "good" },
            },
          );
        }
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result: { ok: true } }),
          {
            status: 200,
            headers: { "content-type": "application/json", "mcp-session-id": "good" },
          },
        );
      }) as typeof fetch;

      const manager = new AgentPluginMcpSessionManager({
        store: {
          contentRoot: () => contentRoot,
          pluginDataRoot: () => pluginDataRoot,
          readVerifiedConfiguration: async () => readFile(join(contentRoot, "mcp.json"), "utf8"),
        },
        fetch: fetchImpl,
      });

      const effective = {
        sequence: 1 as never,
        snapshotAt: "2026-08-06T00:00:00.000Z" as never,
        scope: {
          hostId: "local" as never,
          mode: "code",
          projectId: null,
          threadId: null,
          providerFamily: "openai-compatible" as never,
        },
        catalogEpoch: `sha256:${"a".repeat(64)}` as never,
        catalogStatus: "available",
        stale: false,
        packages: [
          {
            extensionId: "extension:local-test:hello-plugin" as never,
            packageId: "15000000-0000-4000-8000-000000000002" as never,
            slug: "hello-plugin" as never,
            displayName: "hello-plugin",
            stateVersion: 1 as never,
            version: "1.0.0" as never,
            digest: `sha256:${"c".repeat(64)}` as never,
            source: {
              kind: "local-folder",
              sourceRef: "local-test" as never,
            },
            components: [
              {
                component: {
                  id: "mcp-good" as never,
                  kind: "mcp-server",
                  displayName: "good",
                  declaredCapabilities: ["mcp"],
                  entryPoint: "mcp.json",
                },
                effectiveState: { kind: "effective" } as never,
              },
              {
                component: {
                  id: "mcp-bad" as never,
                  kind: "mcp-server",
                  displayName: "bad",
                  declaredCapabilities: ["mcp"],
                  entryPoint: "mcp.json",
                },
                effectiveState: { kind: "effective" } as never,
              },
            ],
          },
        ],
        collisions: [],
      } as unknown as ExtensionEffectiveSnapshot;

      await manager.reconcile(effective);

      expect(manager.sessions()).toHaveLength(1);
      expect(manager.sessions()[0]?.serverName).toBe("good");
      const definitions = manager.toolDefinitions();
      expect(definitions).toHaveLength(1);
      expect(definitions[0]?.name).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(definitions[0]?.name.length).toBeLessThanOrEqual(64);
      expect(
        manager.toolDefinitionsFor(
          "15000000-0000-4000-8000-000000000002",
          "mcp-good",
          effective.scope,
        ),
      ).toEqual(definitions);
      expect(
        manager.toolDefinitionsFor(
          "15000000-0000-4000-8000-000000000099",
          "mcp-good",
          effective.scope,
        ),
      ).toEqual([]);
      expect(manager.failedComponents()).toEqual([
        expect.objectContaining({
          packageId: "15000000-0000-4000-8000-000000000002",
          componentId: "mcp-bad",
        }),
      ]);
      const projected = manager.projectEffectiveState(effective);
      expect(projected.packages[0]?.components).toEqual([
        expect.objectContaining({ effectiveState: { kind: "effective" } }),
        expect.objectContaining({
          component: expect.objectContaining({ id: "mcp-bad" }),
          effectiveState: { kind: "blocked", reason: "unavailable" },
        }),
      ]);
      const policyBlocked = manager.projectEffectiveState({
        ...effective,
        packages: effective.packages.map((packageState) => ({
          ...packageState,
          components: packageState.components.map((componentState) =>
            componentState.component.id === "mcp-bad"
              ? {
                  ...componentState,
                  effectiveState: { kind: "blocked", reason: "mode-prohibited" },
                }
              : componentState,
          ),
        })),
      } as never);
      expect(policyBlocked.packages[0]?.components[1]?.effectiveState).toEqual({
        kind: "blocked",
        reason: "mode-prohibited",
      });
      const port = manager.createToolExecutionPort();
      expect(
        port.availability({
          thread: {
            id: "20000000-0000-4000-8000-000000000001" as never,
            title: "Test",
            lifecycle: "active",
            providerInstanceId: "30000000-0000-4000-8000-000000000001" as never,
            model: "test",
            createdAt: "2026-08-06T00:00:00.000Z" as never,
            updatedAt: "2026-08-06T00:00:00.000Z" as never,
          } as never,
          definitions: manager.toolDefinitions(),
        }),
      ).toBe("available");
      await manager.drainAll();
      expect(manager.sessions()).toHaveLength(0);
    } finally {
      await rm(contentRoot, { recursive: true, force: true });
      await rm(pluginDataRoot, { recursive: true, force: true });
    }
  });
});

function effectiveMcpSnapshot(
  componentId: string,
  displayName: string,
  scope: Partial<ExtensionEffectiveSnapshot["scope"]> = {},
): ExtensionEffectiveSnapshot {
  return {
    sequence: 1,
    snapshotAt: "2026-08-06T00:00:00.000Z",
    scope: {
      hostId: "local",
      mode: "code",
      projectId: null,
      threadId: null,
      providerFamily: "openai-compatible",
      ...scope,
    },
    catalogEpoch: `sha256:${"a".repeat(64)}`,
    catalogStatus: "available",
    stale: false,
    packages: [
      {
        extensionId: "15000000-0000-4000-8000-000000000001",
        packageId: "15000000-0000-4000-8000-000000000002",
        slug: "hello-plugin",
        displayName: "hello-plugin",
        stateVersion: 1,
        version: "1.0.0",
        digest: `sha256:${"c".repeat(64)}`,
        source: { kind: "local-folder", sourceRef: "local-test" },
        components: [
          {
            component: {
              id: componentId,
              kind: "mcp-server",
              displayName,
              declaredCapabilities: ["mcp"],
              entryPoint: "mcp.json",
            },
            effectiveState: { kind: "effective" },
          },
        ],
      },
    ],
    collisions: [],
  } as never;
}

describe("Agent Plugins MCP protocol headers", () => {
  it("sends the negotiated MCP protocol version on subsequent Streamable HTTP requests", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (_input, init) => {
      const headers = new Headers(init?.headers);
      seen.push(`${init?.method ?? "GET"}:${headers.get("mcp-protocol-version") ?? ""}`);
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; id?: number };
      if (body.method === "initialize") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id ?? 1,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              serverInfo: { name: "t", version: "1" },
            },
          }),
          { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "s1" } },
        );
      }
      if (body.method === "tools/list") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id ?? 2,
            result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] },
          }),
          { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "s1" } },
        );
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 3, result: {} }), {
        status: 200,
        headers: { "content-type": "application/json", "mcp-session-id": "s1" },
      });
    }) as typeof fetch;

    const { connectAgentPluginMcpSession } = await import("./agentPluginMcpClient");
    const session = await connectAgentPluginMcpSession(
      {
        transport: "streamable-http",
        name: "docs",
        url: "https://example.test/mcp",
        headers: {},
      },
      { fetch: fetchImpl },
    );
    expect(session.tools.map((tool) => tool.name)).toEqual(["echo"]);
    // initialize has no negotiated header yet; initialized + tools/list must carry it.
    expect(seen.some((entry) => entry === "POST:2025-03-26")).toBe(true);
    await session.close();
  });
});
