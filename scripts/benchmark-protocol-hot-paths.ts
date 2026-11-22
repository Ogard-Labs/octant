import { arch, cpus, platform, release, totalmem } from "node:os";
import { PassThrough } from "node:stream";
import { decodeExtensionEffectiveSnapshot } from "@octant/contracts/extension-rpc";
import { AGENT_PLUGINS_MCP_SCHEMA } from "@octant/plugin-host/agent-plugins";
import { LanguageServerConnection } from "../apps/server/src/code/languageServerConnection";
import { AgentPluginMcpSessionManager } from "../apps/server/src/extensions/agentPluginMcpSessionManager";

const MiB = 1024 * 1024;
const environment = {
  platform: platform(),
  release: release(),
  arch: arch(),
  cpu: cpus()[0]?.model,
  logicalCpus: cpus().length,
  memoryMiB: totalmem() / MiB,
  bun: Bun.version,
};

const selector = process.argv[2];
if (selector === "mcp") {
  console.log(JSON.stringify({ environment, ...(await measureCatalog()) }));
} else if (selector === "frames") {
  console.log(
    JSON.stringify({
      environment,
      chunkBytes: 1024,
      frames: [await measureFrame(MiB), await measureFrame(2 * MiB), await measureFrame(4 * MiB)],
    }),
  );
} else {
  throw Error("Usage: bun scripts/benchmark-protocol-hot-paths.ts mcp|frames");
}

async function measureFrame(bytes: number) {
  const prefix = '{"jsonrpc":"2.0","id":1,"result":"';
  const suffix = '"}';
  const payload = "x".repeat(bytes - prefix.length - suffix.length);
  const frame = Buffer.from(`Content-Length: ${bytes}\r\n\r\n${prefix}${payload}${suffix}`);
  const chunks = [];
  for (let offset = 0; offset < frame.byteLength; offset += 1024) {
    chunks.push(frame.subarray(offset, offset + 1024));
  }
  const samplesMs: number[] = [];
  for (let iteration = 0; iteration < 7; iteration++) {
    const input = new PassThrough();
    const output = new PassThrough();
    const connection = new LanguageServerConnection({
      input,
      output,
      requestDeadlineMs: 10_000,
      onViolation: (violation) => {
        throw new Error(violation);
      },
    });
    try {
      const response = connection.request("initialize");
      Bun.gc(true);
      const started = performance.now();
      for (const chunk of chunks) input.emit("data", chunk);
      const result = await response;
      const elapsed = performance.now() - started;
      if (result.status !== "answered" || result.result !== payload) {
        throw new Error("The framed response did not arrive intact.");
      }
      if (iteration > 1) samplesMs.push(elapsed);
    } finally {
      connection.close();
      input.destroy();
      output.destroy();
    }
  }
  samplesMs.sort((a, b) => a - b);
  return { bytes, p50Ms: samplesMs[2], maxMs: samplesMs.at(-1), samplesMs };
}

async function measureCatalog() {
  const tools = Array.from({ length: 256 }, (_, index) => ({
    name: `lookup_${index}`,
    inputSchema: {
      $id: `https://example.test/schemas/lookup-${index}`,
      type: "object",
      properties: { key: { type: "string", minLength: 1, maxLength: 100 } },
      required: ["key"],
      additionalProperties: false,
    },
  }));
  const activation = {
    installed: true,
    trusted: true,
    pluginDesired: true,
    componentDesired: true,
    compatible: true,
    policyAllowed: true,
    quarantined: false,
    draining: false,
    broken: false,
    unavailable: false,
    interrupted: false,
    waiting: false,
  };
  const catalog = decodeExtensionEffectiveSnapshot({
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
        stateVersion: 1,
        version: "1.0.0",
        digest: `sha256:${"b".repeat(64)}`,
        source: { kind: "local-folder", sourceRef: "local-benchmark" },
        compatibility: { platforms: ["macos"], modes: ["code"], providerFamilies: [] },
        activation,
        components: [
          {
            component: {
              id: "mcp-local",
              kind: "mcp-server",
              displayName: "local",
              declaredCapabilities: ["mcp"],
              entryPoint: "mcp.json",
            },
            activation,
            policy: {
              revision: 0,
              projectRevision: 0,
              threadRevision: 0,
              hostAllowed: true,
              modeAllowed: true,
              projectAllowed: true,
              threadAllowed: true,
              policyAllowed: true,
            },
            effectiveState: { kind: "effective" },
            contextContribution: { kind: "zero", reason: "not-selected" },
          },
        ],
        diagnostics: [],
      },
    ],
    collisions: [],
  });
  const fixtureFetch = Object.assign(
    async (_: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const message = JSON.parse(String(init?.body ?? "{}")) as {
        readonly id?: number;
        readonly method?: string;
      };
      if (message.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (init?.method !== "POST") throw new Error("Unexpected MCP request.");
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result:
          message.method === "tools/list"
            ? { tools }
            : {
                protocolVersion: "2025-03-26",
                capabilities: {},
                serverInfo: { name: "benchmark", version: "1.0.0" },
              },
      });
    },
    {
      preconnect: () => {
        throw new Error("The benchmark must not use the network.");
      },
    },
  );
  const manager = new AgentPluginMcpSessionManager({
    store: {
      contentRoot: () => "/tmp/octant-benchmark",
      pluginDataRoot: () => "/tmp/octant-benchmark",
      readVerifiedConfiguration: async () =>
        JSON.stringify({
          $schema: AGENT_PLUGINS_MCP_SCHEMA,
          mcpServers: { local: { type: "streamable-http", url: "https://example.test/mcp" } },
        }),
    },
    fetch: fixtureFetch,
  });
  Bun.gc(true);
  const rssBefore = process.memoryUsage.rss();
  const started = performance.now();
  try {
    await manager.reconcile(catalog);
    const elapsedMs = performance.now() - started;
    const rssDeltaMiB = (process.memoryUsage.rss() - rssBefore) / MiB;
    const count = manager.toolDefinitions().length;
    if (count !== tools.length) {
      throw new Error(`Expected ${tools.length} published tools; found ${count}.`);
    }
    return { tools: count, elapsedMs, rssDeltaMiB };
  } finally {
    await manager.drainAll();
  }
}
