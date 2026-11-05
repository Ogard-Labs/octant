import { randomUUID, randomBytes } from "node:crypto";
import { Schema } from "effect";
import { afterEach, describe, it, expect, vi } from "vitest";
import { decodeWindowId } from "@octant/contracts";
import { DeviceId, StableHostId, RemoteSessionId } from "@octant/contracts/remote-access";
import { decodeCommandCredentialDefinition } from "@octant/contracts/command-credentials";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { bindPrincipalRouteContext } from "../principalRouteContext";
import { commandCredentialRoutes } from "./commandCredentialRoutes";
import { commandCredentialTools } from "./commandCredentialTools";
import { CommandCredentialBindings } from "./commandCredentialBindings";
const services: CommandCredentialBindings[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.close();
});
async function fixture() {
  const store = new WindowAuthorityStore();
  const window = decodeWindowId(randomUUID());
  const token = randomBytes(32).toString("base64url");
  store.register({ windowId: window, capability: token, now: Date.now() });
  const project = randomUUID();
  const thread = randomUUID();
  let full = true;
  const execute = vi.fn(
    async (
      _binding: unknown,
      _context: unknown,
      _signal: AbortSignal,
      current: () => boolean,
      started: () => void,
    ) => {
      if (!current())
        return {
          status: "refused" as const,
          effect: "none" as const,
          output: "",
          truncated: false,
        };
      started();
      return {
        status: "exited" as const,
        effect: "completed" as const,
        exitCode: 0,
        output: "fixed-recipient-output",
        truncated: false,
      };
    },
  );
  const service = new CommandCredentialBindings({
    now: () => performance.now(),
    uuid: randomUUID,
    canConfigure: (w, p) =>
      w === String(window) && p === project && store.listWindowIds().includes(window),
    context: async (w, t) =>
      w === String(window) && t === thread
        ? {
            windowId: w,
            threadId: t,
            projectId: project,
            root: "/fixture",
            authorityKey: "one",
            executionPolicy: full ? "full-access" : "plan",
            current: () => store.listWindowIds().includes(window),
            revalidate: async () => true,
          }
        : undefined,
    pin: async (executable) => ({
      executable,
      digest: "a".repeat(64),
      credentialExecutable: "/usr/local/bin/op",
      credentialExecutableDigest: "b".repeat(64),
      credentialVersion: "2.33.0",
    }),
    execute,
    record: () => undefined,
    records: [],
  });
  services.push(service);
  const definition = decodeCommandCredentialDefinition({
    label: "Fixture command",
    projectId: project,
    executable: "/usr/bin/client",
    args: ["status"],
    directory: "",
    accountId: "a".repeat(26),
    environment: [
      { name: "API_TOKEN", vaultId: "v".repeat(26), itemId: "i".repeat(26), fieldId: "credential" },
    ],
    timeoutMs: 1000,
  });
  const saved = await service.save(window, definition);
  if (saved.kind !== "command-credential-view" || !saved.bindings[0])
    throw Error("Expected saved binding");
  const binding = saved.bindings[0];
  const route = commandCredentialRoutes(service, store);
  const request = (body?: unknown, capability = token) =>
    new Request("http://127.0.0.1/api/secret-stores/command-bindings", {
      method: body === undefined ? "GET" : "POST",
      headers: { "x-octant-window-capability": capability, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    service,
    execute,
    store,
    window,
    thread,
    project,
    binding,
    route,
    request,
    narrow: () => {
      full = false;
    },
  };
}
describe("person and provider command authorization", () => {
  it("requires a current local principal, rejects paired and forged fields, and keeps other Project bindings private", async () => {
    const f = await fixture();
    expect((await f.route(f.request(undefined, "wrong")))?.status).toBe(401);
    const remote = f.request();
    bindPrincipalRouteContext(remote, {
      scopeId: f.window,
      principal: {
        kind: "remote-device",
        deviceId: Schema.decodeUnknownSync(DeviceId)(randomUUID()),
        hostId: Schema.decodeUnknownSync(StableHostId)(randomUUID()),
        sessionId: Schema.decodeUnknownSync(RemoteSessionId)(randomUUID()),
        credentialGeneration: 1,
        origin: "https://remote.example",
        protocolVersion: 1,
        capabilityDigest: "fixture",
      },
    });
    expect((await f.route(remote))?.status).toBe(401);
    expect(
      (
        await f.route(
          f.request({
            kind: "review",
            bindingId: f.binding.bindingId,
            threadId: f.thread,
            operationId: randomUUID(),
            windowId: f.window,
          }),
        )
      )?.status,
    ).toBe(400);
    const other = new Request(
      `http://127.0.0.1/api/secret-stores/command-bindings?projectId=${randomUUID()}`,
      { headers: f.request().headers },
    );
    expect(await (await f.route(other))?.json()).toMatchObject({
      bindings: [],
      requests: [],
      receipts: [],
    });
    const review = await f.service.review(
      f.window,
      randomUUID(),
      f.binding.bindingId,
      randomUUID(),
    );
    expect(review).toMatchObject({ reason: "unauthorized" });
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("uses the same human review for a provider-selected binding and refuses Plan for the person too", async () => {
    const f = await fixture();
    const tool = commandCredentialTools({
      service: f.service,
      windowId: f.window,
      threadId: f.thread,
      projectId: f.project,
      current: () => true,
    });
    const running = tool.execute({
      name: "octant_command",
      inputJson: JSON.stringify({ operation: "run", bindingId: f.binding.bindingId }),
    });
    await vi.waitFor(() => {
      const view = f.service.view(f.window);
      expect(view.kind === "command-credential-view" ? view.requests.length : 0).toBe(1);
    });
    expect(f.execute).not.toHaveBeenCalled();
    const view = f.service.view(f.window);
    if (view.kind !== "command-credential-view" || !view.requests[0])
      throw Error("Expected human review");
    const reply = await f.route(
      f.request({ kind: "approve", requestId: view.requests[0].requestId }),
    );
    expect(await reply?.json()).toMatchObject({ status: "exited", effect: "completed" });
    expect(await running).toMatchObject({
      result: { status: "exited", output: "fixed-recipient-output" },
      isError: false,
    });
    expect(f.execute).toHaveBeenCalledOnce();
    await tool.close?.();
    f.narrow();
    expect(
      await f.service.review(f.window, f.thread, f.binding.bindingId, randomUUID()),
    ).toMatchObject({ reason: "full-access-required" });
  });
  it("cancels a pending provider request when its tool lifetime ends", async () => {
    const f = await fixture();
    const tool = commandCredentialTools({
      service: f.service,
      windowId: f.window,
      threadId: f.thread,
      projectId: f.project,
      current: () => true,
    });
    const pending = tool.execute({
      name: "octant_command",
      inputJson: JSON.stringify({ operation: "run", bindingId: f.binding.bindingId }),
    });
    await vi.waitFor(() => {
      const view = f.service.view(f.window);
      expect(view.kind === "command-credential-view" ? view.requests.length : 0).toBe(1);
    });
    await tool.close?.();
    expect(await pending).toMatchObject({ result: { status: "cancelled", effect: "none" } });
    expect(f.execute).not.toHaveBeenCalled();
  });
});
