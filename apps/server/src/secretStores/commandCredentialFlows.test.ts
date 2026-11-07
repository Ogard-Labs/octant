import { randomUUID, randomBytes } from "node:crypto";
import { Schema } from "effect";
import { afterEach, describe, it, expect, vi } from "vitest";
import { decodeWindowId } from "@octant/contracts";
import { DeviceId, StableHostId, RemoteSessionId } from "@octant/contracts/remote-access";
import { decodeCommandCredentialDefinition } from "@octant/contracts/command-credentials";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { bindPrincipalRouteContext } from "../principalRouteContext";
import { commandCredentialRoutes } from "./commandCredentialRoutes";
import { createCredentialTool, type CredentialToolSource } from "../credentials/credentialTool";
import { savedCredentialCommands } from "./commandCredentialTools";
import { CommandCredentialBindings } from "./commandCredentialBindings";
const services: CommandCredentialBindings[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.close();
});
/** A host with no registered credential operation. */
const nothingRegistered: CredentialToolSource<never> = {
  offered: false,
  list: () => [],
  use: async () => ({ result: { status: "unexpected" }, isError: true }),
  close: async () => undefined,
};
function credentialTool(input: {
  readonly service: CommandCredentialBindings;
  readonly window: string;
  readonly thread: string;
  readonly project: string;
  readonly current?: () => boolean;
}) {
  return createCredentialTool({
    registered: nothingRegistered,
    saved: savedCredentialCommands({
      service: input.service,
      windowId: input.window,
      threadId: input.thread,
      projectId: input.project,
      current: input.current ?? (() => true),
    }),
  });
}
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
  it("is offered for a saved command alone and lists it without its account or vault references", async () => {
    const f = await fixture();
    const tool = credentialTool(f);
    expect(tool.definitions.map((d) => d.name)).toEqual(["octant_credential"]);
    expect(tool.definitions[0]?.inputSchema).toMatchObject({
      properties: { operation: { enum: ["help", "list", "run-saved"] } },
    });
    const listed = await tool.execute({
      name: "octant_credential",
      inputJson: '{"operation":"list"}',
    });
    expect(listed).toEqual({
      isError: false,
      result: {
        operations: [],
        savedCommands: [
          {
            id: f.binding.bindingId,
            label: "Fixture command",
            executable: "/usr/bin/client",
            args: ["status"],
            directory: "",
          },
        ],
      },
    });
    expect(JSON.stringify(listed)).not.toContain("v".repeat(26));
    expect(
      await tool.execute({
        name: "octant_command",
        inputJson: JSON.stringify({ operation: "run", bindingId: f.binding.bindingId }),
      }),
    ).toMatchObject({ isError: true });
    expect(
      await tool.execute({
        name: "octant_credential",
        inputJson: '{"operation":"request","id":"linear-account-check"}',
      }),
    ).toMatchObject({ result: { status: "refused" }, isError: true });
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("is not offered when nothing is registered and no command is saved for this Project", async () => {
    const f = await fixture();
    const tool = credentialTool({ ...f, project: randomUUID() });
    expect(tool.definitions).toEqual([]);
    expect(
      await tool.execute({
        name: "octant_credential",
        inputJson: JSON.stringify({ operation: "run-saved", id: f.binding.bindingId }),
      }),
    ).toMatchObject({ result: { status: "refused" }, isError: true });
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("is not offered in Plan and refuses run-saved without opening a review once Plan begins", async () => {
    const f = await fixture();
    expect(credentialTool({ ...f, current: () => false }).definitions).toEqual([]);
    let current = true;
    const tool = credentialTool({ ...f, current: () => current });
    expect(tool.definitions.map((d) => d.name)).toEqual(["octant_credential"]);
    current = false;
    for (const inputJson of [
      JSON.stringify({ operation: "run-saved", id: f.binding.bindingId }),
      '{"operation":"list"}',
    ]) {
      expect(await tool.execute({ name: "octant_credential", inputJson })).toMatchObject({
        result: { status: "refused" },
        isError: true,
      });
    }
    const view = f.service.view(f.window);
    expect(view.kind === "command-credential-view" ? view.requests : undefined).toEqual([]);
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("uses the same human review for a provider-selected binding and refuses Plan for the person too", async () => {
    const f = await fixture();
    const tool = credentialTool(f);
    const running = tool.execute({
      name: "octant_credential",
      inputJson: JSON.stringify({ operation: "run-saved", id: f.binding.bindingId }),
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
    ).toMatchObject({ reason: "posture-unsupported" });
  });
  it("cancels a pending provider request when its tool lifetime ends", async () => {
    const f = await fixture();
    const tool = credentialTool(f);
    const pending = tool.execute({
      name: "octant_credential",
      inputJson: JSON.stringify({ operation: "run-saved", id: f.binding.bindingId }),
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
