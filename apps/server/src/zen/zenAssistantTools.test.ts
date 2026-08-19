import {
  decodeChatThreadId,
  decodeHostId,
  decodeProviderInstanceId,
  decodeWindowId,
  decodeZenThreadCatalogRef,
  LOCAL_HOST_ID,
  ZenError,
  type ChatThread,
  type ChatThreadView,
  type WindowId,
  type ZenFocusZone,
  type ZenSpace,
} from "@octant/contracts";
import { createZenSpace } from "@octant/domain";
import { describe, expect, it, vi } from "vitest";
import { ZenAssistantTools } from "./zenAssistantTools";
import { ZenService } from "./zenService";

/** Each window's focus zone, held only for the life of one test. */
function memoryFocusZone() {
  const byWindow = new Map<string, ZenFocusZone>();
  return {
    read: (windowId: WindowId) => byWindow.get(String(windowId)) ?? null,
    write: (next: ZenFocusZone) => {
      byWindow.set(String(next.windowId), next);
      return next;
    },
  };
}

const windowId = decodeWindowId("00000000-0000-4000-8000-000000000001");
const threadId = decodeChatThreadId("00000000-0000-4000-8000-000000000002");
const thread = {
  id: threadId,
  title: "Navigator",
  lifecycle: "active",
  providerInstanceId: decodeProviderInstanceId("00000000-0000-4000-8000-000000000003"),
  modelId: "model-local",
  researchEnabled: false,
  researchRouting: "automatic",
  personalityInstructions: "Help with Zen.",
  version: 1,
  createdAt: "2026-07-28T12:00:00.000Z",
  updatedAt: "2026-07-28T12:00:00.000Z",
} as unknown as ChatThread;

function fixture(isAssistant = true) {
  const spaceId = "00000000-0000-4000-8000-000000000004";
  const elementId = "00000000-0000-4000-8000-000000000005";
  const service = {
    isAssistantThread: vi.fn(() => isAssistant),
    searchThreads: vi.fn(async () => []),
    pinThread: vi.fn(),
    applyAssistantPlacement: vi.fn(),
    applyAssistantAppearance: vi.fn(),
    createTimerWidget: vi.fn(() => ({
      elementId: "00000000-0000-4000-8000-000000000008",
      space: { version: 3 },
    })),
    bootstrap: vi.fn(() => ({ space: { spaceId }, windowId })),
    handleCommand: vi.fn(() => ({
      result: "mutation",
      space: {
        version: 3,
        elements: [{ elementId, kind: "notes", widgetVersion: 0 }],
      },
    })),
  };
  return { service, tools: new ZenAssistantTools({ zenService: service as never }) };
}

/**
 * A real ZenService with one window's Zen assistant opened on the host's one
 * conversation, so the authority these tools rely on is the real predicate
 * rather than a stub that agrees with them.
 */
async function boundAssistantFixture() {
  const unboundWindowId = decodeWindowId("00000000-0000-4000-8000-000000000030");
  const conversation = thread;
  const otherConversation = {
    ...thread,
    id: decodeChatThreadId("00000000-0000-4000-8000-000000000034"),
  } as ChatThread;
  const spaces = new Map<string, ZenSpace>([
    [String(windowId), createZenSpace(windowId, decodeHostId(LOCAL_HOST_ID))],
    [String(unboundWindowId), createZenSpace(unboundWindowId, decodeHostId(LOCAL_HOST_ID))],
  ]);
  const zenService = new ZenService({
    focusZone: memoryFocusZone(),
    loadSpace: (spaceId) =>
      [...spaces.values()].find((candidate) => candidate.spaceId === spaceId) ?? null,
    loadSpaceByWindow: (id) => spaces.get(String(id)) ?? null,
    eventStore: {
      append: (next: ZenSpace, expectedVersion: number) => {
        const committed = { ...next, version: (expectedVersion + 1) as ZenSpace["version"] };
        spaces.set(String(committed.windowId), committed);
        return committed;
      },
      isConcurrencyConflict: () => false,
    } as never,
    localHostId: LOCAL_HOST_ID,
    uuid: () => "00000000-0000-4000-8000-000000000035",
    assistantChat: {
      create: async () => conversation,
      read: (id) =>
        String(id) === String(conversation.id)
          ? ({ thread: conversation, turns: [], contents: [] } as unknown as ChatThreadView)
          : undefined,
    },
    assistantProviderState: (candidate) => ({
      providerInstanceId: candidate.providerInstanceId,
      providerLabel: "Local provider",
      modelId: candidate.modelId,
      modelLabel: "Local model",
      readiness: "ready",
      toolCapability: "supported",
    }),
  });
  // Opening Zen's assistant is what binds this window's surface to the host's
  // conversation; nothing else grants a Zen tool.
  await zenService.ensureAssistant(windowId);
  return {
    conversation,
    otherConversation,
    unboundWindowId,
    zenService,
    version: (owner: WindowId) => spaces.get(String(owner))!.version,
  };
}

