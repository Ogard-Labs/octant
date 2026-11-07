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
  type ZenElementId,
  type ZenFocusZone,
  type ZenSpace,
} from "@octant/contracts";
import { createZenSpace } from "@octant/domain";
import { describe, expect, it, vi } from "vitest";
import { ZenAssistantTools } from "./zenAssistantTools";
import { zenLayoutOf, type ZenLayoutSnapshot } from "./zenLayoutReadPort";
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
    // create-widget still reads the space id through the host; the layout
    // read goes through the bounded port below, never through this.
    bootstrap: vi.fn(() => ({ space: { spaceId, version: 4 }, windowId })),
    handleCommand: vi.fn(() => ({
      result: "mutation",
      space: {
        version: 3,
        elements: [{ elementId, kind: "notes", widgetVersion: 0 }],
      },
    })),
  };
  const zenLayout = {
    layout: vi.fn(
      (): ZenLayoutSnapshot => ({
        status: "ok",
        version: 4 as ZenSpace["version"],
        dimming: 20,
        elementOpacity: 0.9,
        elements: [
          {
            elementId: elementId as ZenElementId,
            kind: "notes",
            title: "Release notes",
            geometry: { x: 10, y: 20, width: 400, height: 300 },
            zIndex: 1,
            minimized: false,
          },
        ],
      }),
    ),
  };
  return {
    service,
    zenLayout,
    tools: new ZenAssistantTools({ zenService: service as never, zenLayout }),
  };
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
  it("offers no tool while the Zen plugin is off, and the same tool once it is on again", () => {
    const { service, zenLayout } = fixture(true);
    let effective = false;
    const tools = new ZenAssistantTools({
      zenService: service as never,
      zenLayout,
      isEffective: () => effective,
    });
    expect(tools.forThread(windowId, thread)).toBeUndefined();
    effective = true;
    expect(tools.forThread(windowId, thread)?.definitions.map(({ name }) => name)).toEqual([
      "octant_zen",
    ]);
  });

  it("offers one octant_zen tool, and only to the exact bound assistant thread", () => {
    const exact = fixture(true);
    const ordinary = fixture(false);

    const definitions = exact.tools.forThread(windowId, thread)?.definitions ?? [];
    expect(definitions.map(({ name }) => name)).toEqual(["octant_zen"]);
    expect(definitions[0]?.description).toMatch(/get-space/);
    expect(ordinary.tools.forThread(windowId, thread)).toBeUndefined();
  });

  it("no longer offers the seven separate Zen tool names", async () => {
    const { service, tools } = fixture(true);
    const toolSet = tools.forThread(windowId, thread)!;
    const names = toolSet.definitions.map(({ name }) => name);

    for (const retired of [
      "octant_zen_search_threads",
      "octant_zen_pin_thread",
      "octant_zen_list_widgets",
      "octant_zen_create_widget",
      "octant_zen_preview_recipe",
      "octant_zen_place_element",
      "octant_zen_update_appearance",
    ]) {
      expect(names).not.toContain(retired);
      expect(
        await toolSet.execute({ name: retired, inputJson: JSON.stringify({ query: "x" }) }),
      ).toMatchObject({ isError: true, result: { status: "unsupported" } });
    }
    expect(service.searchThreads).not.toHaveBeenCalled();
  });

  it("offers only the widget kinds it can create, with no unavailable kinds or kind listing", async () => {
    const { service, tools } = fixture(true);
    const toolSet = tools.forThread(windowId, thread)!;
    const schema = toolSet.definitions[0]?.inputSchema as {
      readonly properties: {
        readonly operation: { readonly enum: ReadonlyArray<string> };
        readonly kind: { readonly enum: ReadonlyArray<string> };
      };
    };

    expect(schema.properties.kind.enum).toEqual(["notes", "checklist", "timer"]);
    expect(schema.properties.operation.enum).not.toContain("list-widgets");
    for (const kind of ["reference", "recipe"]) {
      const refused = await toolSet.execute({
        name: "octant_zen",
        inputJson: JSON.stringify({ operation: "create-widget", kind, expectedVersion: 3 }),
      });
      expect(refused).toMatchObject({
        isError: true,
        result: { action: "create-widget", status: "failed", code: "invalid-input" },
      });
    }
    expect(
      await toolSet.execute({
        name: "octant_zen",
        inputJson: JSON.stringify({ operation: "list-widgets" }),
      }),
    ).toMatchObject({ isError: true, result: { status: "unsupported" } });
    expect(service.handleCommand).not.toHaveBeenCalled();
  });

  it("reads the space's version and element ids through the layout port alone", async () => {
    const { service, zenLayout, tools } = fixture(true);

    const read = await tools.forThread(windowId, thread)!.execute({
      name: "octant_zen",
      inputJson: JSON.stringify({ operation: "get-space" }),
    });

    expect(read).toEqual({
      result: {
        action: "get-space",
        status: "ok",
        version: 4,
        dimming: 20,
        elementOpacity: 0.9,
        elements: [
          {
            elementId: "00000000-0000-4000-8000-000000000005",
            kind: "notes",
            title: "Release notes",
            geometry: { x: 10, y: 20, width: 400, height: 300 },
            zIndex: 1,
            minimized: false,
          },
        ],
      },
    });
    expect(zenLayout.layout).toHaveBeenCalledWith(windowId);
    expect(service.bootstrap).not.toHaveBeenCalled();
  });

  it("refuses get-space when the window has no Zen space", async () => {
    const { zenLayout, tools } = fixture(true);
    zenLayout.layout.mockReturnValueOnce({ status: "refused", reason: "unknown-space" });

    const read = await tools.forThread(windowId, thread)!.execute({
      name: "octant_zen",
      inputJson: JSON.stringify({ operation: "get-space" }),
    });

    expect(read).toMatchObject({
      isError: true,
      result: { action: "get-space", status: "failed", code: "unknown-space" },
    });
  });

  it("projects a space's layout without what any element says", () => {
    const space = {
      ...createZenSpace(windowId, decodeHostId(LOCAL_HOST_ID)),
      elements: [
        {
          elementId: "00000000-0000-4000-8000-000000000005",
          kind: "notes",
          title: "Release notes",
          geometry: { x: 10, y: 20, width: 400, height: 300 },
          zIndex: 1,
          minimized: false,
          body: "Private draft the layout read must not carry.",
        },
      ],
    } as unknown as ZenSpace;

    const snapshot = zenLayoutOf(space);

    expect(snapshot).toMatchObject({ status: "ok", elements: [{ title: "Release notes" }] });
    expect(JSON.stringify(snapshot)).not.toMatch(/Private draft/);
    expect(zenLayoutOf(null)).toEqual({ status: "refused", reason: "unknown-space" });
  });

  it("answers help with full usage without touching the space", async () => {
    const { service, zenLayout, tools } = fixture(true);

    const help = await tools.forThread(windowId, thread)!.execute({
      name: "octant_zen",
      inputJson: JSON.stringify({ operation: "help" }),
    });

    expect(help).toMatchObject({ isError: false, result: { tool: "octant_zen" } });
    expect(JSON.stringify(help.result)).toMatch(/conflict/);
    expect(service.bootstrap).not.toHaveBeenCalled();
    expect(zenLayout.layout).not.toHaveBeenCalled();
  });

  it("rejects forged authority fields before catalog search", async () => {
    const { service, tools } = fixture(true);
    const toolSet = tools.forThread(windowId, thread)!;

    const result = await toolSet.execute({
      name: "octant_zen",
      inputJson: JSON.stringify({
        operation: "search-threads",
        query: "release",
        windowId,
        spaceId: "forged",
      }),
    });

    expect(result).toMatchObject({
      isError: true,
      result: { status: "failed", code: "invalid-input" },
    });
    expect(service.searchThreads).not.toHaveBeenCalled();
  });

  it("returns a conflict that names the space's current version, and Timer success", async () => {
    const { service, tools } = fixture(true);
    service.pinThread.mockRejectedValueOnce(new ZenError({ reason: "stale-version" }));
    const toolSet = tools.forThread(windowId, thread)!;
    const catalogRef = decodeZenThreadCatalogRef(`chat:${threadId}`);

    const conflict = await toolSet.execute({
      name: "octant_zen",
      inputJson: JSON.stringify({ operation: "pin-thread", catalogRef, expectedVersion: 2 }),
    });
    const created = await toolSet.execute({
      name: "octant_zen",
      inputJson: JSON.stringify({
        operation: "create-widget",
        kind: "timer",
        durationMs: 40 * 60 * 1000,
        expectedVersion: 2,
      }),
    });

    expect(conflict).toMatchObject({
      isError: true,
      result: { action: "pin-thread", status: "conflict", code: "stale-version", version: 4 },
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
    // The conflict's current version comes from the layout read, not the host's bootstrap.
    expect(service.bootstrap).not.toHaveBeenCalled();
  });

  it("creates a Notes widget in the window's own space without widening authority", async () => {
    const { service, tools } = fixture(true);
    const toolSet = tools.forThread(windowId, thread)!;

    const created = await toolSet.execute({
      name: "octant_zen",
      inputJson: JSON.stringify({ operation: "create-widget", kind: "notes", expectedVersion: 2 }),
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
    const tools = new ZenAssistantTools({
      zenService,
      zenLayout: { layout: (id) => zenLayoutOf(zenService.bootstrap(id).space) },
    });

    const proposal = await tools.forThread(windowId, conversation)!.execute({
      name: "octant_zen",
      inputJson: JSON.stringify({
        operation: "preview-recipe",
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
    const tools = new ZenAssistantTools({
      zenService,
      zenLayout: { layout: (id) => zenLayoutOf(zenService.bootstrap(id).space) },
    });

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
      name: "octant_zen",
      inputJson: JSON.stringify({ operation: "search-threads", query: "release" }),
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
      name: "octant_zen",
      inputJson: JSON.stringify({ operation: "pin-thread", catalogRef, expectedVersion: 2 }),
      signal: controller.signal,
    });

    expect(result).toMatchObject({
      isError: true,
      result: { action: "pin-thread", status: "interrupted", code: "interrupted" },
    });
  });
});
