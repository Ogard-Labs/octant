import {
  decodeChatThreadId,
  decodeNavigatorAssistantModelRef,
  LOCAL_HOST_ID,
  type ChatThreadId,
  type NavigatorAssistantSettings,
  type WindowId,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import type { NavigatorAssistantBindingStore } from "./navigatorAssistantBindingStore";
import { createNavigatorAssistantRouteHandler } from "./navigatorAssistantRoutes";
import {
  NavigatorAssistantService,
  type NavigatorAssistantChatPort,
} from "./navigatorAssistantService";

const capability = { "x-octant-window-capability": "C".repeat(43) };
const threadId = decodeChatThreadId("9e000000-0000-4000-8000-0000000000cc");
const configured = decodeNavigatorAssistantModelRef({
  providerInstanceId: "9e000000-0000-4000-8000-0000000000b1",
  modelId: "model-a",
});

// `WindowAuthorityStore.authenticate` returns the WindowId itself, not an
// object wrapping it. A fake that answers `{ windowId: "w1" }` would make the
// route see `[object Object]` as the authenticated window — exactly the fixture
// drift that hides an authorization bug.
function authStore(): WindowAuthorityStore {
  return {
    authenticate: vi.fn((presented: string) => {
      if (presented !== capability["x-octant-window-capability"]) {
        throw new WindowAuthorityError("unauthorized", "Window capability is unknown.");
      }
      return "11111111-1111-4111-8111-111111111111";
    }),
  } as unknown as WindowAuthorityStore;
}

function bindingStore(): NavigatorAssistantBindingStore {
  let bound: ReturnType<typeof decodeChatThreadId> | undefined;
  return {
    read: () => bound,
    bind: ({ threadId: next }) => (bound ??= next),
    hiddenThreadIds: () => (bound === undefined ? new Set() : new Set([String(bound)])),
  };
}

function chatPort(): NavigatorAssistantChatPort {
  let created: ChatThreadId | undefined;
  let version = 1;
  let providerInstanceId = configured.providerInstanceId;
  let modelId = configured.modelId;
  return {
    create: async (input) => {
      created = input.threadId;
    },
    read: (requested) =>
      created === undefined || String(requested) !== String(created)
        ? undefined
        : {
            threadId: created,
            version: version as never,
            lifecycle: "active",
            providerInstanceId,
            modelId,
            transcript: [],
          },
    selectModel: async (input) => {
      version += 1;
      providerInstanceId = input.providerInstanceId;
      modelId = input.modelId;
    },
    send: async () => {},
  };
}

function handler(input: {
  readonly settings: NavigatorAssistantSettings;
  readonly authorized: boolean;
}) {
  const authorizeWindow = vi.fn((_target: { readonly windowId: WindowId }) => input.authorized);
  const service = new NavigatorAssistantService({
    localHostId: LOCAL_HOST_ID,
    readSettings: () => input.settings,
    bindings: bindingStore(),
    chat: chatPort(),
    modelFacts: () => undefined,
    clock: () => "2026-08-15T09:00:00.000Z",
    uuid: () => String(threadId),
  });
  return {
    authorizeWindow,
    handle: createNavigatorAssistantRouteHandler({
      service,
      windowAuthorityStore: authStore(),
      authorizeWindow,
    }),
  };
}

function snapshotRequest(): Request {
  return new Request("http://127.0.0.1/api/navigator-assistant/snapshot", { headers: capability });
}

function commandRequest(body: unknown): Request {
  return new Request("http://127.0.0.1/api/navigator-assistant/commands", {
    method: "POST",
    headers: { "content-type": "application/json", ...capability },
    body: JSON.stringify(body),
  });
}

describe("navigator assistant routes", () => {
  it("refuses a window the host does not authorize, before reaching the service", async () => {
    const { handle, authorizeWindow } = handler({
      settings: { defaultProvider: configured },
      authorized: false,
    });

    const snapshot = await handle(snapshotRequest());
    expect(snapshot?.status).toBe(403);
    const command = await handle(commandRequest({ kind: "send-message", prompt: "Hello" }));
    expect(command?.status).toBe(403);
    expect(authorizeWindow).toHaveBeenCalledTimes(2);
    // The authenticated window reaches the authorization dependency intact.
    expect(authorizeWindow.mock.calls[0]?.[0]).toEqual({
      windowId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("rejects a caller without a window capability", async () => {
    const { handle, authorizeWindow } = handler({
      settings: { defaultProvider: configured },
      authorized: true,
    });
    const response = await handle(new Request("http://127.0.0.1/api/navigator-assistant/snapshot"));
    expect(response?.status).toBe(401);
    expect(authorizeWindow).not.toHaveBeenCalled();
  });

  it("serves the snapshot and one command for an authorized window", async () => {
    const { handle } = handler({ settings: { defaultProvider: configured }, authorized: true });

    const snapshot = await handle(snapshotRequest());
    expect(snapshot?.status).toBe(200);
    expect(await snapshot!.json()).toMatchObject({ status: "ready", threadId: null });

    const command = await handle(commandRequest({ kind: "send-message", prompt: "Hello" }));
    expect(command?.status).toBe(200);
    expect(await command!.json()).toMatchObject({
      kind: "message-sent",
      snapshot: { status: "ready", threadId: String(threadId) },
    });
  });

  it("answers 409 with the settings deep link when no default model is configured", async () => {
    const { handle } = handler({ settings: {}, authorized: true });

    const command = await handle(commandRequest({ kind: "send-message", prompt: "Hello" }));
    expect(command?.status).toBe(409);
    expect(await command!.json()).toMatchObject({
      category: "unconfigured",
      settingsTarget: { section: "navigator-assistant", setting: "default-model" },
    });
  });

  it("rejects a command body that is not a Navigator command", async () => {
    const { handle } = handler({ settings: { defaultProvider: configured }, authorized: true });
    const command = await handle(commandRequest({ kind: "delete-everything" }));
    expect(command?.status).toBe(400);
    expect(await command!.json()).toMatchObject({ category: "invalid" });
  });

  it("does not answer requests outside its own prefix", async () => {
    const { handle } = handler({ settings: { defaultProvider: configured }, authorized: true });
    expect(await handle(new Request("http://127.0.0.1/api/zen", { headers: capability }))).toBe(
      undefined,
    );
  });
});