describe("ZenAssistantTools", () => {
  it("offers the bounded Zen vocabulary only to the exact bound assistant thread", () => {
    const exact = fixture(true);
    const ordinary = fixture(false);

    expect(exact.tools.forThread(windowId, thread)?.definitions.map(({ name }) => name)).toEqual([
      "octant_zen_search_threads",
      "octant_zen_pin_thread",
      "octant_zen_list_widgets",
      "octant_zen_create_widget",
      "octant_zen_preview_recipe",
      "octant_zen_place_element",
      "octant_zen_update_appearance",
    ]);
    expect(ordinary.tools.forThread(windowId, thread)).toBeUndefined();
  });

  it("reports Notes, Checklist, and Timer as available across the integrated Zen D slices", async () => {
    const { tools } = fixture(true);
    const result = await tools.forThread(windowId, thread)!.execute({
      name: "octant_zen_list_widgets",
      inputJson: "{}",
    });

    expect(result.result).toMatchObject({
      action: "list-widgets",
      status: "ok",
      widgets: expect.arrayContaining([{ kind: "timer", available: true }]),
    });
  });

  it("rejects forged authority fields before catalog search", async () => {
    const { service, tools } = fixture(true);
    const toolSet = tools.forThread(windowId, thread)!;

    const result = await toolSet.execute({
      name: "octant_zen_search_threads",
      inputJson: JSON.stringify({ query: "release", windowId, spaceId: "forged" }),
    });

    expect(result).toMatchObject({
      isError: true,
      result: { status: "failed", code: "invalid-input" },
    });
    expect(service.searchThreads).not.toHaveBeenCalled();
  });

  it("returns structured conflict, Timer success, and sibling-widget unavailability", async () => {
    const { service, tools } = fixture(true);
    service.pinThread.mockRejectedValueOnce(new ZenError({ reason: "stale-version" }));
    const toolSet = tools.forThread(windowId, thread)!;
    const catalogRef = decodeZenThreadCatalogRef(`chat:${threadId}`);

    const conflict = await toolSet.execute({
      name: "octant_zen_pin_thread",
      inputJson: JSON.stringify({ catalogRef, expectedVersion: 2 }),
    });
    const created = await toolSet.execute({
      name: "octant_zen_create_widget",
      inputJson: JSON.stringify({ kind: "timer", durationMs: 40 * 60 * 1000, expectedVersion: 2 }),
    });
    const unsupported = await toolSet.execute({
      name: "octant_zen_create_widget",
      inputJson: JSON.stringify({ kind: "reference", expectedVersion: 3 }),
    });

    expect(conflict).toMatchObject({
      isError: true,
      result: { action: "pin-thread", status: "conflict", code: "stale-version" },
    });
    expect(created).toMatchObject({
      result: {
        action: "create-widget",
        status: "ok",
        kind: "timer",
        elementId: "00000000-0000-4000-8000-000000000008",
        version: 3,
      },
    });
    expect(service.createTimerWidget).toHaveBeenCalledWith(windowId, 40 * 60 * 1000, 2);
    expect(unsupported).toMatchObject({
      isError: true,
      result: { action: "create-widget", status: "unavailable", kind: "reference" },
    });
  });

  it("lists and creates the available D1 widgets without widening authority", async () => {
    const { service, tools } = fixture(true);
    const toolSet = tools.forThread(windowId, thread)!;

    const listed = await toolSet.execute({
      name: "octant_zen_list_widgets",
      inputJson: "{}",
    });
    const created = await toolSet.execute({
      name: "octant_zen_create_widget",
      inputJson: JSON.stringify({ kind: "notes", expectedVersion: 2 }),
    });

    expect(listed.result).toMatchObject({
      status: "ok",
      widgets: expect.arrayContaining([
        { kind: "notes", available: true },
        { kind: "checklist", available: true },
        { kind: "timer", available: true },
      ]),
    });
    expect(created).toMatchObject({
      result: {
        action: "create-widget",
        status: "ok",
        kind: "notes",
        elementId: "00000000-0000-4000-8000-000000000005",
        version: 3,
      },
    });
    expect(service.handleCommand).toHaveBeenCalledWith(
      {
        command: "create-widget",
        spaceId: "00000000-0000-4000-8000-000000000004",
        kind: "notes",
        expectedVersion: 2,
      },
      windowId,
      undefined,
    );
  });

  it("proposes a recipe on the window's own assistant surface and on nothing else", async () => {
    const { zenService, conversation, otherConversation, version } = await boundAssistantFixture();
    const tools = new ZenAssistantTools({ zenService });

    const proposal = await tools.forThread(windowId, conversation)!.execute({
      name: "octant_zen_preview_recipe",
      inputJson: JSON.stringify({
        expectedVersion: version(windowId),
        recipe: {
          recipeId: "00000000-0000-4000-8000-000000000031",
          name: "Release focus",
          primitives: ["checklist"],
          fields: [],
        },
      }),
    });

    expect(proposal).toMatchObject({
      result: {
        action: "preview-recipe",
        status: "ok",
        preview: { recipe: { name: "Release focus" } },
      },
    });
    // The same host serves this conversation to every window, and it is not
    // this window's assistant surface, so it is given no Zen vocabulary at all.
    expect(tools.forThread(windowId, otherConversation)).toBeUndefined();
    expect(() =>
      zenService.previewRecipe(windowId, otherConversation.id, {
        expectedVersion: version(windowId),
        recipe: {
          recipeId: "00000000-0000-4000-8000-000000000032" as never,
          name: "Forged focus",
          primitives: ["checklist"],
          fields: [],
        },
      }),
    ).toThrow(/missing-capability/);
  });

  it("gives no Zen vocabulary to a window that never opened a Zen assistant", async () => {
    const { zenService, conversation, unboundWindowId, version } = await boundAssistantFixture();
    const tools = new ZenAssistantTools({ zenService });

    expect(tools.forThread(unboundWindowId, conversation)).toBeUndefined();
    expect(() =>
      zenService.previewRecipe(unboundWindowId, conversation.id, {
        expectedVersion: version(unboundWindowId),
        recipe: {
          recipeId: "00000000-0000-4000-8000-000000000033" as never,
          name: "Forged focus",
          primitives: ["checklist"],
          fields: [],
        },
      }),
    ).toThrow(/missing-capability/);
  });

  it("does not execute an interrupted tool request", async () => {
    const { service, tools } = fixture(true);
    const controller = new AbortController();
    controller.abort();

    const result = await tools.forThread(windowId, thread)!.execute({
      name: "octant_zen_search_threads",
      inputJson: JSON.stringify({ query: "release" }),
      signal: controller.signal,
    });

    expect(result).toMatchObject({ isError: true, result: { status: "interrupted" } });
    expect(service.searchThreads).not.toHaveBeenCalled();
  });

  it("returns an interrupted result when pin authorization is cancelled", async () => {
    const { service, tools } = fixture(true);
    service.pinThread.mockRejectedValueOnce(new ZenError({ reason: "interrupted" }));
    const controller = new AbortController();
    const catalogRef = decodeZenThreadCatalogRef(`chat:${threadId}`);

    const result = await tools.forThread(windowId, thread)!.execute({
      name: "octant_zen_pin_thread",
      inputJson: JSON.stringify({ catalogRef, expectedVersion: 2 }),
      signal: controller.signal,
    });

    expect(result).toMatchObject({
      isError: true,
      result: { action: "pin-thread", status: "interrupted", code: "interrupted" },
    });
  });
});
