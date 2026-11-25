import { describe, expect, it, vi } from "vitest";
import { createProjectMemoryAccess } from "../projectMemory/projectMemoryAccess";
import { isRoutineHostScope } from "../routineHostScope";
import {
  childComputerTools,
  childCredentialTools,
  childImageTools,
  childMemoryTools,
} from "./agentRunChildAskTools";
import { AgentRunChildResources } from "./agentRunChildTools";
import {
  CHILD_PARENT,
  CHILD_RUN,
  CHILD_WINDOW,
  childHost,
} from "./agentRunChildTools.test-support";

const call = (name: string, body: unknown) => ({ name, inputJson: JSON.stringify(body) });

describe("a child's Project memory", () => {
  function memory(allowsUnasked = false) {
    const executeAgentMemory = vi.fn(async (_command: unknown, _origin: unknown) => ({
      entry: { id: "e", status: "active", content: "Ship on Fridays." },
    }));
    return {
      executeAgentMemory,
      access: createProjectMemoryAccess({
        projects: { executeAgentMemory } as never,
        readMemory: () => ({ active: [], history: [] }) as never,
        agentsWriteWithoutAsking: () => allowsUnasked,
        isHostScope: isRoutineHostScope,
        isPairedDeviceScope: () => false,
        outsideContent: () => undefined,
        uuid: () => crypto.randomUUID(),
        now: Date.now,
      }),
    };
  }
  const create = call("octant_memory", {
    operation: "create",
    memoryKind: "decision",
    content: "Ship on Fridays.",
  });

  it("is offered in a Project in every mode and not outside one", () => {
    for (const mode of ["work", "code"] as const)
      expect(
        childMemoryTools({ host: childHost({ mode }), memory: memory().access })?.definitions,
      ).toHaveLength(1);
    expect(
      childMemoryTools({ host: childHost({ mode: "chat" }), memory: memory().access }),
    ).toBeUndefined();
  });

  it("lists in Plan and under a routine, and refuses there what would need a person", async () => {
    for (const host of [childHost({ policy: "plan" }), childHost({ attended: false })]) {
      const { access, executeAgentMemory } = memory();
      const tools = childMemoryTools({ host, memory: access });
      expect(
        (await tools?.execute(call("octant_memory", { operation: "list" })))?.isError,
      ).not.toBe(true);
      expect(await tools?.execute(create)).toMatchObject({ isError: true });
      expect(executeAgentMemory).not.toHaveBeenCalled();
      expect(access.proposals.list(CHILD_WINDOW as never)).toEqual([]);
    }
  });

  it("asks in the parent's thread below Full access, and names the run when nobody is asked", async () => {
    const asked = memory();
    const pending = childMemoryTools({ host: childHost(), memory: asked.access })?.execute(create);
    const [proposal] = asked.access.proposals.list(CHILD_WINDOW as never);
    expect(proposal).toMatchObject({ threadId: CHILD_PARENT });
    asked.access.proposals.close();
    expect(await pending).toMatchObject({ isError: true });

    const unasked = memory();
    await childMemoryTools({
      host: childHost({ policy: "full-access" }),
      memory: unasked.access,
    })?.execute(create);
    expect(unasked.executeAgentMemory.mock.calls[0]?.[1]).toMatchObject({
      threadId: CHILD_RUN,
      unconfirmed: true,
    });
  });
});

