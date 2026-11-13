import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { AGENT_PLUGINS_MCP_SCHEMA } from "@octant/plugin-host/agent-plugins";

const proxy = vi.hoisted(() => ({ failures: 1 }));
vi.mock("./hostAllowListProxy", () => ({
  startHostAllowListProxy: async () => {
    if (proxy.failures-- > 0) throw new Error("no file descriptors");
    return { port: 49999, stop: async () => undefined };
  },
}));

const { AgentPluginMcpSessionManager } = await import("./agentPluginMcpSessionManager");

function snapshot(threadId: string) {
  return {
    sequence: 1,
    snapshotAt: "2026-08-06T00:00:00.000Z",
    scope: {
      hostId: "local",
      mode: "code",
      projectId: null,
      threadId,
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
              id: "mcp-local",
              kind: "mcp-server",
              displayName: "local",
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

describe("a connector that keeps one login", () => {
  it("frees its one slot when the proxy cannot start, so the next start is not refused", async () => {
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
      exclusiveForSource: () => true,
      egressHostsForSource: () => ["*.example.com"],
      stdioSupervisor: {
        startInteractive: async () => {
          starts += 1;
          const stdin = new PassThrough();
          const stdout = new PassThrough();
          stdin.on("data", (chunk) => {
            const message = JSON.parse(String(chunk).split("\n")[0] ?? "{}") as {
              id?: number;
              method?: string;
            };
            if (message.id === undefined) return;
            stdout.write(
              `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: message.method === "tools/list" ? { tools: [] } : { ok: true } })}\n`,
            );
          });
          return {
            receipt: { state: "ready" },
            process: {
              pid: 9004,
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
    await manager.reconcile(snapshot("thread-a"));
    expect(starts).toBe(0);
    await manager.reconcile(snapshot("thread-b"));
    expect(starts).toBe(1);
    await manager.drainAll();
  });
});
