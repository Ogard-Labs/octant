import {
  decodeChatThreadId,
  decodeNavigatorAssistantModelRef,
  decodeWindowId,
  LOCAL_HOST_ID,
  type ChatThreadId,
  type ImageInputCapability,
  type NavigatorAssistantModelRef,
  type NavigatorAssistantSettings,
  type UtcTimestamp,
} from "@octant/contracts";
import { describe, expect, it } from "vitest";
import type { NavigatorAssistantBindingStore } from "./navigatorAssistantBindingStore";
import {
  NavigatorAssistantService,
  NavigatorAssistantServiceError,
  type NavigatorAssistantChatPort,
  type NavigatorAssistantThreadFacts,
} from "./navigatorAssistantService";

const windowId = decodeWindowId("11111111-1111-4111-8111-111111111111");
const createdThreadId = decodeChatThreadId("9e000000-0000-4000-8000-0000000000aa");
const TRANSCRIPT_TIME = "2026-08-15T09:00:00.000Z" as UtcTimestamp;

const configured = decodeNavigatorAssistantModelRef({
  providerInstanceId: "9e000000-0000-4000-8000-0000000000b1",
  modelId: "model-a",
});
const otherModel = decodeNavigatorAssistantModelRef({
  providerInstanceId: "9e000000-0000-4000-8000-0000000000b2",
  modelId: "model-b",
});

/** In-memory stand-in for the journaled binding, with the same adopt-the-winner rule. */
function bindingStore(initial?: ChatThreadId): NavigatorAssistantBindingStore {
  let bound = initial;
  return {
    read: () => bound,
    bind: ({ threadId }) => (bound ??= threadId),
    hiddenThreadIds: () => (bound === undefined ? new Set() : new Set([String(bound)])),
  };
}

/**
 * A binding store whose first `failures` writes fail, standing in for the
 * transient persistence failure that is the whole point of the orphan test.
 */
function flakyBindingStore(failures: number): NavigatorAssistantBindingStore {
  const durable = bindingStore();
  let remaining = failures;
  return {
    read: () => durable.read(),
    bind: (input) => {
      if (remaining > 0) {
        remaining -= 1;
        throw new Error("journal write failed");
      }
      return durable.bind(input);
    },
    hiddenThreadIds: () => durable.hiddenThreadIds(),
  };
}

interface ChatRecorder {
  readonly port: NavigatorAssistantChatPort;
  readonly created: Array<{ readonly threadId: string; readonly title: string }>;
  readonly selected: Array<{ providerInstanceId: string; modelId: string }>;
  readonly sent: Array<{ threadId: string; prompt: string; windowId: string }>;
  thread: NavigatorAssistantThreadFacts | undefined;
}

function chatRecorder(options?: {
  readonly startOn?: NavigatorAssistantModelRef;
  readonly refuseSelect?: boolean;
  readonly lifecycle?: string;
}): ChatRecorder {
  const start = options?.startOn ?? otherModel;
  const recorder: ChatRecorder = {
    created: [],
    selected: [],
    sent: [],
    thread: undefined,
    port: {
      create: async ({ threadId, title }) => {
        recorder.created.push({ threadId: String(threadId), title });
        recorder.thread = {
          threadId,
          version: 1 as NavigatorAssistantThreadFacts["version"],
          lifecycle: options?.lifecycle ?? "active",
          providerInstanceId: start.providerInstanceId,
          modelId: start.modelId,
          transcript: [],
        };
      },
      read: (threadId) =>
        recorder.thread !== undefined && String(recorder.thread.threadId) === String(threadId)
          ? recorder.thread
          : undefined,
      selectModel: async ({ providerInstanceId, modelId }) => {
        if (options?.refuseSelect === true) throw new Error("provider unavailable");
        recorder.selected.push({
          providerInstanceId: String(providerInstanceId),
          modelId: String(modelId),
        });
        const current = recorder.thread;
        if (current === undefined) return;
        recorder.thread = {
          ...current,
          version: (current.version + 1) as NavigatorAssistantThreadFacts["version"],
          providerInstanceId,
          modelId,
        };
      },
      send: async ({ threadId, prompt, windowId: sender }) => {
        recorder.sent.push({
          threadId: String(threadId),
          prompt,
          windowId: String(sender),
        });
        const current = recorder.thread;
        if (current === undefined) return;
        recorder.thread = {
          ...current,
          transcript: [
            ...current.transcript,
            { role: "user" as const, text: prompt, createdAt: TRANSCRIPT_TIME },
          ],
        };
      },
    },
  };
  return recorder;
}

