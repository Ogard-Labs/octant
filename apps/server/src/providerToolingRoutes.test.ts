import { decodeProviderInstance, decodeWindowId } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { bindPrincipalRouteContext } from "./principalRouteContext";
import { createProviderToolingRouteHandler } from "./providerToolingRoutes";
import type { ProviderCredentialStore } from "./providers/credentialBrokerClient";
import type { ProviderToolingRun } from "./providers/providerToolingProcess";
import { ProviderToolingService } from "./providers/providerToolingService";
import { WindowAuthorityStore } from "./windowAuthorityStore";

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const windowId = decodeWindowId("00000000-0000-4000-8000-000000000941");
const ACCOUNT = "80000000-0000-4000-8000-0000000000b1";
const SECRET = "plain-secret-value-123";
const base = "http://127.0.0.1/api/provider-tooling";

function route() {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  const runs: ProviderToolingRun[] = [];
  const held = new Map<string, string>();
  const broker: ProviderCredentialStore = {
    set: async (id, value) => void held.set(id, value),
    delete: async (id) => void held.delete(id),
    has: async (id) => held.has(id),
    resolve: async (id) => held.get(id) ?? "",
  };
  const records: unknown[] = [];
  const service = new ProviderToolingService({
    readInstance: () =>
      decodeProviderInstance({
        id: ACCOUNT,
        displayName: "Claude A",
        driverKind: "claude",
        configuration: {
          kind: "claude-agent-sdk",
          binaryPath: "claude",
          authentication: "subscription",
          configDirectory: "/tmp/octant-route-test-claude",
        },
        enabled: true,
        environmentPolicy: "inherit-host",
        version: 1,
        createdAt: "2026-07-16T11:00:00.000Z",
        updatedAt: "2026-07-16T11:00:00.000Z",
      }),
    runner: async (run) => {
      runs.push(run);
      return {
        exitCode: 0,
        timedOut: false,
        startFailed: false,
        output: `done ${run.environment.MCP_CLIENT_SECRET ?? ""}`,
      };
    },
    hostEnvironment: () => ({ PATH: "/usr/bin:/bin" }),
    homeDirectory: "/tmp",
    workingDirectory: "/tmp/octant-route-test-work",
    secrets: broker,
    record: (change) => records.push(change),
  });
  return {
    runs,
    records,
    handler: createProviderToolingRouteHandler({
      service,
      windowAuthorityStore: store,
      now: () => 1,
    }),
  };
}

function post(path: string, body: unknown, headers: Record<string, string> = {}, target = base) {
  return new Request(`${target}/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-octant-window-capability": capability,
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const planBody = {
  providerInstanceId: ACCOUNT,
  request: {
    kind: "mcp-add-url",
    name: "hosted",
    url: "https://example.com/mcp",
    oauthClientId: "c1",
    oauthClientSecret: SECRET,
  },
};

describe("provider tooling routes", () => {
  it("plans and then runs a change for the person's window without echoing the secret", async () => {
    const { handler, runs, records } = route();
    const planned = await handler(post("plan", planBody));
    expect(planned?.status).toBe(200);
    const planText = await planned!.text();
    expect(planText).not.toContain(SECRET);
    const plan = JSON.parse(planText);
    expect(plan.status).toBe("planned");
    expect(plan.commandLine).toContain("<secret>");

    const applied = await handler(post("apply", { planId: plan.planId, digest: plan.digest }));
    expect(applied?.status).toBe(200);
    const appliedText = await applied!.text();
    expect(appliedText).not.toContain(SECRET);
    expect(JSON.parse(appliedText).status).toBe("applied");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.argv.join(" ")).not.toContain(SECRET);
    expect(runs[0]?.environment.MCP_CLIENT_SECRET).toBe(SECRET);
    expect(JSON.stringify(records)).not.toContain(SECRET);
  });

  it("refuses a caller with no window capability, which is every agent, and runs nothing", async () => {
    const { handler, runs } = route();
    for (const path of ["list", "plan", "apply"]) {
      const response = await handler(
        new Request(`${base}/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(planBody),
        }),
      );
      expect(response?.status, path).toBe(401);
    }
    const wrong = await handler(post("plan", planBody, { "x-octant-window-capability": "wrong" }));
    expect(wrong?.status).toBe(401);
    expect(runs).toEqual([]);
  });

  it("refuses a request forwarded from a paired device and runs nothing", async () => {
    const { handler, runs } = route();
    for (const [path, body] of [
      ["list", { providerInstanceId: ACCOUNT }],
      ["plan", planBody],
      ["apply", { planId: "11111111-1111-4111-8111-111111111111", digest: "0".repeat(64) }],
    ] as const) {
      const remote = post(path, body);
      bindPrincipalRouteContext(remote, {
        principal: { kind: "remote-device" } as never,
        scopeId: windowId,
      });
      expect((await handler(remote))?.status, path).toBe(401);
    }
    expect(runs).toEqual([]);
  });

  it("refuses a malformed, oversized, or non-loopback request", async () => {
    const { handler } = route();
    expect((await handler(post("plan", "{not json")))?.status).toBe(400);
    expect(
      (await handler(post("plan", { providerInstanceId: ACCOUNT, request: { kind: "rm" } })))
        ?.status,
    ).toBe(400);
    expect((await handler(post("plan", { ...planBody, extra: SECRET })))?.status).toBe(400);
    expect((await handler(post("plan", "x".repeat(70 * 1024))))?.status).toBe(413);
    expect(
      (await handler(post("plan", planBody, {}, "http://example.com/api/provider-tooling")))
        ?.status,
    ).toBe(400);
  });

  it("leaves other paths and methods to the rest of the host", async () => {
    const { handler } = route();
    expect(
      await handler(new Request("http://127.0.0.1/api/other", { method: "POST" })),
    ).toBeUndefined();
    expect(await handler(new Request(`${base}/list`, { method: "GET" }))).toBeUndefined();
  });
});
