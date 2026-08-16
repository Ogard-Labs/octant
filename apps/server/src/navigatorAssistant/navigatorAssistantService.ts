import { randomUUID } from "node:crypto";
import {
  decodeChatThreadId,
  decodeNavigatorAssistantCommand,
  decodeNavigatorAssistantSnapshot,
  type AggregateVersion,
  type ChatThreadId,
  type HostId,
  type NavigatorAssistantCommandResult,
  type NavigatorAssistantModelRef,
  type NavigatorAssistantSettings,
  type NavigatorAssistantSnapshot,
  type NavigatorAssistantTranscriptMessage,
  type ProviderInstanceId,
  type ProviderModelId,
  type SettingsDeepLink,
  type WindowId,
} from "@octant/contracts";
import {
  imageInputCapabilityOf,
  NAVIGATOR_ASSISTANT_DEFAULT_MODEL_TARGET,
  type NavigatorAssistantImageModelFacts,
} from "@octant/domain";
import type { NavigatorAssistantBindingStore } from "./navigatorAssistantBindingStore";

/** The title the host-owned Navigator conversation is created with. */
export const NAVIGATOR_ASSISTANT_THREAD_TITLE = "Navigator";

/** The thread facts Navigator needs from Chat; a subset of `ChatThreadView`. */
export interface NavigatorAssistantThreadFacts {
  readonly threadId: ChatThreadId;
  readonly version: AggregateVersion;
  readonly lifecycle: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
  /** The conversation itself, folded by Chat, so surfaces share one reading. */
  readonly transcript: ReadonlyArray<NavigatorAssistantTranscriptMessage>;
}

/**
 * Navigator's window onto the existing Chat turn pipeline.
 *
 * Kept a port so Navigator never grows a second turn runtime: every method
 * maps onto a Chat command a user could have issued, and Chat keeps its own
 * server-side authority, capacity, and provider checks on every one of them.
 */
export interface NavigatorAssistantChatPort {
  /**
   * Create the conversation at the id the durable binding already claims.
   * Navigator owns the id so the claim can be journaled before anything is
   * committed to Chat, and so a claim whose thread was never created can be
   * finished later at exactly that id.
   */
  create(input: { readonly threadId: ChatThreadId; readonly title: string }): Promise<void>;
  read(threadId: ChatThreadId): NavigatorAssistantThreadFacts | undefined;
  selectModel(input: {
    readonly threadId: ChatThreadId;
    readonly expectedVersion: AggregateVersion;
    readonly providerInstanceId: ProviderInstanceId;
    readonly modelId: ProviderModelId;
  }): Promise<void>;
  send(input: {
    readonly threadId: ChatThreadId;
    readonly expectedVersion: AggregateVersion;
    readonly prompt: string;
    readonly windowId: WindowId;
  }): Promise<void>;
}

export interface NavigatorAssistantServiceDependencies {
  readonly localHostId: HostId;
  /** The persisted Navigator settings section, read fresh on every request. */
  readonly readSettings: () => NavigatorAssistantSettings;
  readonly bindings: NavigatorAssistantBindingStore;
  readonly chat: NavigatorAssistantChatPort;
  /**
   * The host's observed facts for one model, or `undefined` when the model has
   * not been observed. Unobserved normalizes to `unknown`, never to supported.
   */
  readonly modelFacts: (
    ref: NavigatorAssistantModelRef,
  ) => NavigatorAssistantImageModelFacts | undefined;
  readonly clock?: () => string;
  /** Mints the Chat thread id the Navigator conversation is claimed at. */
  readonly uuid?: () => string;
}

export type NavigatorAssistantFailureCategory =
  | "unconfigured"
  | "invalid"
  | "conflict"
  | "unavailable";

/**
 * A Navigator request the host refused, carrying the category and — for a
 * refusal the user can fix in Settings — the exact deep link that fixes it, so
 * the surface offers the fix instead of a dead end.
 */
export class NavigatorAssistantServiceError extends Error {
  readonly category: NavigatorAssistantFailureCategory;
  readonly settingsTarget: SettingsDeepLink | undefined;

  constructor(
    category: NavigatorAssistantFailureCategory,
    message: string,
    settingsTarget?: SettingsDeepLink,
  ) {
    super(message);
    this.name = "NavigatorAssistantServiceError";
    this.category = category;
    this.settingsTarget = settingsTarget;
  }
}