describe("a child's image generation", () => {
  const instance = {
    id: "55555555-5555-4555-8555-555555555555",
    enabled: true,
    displayName: "Pictures",
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
    driverKind: "openai-image",
    configuration: {
      kind: "openai-image-http",
      modelAllowlist: ["gpt-image-2"],
      defaultModel: "gpt-image-2",
    },
  };
  const input = (overrides: Parameters<typeof childHost>[0] = {}) => ({
    host: childHost(overrides),
    offers: { offer: vi.fn(async () => ({ status: "cancelled" as const })) } as never,
    kept: {
      remembered: () => undefined,
      forget: () => undefined,
      asksAgain: () => false,
    } as never,
    jobs: {
      enqueue: vi.fn(),
      listByScope: () => [],
      whenTerminal: vi.fn(),
      readArtifact: vi.fn(),
    } as never,
    listInstances: () => [instance] as never,
    readImageGenerationCustomSources: () => [],
    readsImages: () => false,
    saveUnder: () => async () => ({ status: "saved", relativePath: "a.png" }) as never,
  });

  it("is withheld from Plan, from Chat, and where nobody can answer its card", () => {
    expect(childImageTools(input({ policy: "plan" }))).toBeUndefined();
    expect(childImageTools(input({ mode: "chat" }))).toBeUndefined();
    expect(childImageTools(input({ attended: false }))).toBeUndefined();
  });

  it("is offered only while an image profile is eligible", () => {
    expect(childImageTools({ ...input(), listInstances: () => [] })).toBeUndefined();
    for (const mode of ["work", "code"] as const)
      expect(childImageTools(input({ mode }))?.definitions.map((tool) => tool.name)).toEqual([
        "octant_create_image",
      ]);
  });

  it("asks on the parent's card, and starts nothing the person declined", async () => {
    const child = input();
    const tools = childImageTools(child);
    await tools?.execute(call("octant_create_image", { prompt: "A lighthouse" }));
    expect((child.offers as { offer: ReturnType<typeof vi.fn> }).offer).toHaveBeenCalledWith(
      expect.objectContaining({
        windowId: CHILD_WINDOW,
        offer: expect.objectContaining({ scopeId: CHILD_PARENT, threadKind: "code-thread" }),
      }),
    );
    expect((child.jobs as { enqueue: ReturnType<typeof vi.fn> }).enqueue).not.toHaveBeenCalled();
  });

  it("cannot save or revise a picture it did not make", async () => {
    const child = input();
    const tools = childImageTools({
      ...child,
      jobs: {
        ...(child.jobs as object),
        listByScope: () => [
          {
            id: "a0000000-0000-4000-8000-000000000001",
            status: "completed",
            threadKind: "code-thread",
            artifacts: [{ attachmentId: "a0000000-0000-4000-8000-000000000002" }],
          },
        ],
      } as never,
    });
    expect(
      await tools?.execute(
        call("octant_create_image", {
          operation: "save",
          attachmentId: "a0000000-0000-4000-8000-000000000002",
          relativePath: "a.png",
        }),
      ),
    ).toMatchObject({ isError: true });
  });
});

describe("a child's credentials", () => {
  const thread = {
    id: CHILD_PARENT,
    projectId: "77777777-7777-4777-8777-777777777777",
    lifecycle: "active",
    executionPolicy: "full-access",
    providerInstanceId: "p",
    modelId: "m",
    checkoutId: "c",
    bindingRevisionId: "b",
  } as never;
  const operation = {
    id: "deploy",
    label: "Deploy token",
    reason: "To deploy",
    consumer: "Deploy",
    actionLabel: "Use",
    request: { url: "https://example.com", method: "GET" },
  } as never;
  const input = (overrides: Parameters<typeof childHost>[0] = {}) => ({
    host: childHost(overrides),
    service: { request: vi.fn(async () => ({ status: "declined" as const })) } as never,
    operations: () => [operation],
    readParent: () => thread,
    windowCurrent: () => true,
  });

  it("are registered operations on a card of the parent's, and nothing that returns a value", async () => {
    const child = input();
    const tools = childCredentialTools(child);
    expect(tools?.definitions[0]?.inputSchema).toMatchObject({
      properties: { operation: { enum: ["help", "list", "request"] } },
    });
    expect(
      await tools?.execute(call("octant_credential", { operation: "run-saved", id: "deploy" })),
    ).toMatchObject({ isError: true });
    expect(
      await tools?.execute(call("octant_credential", { operation: "request", id: "deploy" })),
    ).toMatchObject({ isError: true, result: { status: "declined" } });
    expect((child.service as { request: ReturnType<typeof vi.fn> }).request).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: CHILD_PARENT, windowId: CHILD_WINDOW }),
    );
  });

  it("are withheld in Plan, outside Code, under a routine, and with nothing registered", () => {
    expect(childCredentialTools(input({ policy: "plan" }))).toBeUndefined();
    expect(childCredentialTools(input({ mode: "work" }))).toBeUndefined();
    expect(childCredentialTools(input({ attended: false }))).toBeUndefined();
    expect(childCredentialTools({ ...input(), operations: () => [] })).toBeUndefined();
  });
});

describe("a child's Computer use", () => {
  it("is withheld where nobody can answer, and stops with the run", async () => {
    const execute = vi.fn(async (_call: { inputJson: string }) => ({ result: "done" }));
    const tools = { definitions: [{ name: "octant_computer", inputSchema: {} }], execute };
    const resources = new AgentRunChildResources();
    expect(
      childComputerTools({ host: childHost({ attended: false }), resources, tools }),
    ).toBeUndefined();
    expect(
      childComputerTools({ host: childHost({ policy: "plan" }), resources, tools }),
    ).toBeUndefined();
    expect(childComputerTools({ host: childHost(), resources, tools: undefined })).toBeUndefined();
    const child = childComputerTools({ host: childHost(), resources, tools });
    await child?.execute(call("octant_computer", { operation: "apps" }));
    await child?.close?.();
    expect(execute.mock.calls.map(([entry]) => entry.inputJson)).toEqual([
      '{"operation":"apps"}',
      '{"operation":"stop"}',
    ]);
  });
});
