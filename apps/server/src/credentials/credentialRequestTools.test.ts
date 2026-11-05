import { decodeCodeThread, type CodeThread } from "@octant/contracts";
import type { CredentialOperation } from "@octant/plugin-api/credential-request";
import { describe, expect, it } from "vitest";
import { CredentialRequests } from "./credentialRequests";
import { registeredCredentialOperations } from "./credentialRequestTools";
import { createCredentialTool, type CredentialToolSource } from "./credentialTool";
import { linearCredentialOperation } from "../plugins/linear/linearCredentialOperation";
const now = "2026-11-03T12:00:00.000Z";
function codeThread(overrides: Record<string, unknown> = {}): CodeThread {
  return decodeCodeThread({
    id: "20000000-0000-4000-8000-000000000001",
    projectId: "40000000-0000-4000-8000-000000000001",
    bindingRevisionId: "70000000-0000-4000-8000-000000000001",
    repositoryId: `repo_${"a".repeat(64)}`,
    checkoutId: "30000000-0000-4000-8000-000000000001",
    title: "Language reads",
    lifecycle: "active",
    providerInstanceId: "60000000-0000-4000-8000-000000000001",
    modelId: "model-a",
    executionPolicy: "approval-gated",
    permissionPersistence: "current-session",
    deliveryTarget: {
      branchIntent: "feature/language",
      remoteName: "origin",
      proposedBaseRepository: "octant/octant",
      proposedBaseBranch: "main",
      outcomeKind: "local-implementation",
      confirmedAt: now,
    },
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

/** A thread with no saved credential command. */
const nothingSaved: CredentialToolSource<never> = {
  offered: false,
  list: () => [],
  use: async () => ({ result: { status: "unexpected" }, isError: true }),
  close: async () => undefined,
};

function credentialTool(input: {
  readonly service: CredentialRequests;
  readonly thread?: CodeThread;
  readonly current?: CodeThread;
  readonly operations?: () => ReadonlyArray<CredentialOperation>;
  readonly windowCurrent?: () => boolean;
}) {
  const thread = input.thread ?? codeThread();
  return createCredentialTool({
    registered: registeredCredentialOperations({
      service: input.service,
      windowId: "window",
      thread,
      readThread: () => input.current ?? thread,
      operations: input.operations ?? (() => [linearCredentialOperation]),
      windowCurrent: input.windowCurrent ?? (() => true),
    }),
    saved: nothingSaved,
  });
}

describe("credential tool: registered operations", () => {
  it("is not offered when no operation is registered and no command is saved", async () => {
    const service = new CredentialRequests();
    const tools = credentialTool({ service, operations: () => [] });
    expect(tools.definitions).toEqual([]);
    expect(
      await tools.execute({ name: "octant_credential", inputJson: '{"operation":"list"}' }),
    ).toMatchObject({ result: { status: "refused" }, isError: true });
    service.close();
  });
  it("offers octant_credential with request, and no longer answers to the removed tool names", async () => {
    const service = new CredentialRequests();
    const thread = codeThread();
    const tools = credentialTool({ service, thread });
    expect(tools.definitions.map((d) => d.name)).toEqual(["octant_credential"]);
    expect(tools.definitions[0]?.inputSchema).toMatchObject({
      properties: { operation: { enum: ["help", "list", "request"] } },
    });
    for (const name of ["request_credential", "octant_command"]) {
      expect(
        await tools.execute({ name, inputJson: '{"operation":"linear-account-check"}' }),
      ).toMatchObject({ isError: true });
    }
    expect(service.view("window", String(thread.id)).requests).toEqual([]);
    const help = await tools.execute({
      name: "octant_credential",
      inputJson: '{"operation":"help"}',
    });
    expect(help).toMatchObject({ isError: false, result: { tool: "octant_credential" } });
    expect(JSON.stringify(help.result)).toContain("use the terminal or shell");
    service.close();
  });
  it("lists registered operations by name and reason, never their destination request", async () => {
    const service = new CredentialRequests();
    const tools = credentialTool({ service });
    const listed = await tools.execute({
      name: "octant_credential",
      inputJson: '{"operation":"list"}',
    });
    expect(listed).toEqual({
      isError: false,
      result: {
        operations: [
          {
            id: "linear-account-check",
            label: linearCredentialOperation.label,
            reason: linearCredentialOperation.reason,
          },
        ],
        savedCommands: [],
      },
    });
    expect(JSON.stringify(listed)).not.toContain("api.linear.app");
    service.close();
  });
  it("opens the private request and cancels it when the turn closes", async () => {
    const service = new CredentialRequests();
    const thread = codeThread();
    const tools = credentialTool({ service, thread });
    const pending = tools.execute({
      name: "octant_credential",
      inputJson: '{"operation":"request","id":"linear-account-check"}',
    });
    expect(service.view("window", String(thread.id)).requests).toHaveLength(1);
    await tools.close?.();
    expect(await pending).toMatchObject({ result: { status: "cancelled" } });
    service.close();
  });
  it("offers a registered integration operation and cancels it when withdrawn", async () => {
    const service = new CredentialRequests();
    const thread = codeThread();
    const operation = { ...linearCredentialOperation, id: "example-check" };
    let registered = true;
    const tools = credentialTool({
      service,
      thread,
      operations: () => (registered ? [operation] : []),
    });
    const pending = tools.execute({
      name: "octant_credential",
      inputJson: '{"operation":"request","id":"example-check"}',
    });
    expect(service.view("window", String(thread.id)).requests).toHaveLength(1);
    registered = false;
    expect(service.view("window", String(thread.id)).requests[0]?.state).toBe("cancelled");
    expect(await pending).toMatchObject({ result: { status: "cancelled" } });
    await tools.close?.();
    service.close();
  });
  it("refuses run-saved when the tool was offered only for a registered operation", async () => {
    const service = new CredentialRequests();
    const tools = credentialTool({ service });
    expect(
      await tools.execute({
        name: "octant_credential",
        inputJson: '{"operation":"run-saved","id":"anything"}',
      }),
    ).toMatchObject({ result: { status: "refused" }, isError: true });
    service.close();
  });
  it.each(["plan", "disabled", "window", "rebound", "profile", "removed-name-profile"] as const)(
    "refuses the %s boundary",
    async (boundary) => {
      const service = new CredentialRequests();
      const thread = codeThread();
      const current =
        boundary === "plan"
          ? codeThread({ executionPolicy: "plan" })
          : boundary === "profile"
            ? codeThread({ toolConstraints: ["other-tool"] })
            : boundary === "removed-name-profile"
              ? codeThread({ toolConstraints: ["request_credential", "octant_command"] })
              : boundary === "rebound"
                ? codeThread({ bindingRevisionId: "70000000-0000-4000-8000-000000000002" })
                : thread;
      const tools = credentialTool({
        service,
        thread,
        current,
        operations: () => (boundary === "disabled" ? [] : [linearCredentialOperation]),
        windowCurrent: () => boundary !== "window",
      });
      expect(tools.definitions).toEqual([]);
      expect(
        await tools.execute({
          name: "octant_credential",
          inputJson: '{"operation":"request","id":"linear-account-check"}',
        }),
      ).toMatchObject({ result: { status: "refused" }, isError: true });
      expect(service.view("window", String(thread.id)).requests).toEqual([]);
      service.close();
    },
  );
  it("refuses a request once the thread enters Plan mid-turn", async () => {
    const service = new CredentialRequests();
    const thread = codeThread();
    let current = thread;
    const tools = createCredentialTool({
      registered: registeredCredentialOperations({
        service,
        windowId: "window",
        thread,
        readThread: () => current,
        operations: () => [linearCredentialOperation],
        windowCurrent: () => true,
      }),
      saved: nothingSaved,
    });
    expect(tools.definitions.map((d) => d.name)).toEqual(["octant_credential"]);
    current = codeThread({ executionPolicy: "plan" });
    expect(
      await tools.execute({
        name: "octant_credential",
        inputJson: '{"operation":"request","id":"linear-account-check"}',
      }),
    ).toMatchObject({ result: { status: "refused" }, isError: true });
    expect(
      await tools.execute({ name: "octant_credential", inputJson: '{"operation":"list"}' }),
    ).toMatchObject({ result: { status: "refused" }, isError: true });
    expect(service.view("window", String(thread.id)).requests).toEqual([]);
    service.close();
  });
});