/**
 * The host-owned Navigator assistant.
 *
 * Three facts make this service the production consumer of the
 * `shell.settings.navigatorAssistant` section rather than a second place that
 * describes it:
 *
 * 1. The configured `defaultProvider` is what Navigator actually converses
 *    with. The conversation thread is created and then pinned to that pair
 *    through the ordinary `change-chat-provider` command, and every send
 *    re-asserts it, so changing the setting moves the next turn and a thread
 *    that drifted is re-pinned instead of quietly answering on another model.
 * 2. No default model means Navigator reports `unconfigured` and refuses to
 *    send, with the settings deep link that fixes it. There is no fallback to
 *    a Chat default: a silent substitution would make the Settings section
 *    claim something the runtime does not do.
 * 3. Image handling is decided by the shared domain policy over the observed
 *    capability of that same configured model — this service reads the policy,
 *    it does not restate the rule.
 *
 * This service has no mutation authority. Its whole command surface is
 * `send-message`; there is no command here that changes app state, so anything
 * Navigator suggests reaches the app only after the user runs it through the
 * existing command surfaces with their existing authority checks.
 *
 * What the conversation may do is decided elsewhere and per window: a window
 * whose user opened Zen's assistant has bound this conversation as that
 * window's Zen assistant surface, and Zen authorizes its own bounded tool
 * vocabulary against that binding. A recipe those tools propose is still inert
 * until the user confirms it, which is the propose-then-confirm shape the plan
 * requires of anything Navigator can reach.
 */
export class NavigatorAssistantService {
  readonly #deps: NavigatorAssistantServiceDependencies;
  readonly #clock: () => string;
  readonly #uuid: () => string;
  /**
   * One in-flight conversation opening per host, so two concurrent requests
   * do not both run the create for the same claimed id and turn a benign
   * duplicate into a reported failure.
   */
  readonly #creating = new Map<string, Promise<ChatThreadId>>();

  constructor(dependencies: NavigatorAssistantServiceDependencies) {
    this.#deps = dependencies;
    this.#clock = dependencies.clock ?? (() => new Date().toISOString());
    this.#uuid = dependencies.uuid ?? randomUUID;
  }