function service(input: {
  readonly settings: NavigatorAssistantSettings;
  readonly chat: NavigatorAssistantChatPort;
  readonly bindings?: NavigatorAssistantBindingStore;
  readonly imageFacts?: { readonly imageInput?: ImageInputCapability };
}): NavigatorAssistantService {
  return new NavigatorAssistantService({
    localHostId: LOCAL_HOST_ID,
    readSettings: () => input.settings,
    bindings: input.bindings ?? bindingStore(),
    chat: input.chat,
    modelFacts: () =>
      input.imageFacts === undefined
        ? undefined
        : {
            inputModalities: ["text"],
            ...(input.imageFacts.imageInput === undefined
              ? {}
              : { imageInput: input.imageFacts.imageInput }),
          },
    clock: () => "2026-08-15T09:00:00.000Z",
    uuid: () => String(createdThreadId),
  });
}

describe("NavigatorAssistantService", () => {
  it("carries the bound conversation so every Navigator surface reads one transcript", async () => {
    const chat = chatRecorder();
    const navigatorAssistant = service({
      settings: { defaultProvider: configured },
      chat: chat.port,
    });

    // Before the conversation exists there is nothing to read, and an absent
    // conversation is an empty transcript rather than a missing field.
    expect(navigatorAssistant.snapshot(windowId).transcript).toEqual([]);

    await navigatorAssistant.execute(windowId, { kind: "send-message", prompt: "Hello" });

    expect(navigatorAssistant.snapshot(windowId).transcript).toEqual([
      { role: "user", text: "Hello", createdAt: TRANSCRIPT_TIME },
    ]);
  });

  it("names one conversation for every front, so Zen's assistant binds it instead of minting another", async () => {
    const chat = chatRecorder();
    // No default model: Zen's assistant may still be opened, and the surface
    // reports the configure state rather than being denied a conversation.
    const navigatorAssistant = service({ settings: {}, chat: chat.port });

    const opened = await navigatorAssistant.ensureConversation();
    const reopened = await navigatorAssistant.ensureConversation();

    expect(String(opened)).toBe(String(createdThreadId));
    expect(String(reopened)).toBe(String(opened));
    expect(chat.created).toHaveLength(1);
    expect(String(navigatorAssistant.snapshot(windowId).threadId)).toBe(String(opened));
  });

  it("reports unavailable with the settings deep link when no default model is configured", async () => {
    const chat = chatRecorder();
    const navigatorAssistant = service({ settings: {}, chat: chat.port });

    const snapshot = navigatorAssistant.snapshot(windowId);
    expect(snapshot.status).toBe("unconfigured");
    expect(snapshot.defaultProvider).toBeNull();
    expect(snapshot.settingsTarget).toEqual({
      section: "navigator-assistant",
      setting: "default-model",
    });

    // The refusal is the whole point: falling back to some other configured
    // model would make the Settings section claim something untrue.
    const refusal = await navigatorAssistant
      .execute(windowId, { kind: "send-message", prompt: "Hello" })
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(NavigatorAssistantServiceError);
    expect((refusal as NavigatorAssistantServiceError).category).toBe("unconfigured");
    expect((refusal as NavigatorAssistantServiceError).settingsTarget).toEqual({
      section: "navigator-assistant",
      setting: "default-model",
    });
    expect(chat.created).toEqual([]);
    expect(chat.sent).toEqual([]);
  });

  it("creates the conversation lazily and sends on the configured default model", async () => {
    const chat = chatRecorder();
    const bindings = bindingStore();
    const navigatorAssistant = service({
      settings: { defaultProvider: configured },
      chat: chat.port,
      bindings,
    });

    // Nothing exists until the first command; a snapshot poll must not mint a thread.
    expect(navigatorAssistant.snapshot(windowId).threadId).toBeNull();
    expect(chat.created).toEqual([]);

    const result = await navigatorAssistant.execute(windowId, {
      kind: "send-message",
      prompt: "Where do I set the default model?",
    });

    expect(chat.created.map((entry) => entry.title)).toEqual(["Navigator"]);
    // The thread was created on Chat's own default selection and then pinned
    // to the configured pair before the turn was appended.
    expect(chat.selected).toEqual([
      { providerInstanceId: String(configured.providerInstanceId), modelId: "model-a" },
    ]);
    expect(chat.sent).toEqual([
      {
        threadId: String(createdThreadId),
        prompt: "Where do I set the default model?",
        windowId: String(windowId),
      },
    ]);
    expect(result.snapshot.threadId).toBe(createdThreadId);
    expect(result.snapshot.defaultProvider).toEqual(configured);

    // The conversation is hidden from every Chat listing through the same seam
    // Side Chat sidecars use.
    expect([...bindings.hiddenThreadIds()]).toEqual([String(createdThreadId)]);
  });

  it("reuses the one bound conversation instead of minting a second", async () => {
    const chat = chatRecorder();
    const navigatorAssistant = service({
      settings: { defaultProvider: configured },
      chat: chat.port,
    });
    await navigatorAssistant.execute(windowId, { kind: "send-message", prompt: "first" });
    await navigatorAssistant.execute(windowId, { kind: "send-message", prompt: "second" });

    expect(chat.created.map((entry) => entry.title)).toEqual(["Navigator"]);
    // Already on the configured pair, so the second send re-asserts nothing.
    expect(chat.selected).toHaveLength(1);
    expect(chat.sent.map((entry) => entry.prompt)).toEqual(["first", "second"]);
  });

  it("leaves no visible conversation behind when the binding write fails", async () => {
    const chat = chatRecorder();
    const bindings = flakyBindingStore(1);
    const navigatorAssistant = service({
      settings: { defaultProvider: configured },
      chat: chat.port,
      bindings,
    });

    const refusal = await navigatorAssistant
      .execute(windowId, { kind: "send-message", prompt: "first" })
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(NavigatorAssistantServiceError);
    expect((refusal as NavigatorAssistantServiceError).category).toBe("unavailable");

    // The transient failure clears and the user tries again.
    await navigatorAssistant.execute(windowId, { kind: "send-message", prompt: "second" });

    // Every Chat thread this host committed is one the hidden-thread seam
    // covers. A committed thread the binding does not name is an ordinary
    // "Navigator" conversation sitting in the user's Recents.
    const hidden = bindings.hiddenThreadIds();
    expect(chat.created.filter((entry) => !hidden.has(entry.threadId))).toEqual([]);
    // And the retry produced the one conversation, not a second one.
    expect(chat.created).toHaveLength(1);
    expect(chat.sent.map((entry) => entry.prompt)).toEqual(["second"]);
  });

  it("finishes a durable binding whose conversation was never created", async () => {
    // The state a host restarts into when it died after claiming the binding
    // and before Chat committed the thread. The journal names the exact thread
    // id, so the next attempt completes that claim instead of stranding it.
    const chat = chatRecorder();
    const bindings = bindingStore(createdThreadId);
    const navigatorAssistant = service({
      settings: { defaultProvider: configured },
      chat: chat.port,
      bindings,
    });

    await navigatorAssistant.execute(windowId, { kind: "send-message", prompt: "after restart" });

    expect(chat.created.map((entry) => entry.threadId)).toEqual([String(createdThreadId)]);
    expect(chat.sent.map((entry) => entry.threadId)).toEqual([String(createdThreadId)]);
    expect(bindings.read()).toBe(createdThreadId);
  });

  it("re-pins a conversation whose model drifted from the setting", async () => {
    const chat = chatRecorder();
    const navigatorAssistant = service({
      settings: { defaultProvider: configured },
      chat: chat.port,
    });
    await navigatorAssistant.execute(windowId, { kind: "send-message", prompt: "first" });

    // Something moved the bound thread off the configured pair.
    chat.thread = {
      threadId: createdThreadId,
      version: 9 as NavigatorAssistantThreadFacts["version"],
      lifecycle: "active",
      providerInstanceId: otherModel.providerInstanceId,
      modelId: otherModel.modelId,
      transcript: [],
    };
    await navigatorAssistant.execute(windowId, { kind: "send-message", prompt: "second" });

    expect(chat.selected).toEqual([
      { providerInstanceId: String(configured.providerInstanceId), modelId: "model-a" },
      { providerInstanceId: String(configured.providerInstanceId), modelId: "model-a" },
    ]);
    expect(chat.sent).toHaveLength(2);
  });

  it("refuses to send when the configured model cannot be applied", async () => {
    const chat = chatRecorder({ refuseSelect: true });
    const navigatorAssistant = service({
      settings: { defaultProvider: configured },
      chat: chat.port,
    });

    const refusal = await navigatorAssistant
      .execute(windowId, { kind: "send-message", prompt: "Hello" })
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(NavigatorAssistantServiceError);
    expect((refusal as NavigatorAssistantServiceError).category).toBe("unavailable");
    // Never sent on the model the user did not configure.
    expect(chat.sent).toEqual([]);
  });

  it("reports the configured model's image capability honestly", () => {
    const chat = chatRecorder();
    const unobserved = service({ settings: { defaultProvider: configured }, chat: chat.port });
    expect(unobserved.snapshot(windowId).imageInput).toBe("unknown");

    const observed = service({
      settings: { defaultProvider: configured, visionReviewer: otherModel },
      chat: chat.port,
      imageFacts: { imageInput: "supported" },
    });
    const snapshot = observed.snapshot(windowId);
    expect(snapshot.imageInput).toBe("supported");
    expect(snapshot.visionReviewer).toEqual(otherModel);
  });

  it("refuses any command that is not the one send-message command", async () => {
    const chat = chatRecorder();
    const navigatorAssistant = service({
      settings: { defaultProvider: configured },
      chat: chat.port,
    });

    // Navigator has no mutation authority: there is no command here that
    // changes app state, so an invented one is refused at the decode boundary.
    const refusal = await navigatorAssistant
      .execute(windowId, { kind: "update-settings", prompt: "turn Chat off" })
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(NavigatorAssistantServiceError);
    expect((refusal as NavigatorAssistantServiceError).category).toBe("invalid");
    expect(chat.sent).toEqual([]);
  });
});