  /**
   * Honest readiness for the Navigator surface. Reads state only: the
   * conversation is created on first use, so a host that has never used
   * Navigator reports `threadId: null` rather than minting a thread because
   * something polled it.
   */
  snapshot(_windowId: WindowId): NavigatorAssistantSnapshot {
    const settings = this.#deps.readSettings();
    const threadId = this.#deps.bindings.read() ?? null;
    const defaultProvider = settings.defaultProvider;
    // Reading the bound conversation is a state read, so a poll still cannot
    // mint one: a claim whose thread was never created simply reads as empty.
    const conversation = threadId === null ? undefined : this.#deps.chat.read(threadId);
    return decodeNavigatorAssistantSnapshot({
      status: defaultProvider === undefined ? "unconfigured" : "ready",
      settingsTarget: NAVIGATOR_ASSISTANT_DEFAULT_MODEL_TARGET,
      threadId,
      transcript: conversation?.transcript ?? [],
      defaultProvider: defaultProvider ?? null,
      // `unknown` is not `supported`; an unobserved or unreported model never
      // reads as image-capable. The vision routing that consumes this decision
      // is slice 5.
      imageInput:
        defaultProvider === undefined
          ? "unknown"
          : imageInputCapabilityOf(this.#deps.modelFacts(defaultProvider)),
      visionReviewer: settings.visionReviewer ?? null,
    });
  }

  /**
   * The host's one Navigator conversation, opened on first use.
   *
   * Public because Zen's assistant is a second front on this same conversation
   * and must bind the id the host already owns rather than mint a parallel one.
   * Two threads would mean the surface the user converses with and the thread
   * an app-managed tool is authorized against are different threads, which is
   * exactly how Zen's recipe previews became ungeneratable.
   *
   * Opening is an explicit act — Zen binds only when the user opens Zen's
   * assistant — so this stays off the polling path that {@link snapshot}
   * deliberately keeps free of thread creation.
   */
  async ensureConversation(): Promise<ChatThreadId> {
    return (await this.#ensureConversation()).threadId;
  }

  async execute(windowId: WindowId, input: unknown): Promise<NavigatorAssistantCommandResult> {
    let command;
    try {
      command = decodeNavigatorAssistantCommand(input);
    } catch {
      throw new NavigatorAssistantServiceError("invalid", "Navigator command is invalid.");
    }
    // The command union has exactly one member today. Keeping the switch means
    // a future member cannot be added without deciding its authority here.
    switch (command.kind) {
      case "send-message":
        return await this.#sendMessage(windowId, command.prompt);
    }
  }

  async #sendMessage(windowId: WindowId, prompt: string): Promise<NavigatorAssistantCommandResult> {
    const defaultProvider = this.#requireDefaultProvider();
    const conversation = await this.#ensureConversation();
    const pinned = await this.#pinConfiguredModel(conversation, defaultProvider);
    await this.#deps.chat.send({
      threadId: pinned.threadId,
      expectedVersion: pinned.version,
      prompt,
      windowId,
    });
    return { kind: "message-sent", snapshot: this.snapshot(windowId) };
  }

  #requireDefaultProvider(): NavigatorAssistantModelRef {
    const defaultProvider = this.#deps.readSettings().defaultProvider;
    if (defaultProvider === undefined) {
      throw new NavigatorAssistantServiceError(
        "unconfigured",
        "Navigator has no default model. Choose one in Settings before sending.",
        NAVIGATOR_ASSISTANT_DEFAULT_MODEL_TARGET,
      );
    }
    return defaultProvider;
  }

  /** The host's one Navigator conversation, claimed and created on first use. */
  async #ensureConversation(): Promise<NavigatorAssistantThreadFacts> {
    const bound = this.#deps.bindings.read();
    // A binding whose thread is missing is a claim that was never finished, so
    // it falls through to the opening path rather than being served as ready.
    const open = bound === undefined ? undefined : this.#deps.chat.read(bound);
    if (open !== undefined) return this.#requireActive(open);
    const key = String(this.#deps.localHostId);
    const joined = this.#creating.get(key);
    if (joined !== undefined) return this.#readActiveThread(await joined);
    const opening = this.#openConversation();
    this.#creating.set(key, opening);
    try {
      return this.#readActiveThread(await opening);
    } finally {
      if (this.#creating.get(key) === opening) this.#creating.delete(key);
    }
  }

  /**
   * Claim the binding first, then create the Chat thread the claim names.
   *
   * Binding already came before the model pin so a pin that fails could not
   * strand an unhidden orphan; the bind itself failing was the gap that
   * ordering did not cover. Creating first committed a Chat thread that the
   * binding — and therefore the hidden-thread seam that reads it — might never
   * name, leaving an ordinary "Navigator" conversation in Recents and letting
   * the next attempt mint another. Claiming first closes that: nothing reaches
   * Chat until the durable claim holds, and a claim whose thread was never
   * created is finished by the next attempt, because the journal names the
   * exact id to create. The journal's `expectedVersion: 0` singleton guard is
   * untouched — it is still what makes at most one claim exist — and it is
   * never left pointing at a thread that cannot be created, because the id is
   * re-creatable until it succeeds.
   */
  async #openConversation(): Promise<ChatThreadId> {
    const claimed = this.#claimConversation();
    if (this.#deps.chat.read(claimed) !== undefined) return claimed;
    try {
      await this.#deps.chat.create({
        threadId: claimed,
        title: NAVIGATOR_ASSISTANT_THREAD_TITLE,
      });
    } catch {
      // A create that lost to another writer of the same claim is not a
      // second conversation: the claim names one thread, so adopt it.
      if (this.#deps.chat.read(claimed) === undefined) {
        throw new NavigatorAssistantServiceError(
          "unavailable",
          "The Navigator conversation could not be created.",
        );
      }
    }
    return claimed;
  }

  /** The durably claimed conversation id; an existing claim always wins. */
  #claimConversation(): ChatThreadId {
    const existing = this.#deps.bindings.read();
    if (existing !== undefined) return existing;
    try {
      return this.#deps.bindings.bind({
        threadId: decodeChatThreadId(this.#uuid()),
        boundAt: this.#clock(),
      });
    } catch {
      throw new NavigatorAssistantServiceError(
        "unavailable",
        "The Navigator conversation could not be bound.",
      );
    }
  }

  /**
   * Make the bound conversation actually run on the configured pair.
   *
   * A newly created thread carries whatever Chat's own default selection is,
   * and a thread bound before the setting changed carries the old pair, so
   * this is re-asserted on every send through the same `change-chat-provider`
   * command a user would issue. A pair that will not stick is reported
   * unavailable rather than sent anyway: answering on a model the user did not
   * configure is exactly the silent fallback the settings section rules out.
   */
  async #pinConfiguredModel(
    thread: NavigatorAssistantThreadFacts,
    defaultProvider: NavigatorAssistantModelRef,
  ): Promise<NavigatorAssistantThreadFacts> {
    if (matchesModel(thread, defaultProvider)) return thread;
    try {
      await this.#deps.chat.selectModel({
        threadId: thread.threadId,
        expectedVersion: thread.version,
        providerInstanceId: defaultProvider.providerInstanceId,
        modelId: defaultProvider.modelId,
      });
    } catch {
      throw new NavigatorAssistantServiceError(
        "unavailable",
        "The Navigator default model could not be applied to the conversation.",
        NAVIGATOR_ASSISTANT_DEFAULT_MODEL_TARGET,
      );
    }
    const repinned = this.#readActiveThread(thread.threadId);
    if (!matchesModel(repinned, defaultProvider)) {
      throw new NavigatorAssistantServiceError(
        "unavailable",
        "The Navigator conversation is not on the configured default model.",
        NAVIGATOR_ASSISTANT_DEFAULT_MODEL_TARGET,
      );
    }
    return repinned;
  }

  #readActiveThread(threadId: ChatThreadId): NavigatorAssistantThreadFacts {
    return this.#requireActive(this.#deps.chat.read(threadId));
  }

  #requireActive(thread: NavigatorAssistantThreadFacts | undefined): NavigatorAssistantThreadFacts {
    if (thread === undefined || thread.lifecycle !== "active") {
      throw new NavigatorAssistantServiceError(
        "unavailable",
        "The Navigator conversation is unavailable.",
      );
    }
    return thread;
  }
}

function matchesModel(
  thread: NavigatorAssistantThreadFacts,
  ref: NavigatorAssistantModelRef,
): boolean {
  return (
    String(thread.providerInstanceId) === String(ref.providerInstanceId) &&
    String(thread.modelId) === String(ref.modelId)
  );
}
