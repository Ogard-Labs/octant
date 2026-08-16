import {
  ZenError,
  type ZenCommand,
  type ZenBootstrapResponse,
  type ZenCreateSpaceCommand,
  type ZenCreateTimerCommand,
  type ZenCreateSpaceResult,
  type ZenMutationResult,
  type ZenRecoverResult,
  type ZenResult,
  ZenSpace,
  ZenSpaceId,
  decodeZenElementId,
  decodeZenRecipePreviewId,
  decodeZenChecklistItemId,
  type ZenWidgetMutation,
  type ZenThreadAttachRequest,
  type ZenThreadAttachResult,
  type ZenThreadCatalogEntry,
  type ZenThreadContinuationTarget,
  decodeZenAssistantSnapshot,
  type ZenAssistantProviderState,
  type ZenAssistantSnapshot,
  type ZenAssistantPlacementInput,
  type ZenAssistantAppearanceInput,
  type ZenAssistantPreviewRecipeInput,
  type ZenRecipePreview,
  type ZenWidgetRecipe,
  type ZenWidgetRecipeDraft,
  normalizeZenReferenceUrl,
} from "@octant/contracts/zen";
import type { ChatThread, ChatThreadId, ChatThreadView } from "@octant/contracts/chat";
import type { WindowId, HostId } from "@octant/contracts/shell";
import type { AggregateVersion } from "@octant/contracts/events";
import {
  createZenSpace,
  addElement,
  addChecklistItem,
  MAX_ZEN_ELEMENT_Z_INDEX,
  processZenCommand,
  reconcileRunningTimers,
  reconcileScheduledTimer,
  timerRemainingMs,
  type ZenTimerClockSample,
  recoverSpace,
  validateWidgetRecipe,
  ZenPolicyRejected,
} from "@octant/domain";
import { assistantTranscript } from "../chat/assistantTranscript";
import type { ZenEventStore } from "./zenEventStore";
import type { ZenThreadCatalog } from "./zenThreadCatalog";

export const ZEN_RECIPE_PREVIEW_TTL_MS = 10 * 60_000;
export const MAX_ZEN_RECIPE_PREVIEWS = 16;
export const MAX_ZEN_RECIPE_PREVIEWS_PER_ASSISTANT = 4;

export interface ZenServiceDependencies {
  readonly loadSpace: (spaceId: ZenSpaceId) => ZenSpace | null;
  readonly loadSpaceByWindow: (windowId: WindowId) => ZenSpace | null;
  readonly eventStore: ZenEventStore;
  readonly localHostId: HostId;
  readonly threadCatalog?: Pick<ZenThreadCatalog, "resolve" | "search">;
  readonly uuid?: () => string;
  readonly assistantChat?: ZenAssistantChatPort;
  readonly assistantProviderState?: (thread: ChatThread) => ZenAssistantProviderState;
  readonly recipeClock?: () => number;
  readonly timerClock?: () => ZenTimerClockSample;
  readonly scheduleTimer?: (delayMs: number, callback: () => void) => () => void;
}

export interface ZenAssistantChatPort {
  /**
   * The one conversation Zen's assistant is a front on, created on first use.
   *
   * Zen does not own this conversation: the host does, and the Navigator dock
   * panel reads the same one. Zen binds the id it is given rather than minting
   * a parallel thread, because the thread the user converses with must be the
   * thread Zen's bounded tool vocabulary is authorized against — otherwise the
   * assistant can be asked for a widget on one thread while the tools that
   * would propose it are attached to another.
   */
  readonly create: () => Promise<ChatThread>;
  readonly read: (threadId: ChatThreadId) => ChatThreadView | undefined;
}

export class ZenService {
  readonly #assistantCreationByWindow = new Map<string, Promise<ZenAssistantSnapshot>>();
  readonly #timerSchedules = new Map<
    string,
    { readonly spaceId: string; readonly token: string; readonly cancel: () => void }
  >();
  readonly #recipePreviews = new Map<
    string,
    {
      readonly windowId: WindowId;
      readonly threadId: ChatThreadId;
      readonly preview: ZenRecipePreview;
    }
  >();
  readonly #timerClock: () => ZenTimerClockSample;
  readonly #recipeClock: () => number;
  readonly #scheduleTimer: (delayMs: number, callback: () => void) => () => void;

  constructor(readonly deps: ZenServiceDependencies) {
    const sessionId = crypto.randomUUID();
    this.#timerClock =
      deps.timerClock ??
      (() => ({
        wallTimeMs: Date.now(),
        monotonicTimeMs: performance.now(),
        sessionId,
      }));
    this.#recipeClock = deps.recipeClock ?? Date.now;
    this.#scheduleTimer =
      deps.scheduleTimer ??
      ((delayMs, callback) => {
        const handle = setTimeout(callback, delayMs);
        handle.unref?.();
        return () => clearTimeout(handle);
      });
  }

  bootstrap(windowId: WindowId): ZenBootstrapResponse {
    const existing = this.deps.loadSpaceByWindow(windowId);
    if (existing === null) return { space: null, windowId };
    const reconciled = this.#reconcileTimers(existing);
    this.#syncTimerSchedules(reconciled);
    return { space: reconciled, windowId };
  }

  close(): void {
    for (const schedule of this.#timerSchedules.values()) schedule.cancel();
    this.#timerSchedules.clear();
    this.#recipePreviews.clear();
  }

  async searchThreads(
    windowId: WindowId,
    query = "",
  ): Promise<ReadonlyArray<ZenThreadCatalogEntry>> {
    if (this.deps.threadCatalog === undefined) return [];
    return await this.deps.threadCatalog.search(windowId, query);
  }

  async attachThread(
    windowId: WindowId,
    request: ZenThreadAttachRequest,
    signal?: AbortSignal,
  ): Promise<ZenThreadAttachResult> {
    const space = this.deps.loadSpaceByWindow(windowId);
    if (space === null) throw new ZenError({ reason: "unknown-space" });
    if (space.windowId !== windowId) {
      throw new ZenError({ reason: "wrong-window", spaceId: space.spaceId });
    }
    if (this.deps.threadCatalog === undefined || this.deps.uuid === undefined) {
      throw new ZenError({ reason: "missing-capability", spaceId: space.spaceId });
    }
    if (signal?.aborted) throw new ZenError({ reason: "interrupted", spaceId: space.spaceId });
    const entry = await this.deps.threadCatalog.resolve(windowId, request.catalogRef);
    if (signal?.aborted) throw new ZenError({ reason: "interrupted", spaceId: space.spaceId });
    if (entry === undefined) {
      throw new ZenError({ reason: "unavailable-source", spaceId: space.spaceId });
    }
    const elementId = decodeZenElementId(this.deps.uuid());
    const zIndex = Math.max(0, ...space.elements.map((element) => element.zIndex)) + 1;
    const element = {
      elementId,
      kind: "thread" as const,
      sourceContext: entry.sourceContext,
      geometry: request.geometry ?? {
        x: 64 + space.elements.length * 32,
        y: 96 + space.elements.length * 32,
        width: 420,
        height: 260,
      },
      zIndex,
      minimized: false,
      locked: false,
    };
    try {
      const updated = processZenCommand(
        space,
        {
          command: "add-element",
          spaceId: space.spaceId,
          element,
          expectedVersion: request.expectedVersion,
        },
        this.deps.localHostId,
      );
      const committed = this.deps.eventStore.append(updated, request.expectedVersion);
      return { result: "thread-attached", entry, elementId, space: committed };
    } catch (error) {
      if (error instanceof ZenPolicyRejected) {
        throw new ZenError({ reason: error.code, spaceId: space.spaceId });
      }
      if (this.deps.eventStore.isConcurrencyConflict(error)) {
        throw new ZenError({ reason: "stale-version", spaceId: space.spaceId });
      }
      throw error;
    }
  }

  async continueThread(
    windowId: WindowId,
    catalogRef: ZenThreadAttachRequest["catalogRef"],
  ): Promise<ZenThreadContinuationTarget> {
    if (this.deps.threadCatalog === undefined) {
      throw new ZenError({ reason: "missing-capability" });
    }
    const entry = await this.deps.threadCatalog.resolve(windowId, catalogRef);
    if (entry === undefined) throw new ZenError({ reason: "unavailable-source" });
    return { result: "thread-continuation", entry };
  }

  createTimerWidget(
    windowId: WindowId,
    durationMs: ZenCreateTimerCommand["durationMs"],
    expectedVersion: AggregateVersion,
  ): { readonly elementId: ReturnType<typeof decodeZenElementId>; readonly space: ZenSpace } {
    const before = this.spaceForWindow(windowId);
    const result = this.createTimer(
      {
        command: "create-timer",
        spaceId: before.spaceId,
        durationMs,
        expectedVersion,
      },
      windowId,
    );
    const existingIds = new Set(before.elements.map((element) => String(element.elementId)));
    const created = result.space.elements.find(
      (element) => element.kind === "timer" && !existingIds.has(String(element.elementId)),
    );
    if (created === undefined) {
      throw new ZenError({ reason: "recovery-required", spaceId: before.spaceId });
    }
    return { elementId: created.elementId, space: result.space };
  }

  /**
   * Open this window's Zen assistant surface, bound to the conversation it is
   * a front on.
   *
   * The binding is resolved rather than assumed: a space already bound to some
   * other thread is rebound, so the conversation the user reads on this surface
   * is always the conversation Zen's tools are authorized against. Binding is
   * the whole of that authority — a window that never opened Zen's assistant
   * binds nothing and gets no Zen tools.
   */
  async ensureAssistant(windowId: WindowId): Promise<ZenAssistantSnapshot> {
    const key = String(windowId);
    const existing = this.#assistantCreationByWindow.get(key);
    if (existing !== undefined) return await existing;
    const opening = this.#bindAssistantConversation(windowId);
    this.#assistantCreationByWindow.set(key, opening);
    try {
      return await opening;
    } finally {
      if (this.#assistantCreationByWindow.get(key) === opening) {
        this.#assistantCreationByWindow.delete(key);
      }
    }
  }

  async #bindAssistantConversation(windowId: WindowId): Promise<ZenAssistantSnapshot> {
    if (this.deps.assistantChat === undefined) {
      throw new ZenError({ reason: "missing-capability" });
    }
    // A window with no Zen space has no assistant surface to open, and asking
    // first keeps opening the host's conversation behind that check rather than
    // as a side effect of a request that cannot succeed.
    this.spaceForWindow(windowId);
    const thread = await this.deps.assistantChat.create();
    const space = this.spaceForWindow(windowId);
    if (thread.lifecycle !== "active") {
      throw new ZenError({ reason: "unavailable-source", spaceId: space.spaceId });
    }
    if (space.assistant !== null && String(space.assistant.threadId) === String(thread.id)) {
      return await this.assistantSnapshot(windowId);
    }
    try {
      const updated = processZenCommand(
        space,
        {
          command: "bind-assistant",
          spaceId: space.spaceId,
          assistant: {
            threadId: thread.id,
            providerId: String(thread.providerInstanceId),
            modelId: String(thread.modelId),
          },
          expectedVersion: space.version,
        },
        this.deps.localHostId,
      );
      this.deps.eventStore.append(updated, space.version);
    } catch (error) {
      if (error instanceof ZenPolicyRejected) {
        throw new ZenError({ reason: error.code, spaceId: space.spaceId });
      }
      if (this.deps.eventStore.isConcurrencyConflict(error)) {
        throw new ZenError({ reason: "stale-version", spaceId: space.spaceId });
      }
      throw error;
    }
    return await this.assistantSnapshot(windowId);
  }

  async assistantSnapshot(windowId: WindowId): Promise<ZenAssistantSnapshot> {
    const space = this.spaceForWindow(windowId);
    if (space.assistant === null) {
      return decodeZenAssistantSnapshot({
        status: "unbound",
        binding: null,
        provider: null,
        transcript: [],
        recipePreview: null,
        manualControls: ["threads", "widgets", "add", "placement", "appearance"],
      });
    }
    const view = this.deps.assistantChat?.read(space.assistant.threadId);
    if (view === undefined || view.thread.lifecycle !== "active") {
      return decodeZenAssistantSnapshot({
        status: "unavailable",
        binding: space.assistant,
        provider: null,
        transcript: [],
        recipePreview: null,
        manualControls: ["threads", "widgets", "add", "placement", "appearance"],
        message: "Navigator source thread is unavailable.",
      });
    }
    const provider = this.deps.assistantProviderState?.(view.thread) ?? {
      providerInstanceId: view.thread.providerInstanceId,
      providerLabel: String(view.thread.providerInstanceId),
      modelId: view.thread.modelId,
      modelLabel: String(view.thread.modelId),
      readiness: "unavailable" as const,
      toolCapability: "unavailable" as const,
      toolCapabilityReason: "Provider capability has not been observed.",
    };
    return decodeZenAssistantSnapshot({
      status: "ready",
      binding: space.assistant,
      provider,
      transcript: assistantTranscript(view),
      recipePreview: this.#currentRecipePreview(windowId, space.assistant.threadId),
      manualControls: ["threads", "widgets", "add", "placement", "appearance"],
    });
  }

  /**
   * Is this conversation the one bound as this window's Zen assistant surface?
   *
   * The only gate on Zen's app-managed tools. It is deliberately narrow in both
   * directions: the space must be this window's own, and its binding must name
   * this exact conversation. A conversation the host serves to some other
   * window, or one no Zen assistant was ever opened on, is not this window's
   * assistant surface and gets nothing.
   */
  isAssistantThread(windowId: WindowId, threadId: ChatThreadId): boolean {
    const space = this.deps.loadSpaceByWindow(windowId);
    return (
      space !== null &&
      space.windowId === windowId &&
      space.assistant !== null &&
      String(space.assistant.threadId) === String(threadId)
    );
  }

  previewRecipe(
    windowId: WindowId,
    threadId: ChatThreadId,
    input: ZenAssistantPreviewRecipeInput,
    signal?: AbortSignal,
  ): ZenRecipePreview {
    if (signal?.aborted) throw new ZenError({ reason: "interrupted" });
    const space = this.spaceForWindow(windowId);
    if (!this.isAssistantThread(windowId, threadId)) {
      throw new ZenError({ reason: "missing-capability", spaceId: space.spaceId });
    }
    const provider = this.#assertRecipeToolAuthority(windowId, space);
    if (space.version !== input.expectedVersion) {
      throw new ZenError({ reason: "stale-version", spaceId: space.spaceId });
    }
    try {
      validateWidgetRecipe(input.recipe);
    } catch (error) {
      if (error instanceof ZenPolicyRejected) {
        throw new ZenError({ reason: error.code, spaceId: space.spaceId });
      }
      throw error;
    }
    this.#purgeExpiredRecipePreviews();
    const existing =
      input.previewId === undefined ? undefined : this.#recipePreviews.get(String(input.previewId));
    if (input.previewId !== undefined && existing === undefined) {
      throw new ZenError({ reason: "stale-preview", spaceId: space.spaceId });
    }
    if (
      existing !== undefined &&
      (existing.windowId !== windowId || existing.threadId !== threadId)
    ) {
      throw new ZenError({ reason: "stale-preview", spaceId: space.spaceId });
    }
    if (existing === undefined)
      this.#assertRecipePreviewCapacity(windowId, threadId, space.spaceId);
    if (this.deps.uuid === undefined) {
      throw new ZenError({ reason: "missing-capability", spaceId: space.spaceId });
    }
    const previewId = existing?.preview.previewId ?? decodeZenRecipePreviewId(this.deps.uuid());
    const createdAtMs = this.#recipeClock();
    const createdAt = new Date(createdAtMs).toISOString();
    const preview: ZenRecipePreview = {
      previewId,
      recipe: input.recipe,
      providerInstanceId: provider.providerInstanceId,
      modelId: provider.modelId,
      expectedVersion: input.expectedVersion,
      createdAt: createdAt as ZenRecipePreview["createdAt"],
      expiresAt: new Date(
        createdAtMs + ZEN_RECIPE_PREVIEW_TTL_MS,
      ).toISOString() as ZenRecipePreview["expiresAt"],
    };
    this.#recipePreviews.delete(String(previewId));
    this.#recipePreviews.set(String(previewId), { windowId, threadId, preview });
    return preview;
  }

  applyAssistantPlacement(
    windowId: WindowId,
    input: ZenAssistantPlacementInput,
  ): ZenMutationResult {
    const space = this.spaceForWindow(windowId);
    const element = space.elements.find((candidate) => candidate.elementId === input.elementId);
    if (element === undefined) {
      throw new ZenError({ reason: "unknown-element", spaceId: space.spaceId });
    }
    if (input.action === "remove") {
      return this.handleCommand(
        {
          command: "remove-element",
          spaceId: space.spaceId,
          elementId: input.elementId,
          expectedVersion: input.expectedVersion,
        },
        windowId,
      ) as ZenMutationResult;
    }
    if (input.action === "focus") {
      if (space.version !== input.expectedVersion) {
        throw new ZenError({ reason: "stale-version", spaceId: space.spaceId });
      }
      const reordered = [
        ...space.elements.filter((candidate) => candidate.elementId !== input.elementId),
        element,
      ].map((candidate, index) => ({ ...candidate, zIndex: index + 1 }));
      try {
        const committed = this.deps.eventStore.append(
          { ...space, elements: reordered },
          input.expectedVersion,
        );
        return { result: "mutation", space: committed };
      } catch (error) {
        if (this.deps.eventStore.isConcurrencyConflict(error)) {
          throw new ZenError({ reason: "stale-version", spaceId: space.spaceId });
        }
        throw error;
      }
    }
    const updated = {
      ...element,
      ...(input.action === "move-resize" ? { geometry: input.geometry! } : {}),
      ...(input.action === "minimize" ? { minimized: true } : {}),
      ...(input.action === "restore" ? { minimized: false } : {}),
    };
    return this.handleCommand(
      {
        command: "update-element",
        spaceId: space.spaceId,
        element: updated,
        expectedVersion: input.expectedVersion,
      },
      windowId,
    ) as ZenMutationResult;
  }

  applyAssistantAppearance(
    windowId: WindowId,
    input: ZenAssistantAppearanceInput,
  ): ZenMutationResult {
    const space = this.spaceForWindow(windowId);
    return this.handleCommand(
      {
        command: "update-appearance",
        spaceId: space.spaceId,
        appearance: {
          ...space.appearance,
          ...(input.dimming === undefined ? {} : { dimming: input.dimming }),
          ...(input.elementOpacity === undefined ? {} : { elementOpacity: input.elementOpacity }),
        },
        expectedVersion: input.expectedVersion,
      },
      windowId,
    ) as ZenMutationResult;
  }

  handleCommand(command: ZenCommand, windowId: WindowId, signal?: AbortSignal): ZenResult {
    if (isWidgetCommand(command) && signal?.aborted) {
      throw new ZenError({ reason: "interrupted", spaceId: command.spaceId });
    }
    switch (command.command) {
      case "create-space":
        return this.createSpace(command, windowId);
      case "create-timer":
        return this.createTimer(command, windowId);
      case "recover":
        return this.recover(command, windowId);
      case "confirm-recipe-preview":
        return this.confirmRecipePreview(command, windowId, signal);
      case "create-widget":
        return this.createWidget(command, windowId, signal);
      case "create-reference":
        return this.createReference(command, windowId);
      case "add-checklist-item":
        return this.addChecklistItem(command, windowId, signal);
      case "save-notes":
      case "set-checklist-item-completed":
      case "reorder-checklist-item":
      case "remove-checklist-item":
        return this.mutateWidget(command, windowId, signal);
      default:
        return this.mutate(command, windowId);
    }
  }

  private confirmRecipePreview(
    command: Extract<ZenCommand, { command: "confirm-recipe-preview" }>,
    windowId: WindowId,
    signal?: AbortSignal,
  ): ZenMutationResult {
    if (signal?.aborted) throw new ZenError({ reason: "interrupted", spaceId: command.spaceId });
    const space = this.loadSpaceOrFail(command.spaceId, windowId);
    this.#purgeExpiredRecipePreviews();
    const pending = this.#recipePreviews.get(String(command.previewId));
    // A proposal belonging to another window is refused without being touched.
    // The conversation Zen's assistant is a front on is the host's, shared by
    // every window, so a preview id can reach a window the proposal was never
    // made in; discarding it there would let one window cancel another's.
    if (pending === undefined || pending.windowId !== windowId) {
      throw new ZenError({ reason: "stale-preview", spaceId: space.spaceId });
    }
    if (
      space.assistant === null ||
      pending.threadId !== space.assistant.threadId ||
      this.#previewExpired(pending.preview)
    ) {
      this.#recipePreviews.delete(String(command.previewId));
      throw new ZenError({ reason: "stale-preview", spaceId: space.spaceId });
    }
    const provider = this.#assertRecipeToolAuthority(windowId, space);
    if (
      pending.preview.providerInstanceId !== provider.providerInstanceId ||
      pending.preview.modelId !== provider.modelId
    ) {
      this.#recipePreviews.delete(String(command.previewId));
      throw new ZenError({ reason: "stale-preview", spaceId: space.spaceId });
    }
    if (
      command.expectedVersion !== space.version ||
      pending.preview.expectedVersion !== space.version
    ) {
      this.#recipePreviews.delete(String(command.previewId));
      throw new ZenError({ reason: "stale-preview", spaceId: space.spaceId });
    }
    try {
      validateWidgetRecipe(pending.preview.recipe);
      const recipe: ZenWidgetRecipe = {
        ...pending.preview.recipe,
        provenance: {
          assistantThreadId: pending.threadId,
          providerInstanceId: pending.preview.providerInstanceId,
          modelId: pending.preview.modelId,
          previewId: pending.preview.previewId,
          previewVersion: pending.preview.expectedVersion,
          createdAt: pending.preview.createdAt,
          confirmedAt: new Date(
            this.#recipeClock(),
          ).toISOString() as ZenWidgetRecipe["provenance"]["confirmedAt"],
        },
      };
      const recipes = [
        ...(space.recipes ?? []).filter(
          (recipe) => recipe.recipeId !== pending.preview.recipe.recipeId,
        ),
        recipe,
      ];
      let updated: ZenSpace = { ...space, recipes };
      if (command.action === "place") {
        if (this.deps.uuid === undefined) {
          throw new ZenError({ reason: "missing-capability", spaceId: space.spaceId });
        }
        const placement = allocateZenElementZOrder(updated);
        updated = addElement(
          placement.space,
          {
            elementId: decodeZenElementId(this.deps.uuid()),
            kind: "recipe",
            recipeId: pending.preview.recipe.recipeId,
            state: recipeInitialState(recipe),
            geometry: { x: 64, y: 96, width: 420, height: 300 },
            zIndex: placement.zIndex,
            minimized: false,
            locked: false,
            title: pending.preview.recipe.name,
          },
          command.expectedVersion,
          this.deps.localHostId,
        );
      }
      if (signal?.aborted) throw new ZenError({ reason: "interrupted", spaceId: space.spaceId });
      const committed = this.deps.eventStore.append(updated, command.expectedVersion);
      this.#recipePreviews.delete(String(command.previewId));
      return { result: "mutation", space: committed };
    } catch (error) {
      if (error instanceof ZenError) throw error;
      if (error instanceof ZenPolicyRejected) {
        throw new ZenError({ reason: error.code, spaceId: space.spaceId });
      }
      if (this.deps.eventStore.isConcurrencyConflict(error)) {
        throw new ZenError({ reason: "stale-version", spaceId: space.spaceId });
      }
      throw error;
    }
  }

  private createTimer(command: ZenCreateTimerCommand, windowId: WindowId): ZenMutationResult {
    const space = this.loadSpaceOrFail(command.spaceId, windowId);
    if (this.deps.uuid === undefined) {
      throw new ZenError({ reason: "missing-capability", spaceId: command.spaceId });
    }
    const elementId = decodeZenElementId(this.deps.uuid());
    const placement = allocateZenElementZOrder(space);
    try {
      const updated = addElement(
        placement.space,
        {
          elementId,
          kind: "timer",
          durationMs: command.durationMs,
          remainingMs: command.durationMs,
          status: "idle",
          startedAt: null,
          deadlineAt: null,
          clockSessionId: null,
          monotonicStartedMs: null,
          geometry: {
            x: 64 + space.elements.length * 32,
            y: 96 + space.elements.length * 32,
            width: 360,
            height: 220,
          },
          zIndex: placement.zIndex,
          minimized: false,
          locked: false,
          ...(command.title === undefined ? {} : { title: command.title }),
        },
        command.expectedVersion,
        this.deps.localHostId,
      );
      const committed = this.deps.eventStore.append(updated, command.expectedVersion);
      this.#syncTimerSchedules(committed);
      return { result: "mutation", space: committed };
    } catch (error) {
      if (error instanceof ZenPolicyRejected) {
        throw new ZenError({ reason: error.code, spaceId: command.spaceId });
      }
      if (this.deps.eventStore.isConcurrencyConflict(error)) {
        throw new ZenError({ reason: "stale-version", spaceId: command.spaceId });
      }
      throw error;
    }
  }

  private createWidget(
    command: Extract<ZenCommand, { command: "create-widget" }>,
    windowId: WindowId,
    signal?: AbortSignal,
  ): ZenMutationResult {
    const space = this.loadSpaceOrFail(command.spaceId, windowId);
    if (this.deps.uuid === undefined) {
      throw new ZenError({ reason: "missing-capability", spaceId: command.spaceId });
    }
    const elementId = decodeZenElementId(this.deps.uuid());
    const placement = allocateZenElementZOrder(space);
    const shared = {
      elementId,
      widgetVersion: 0 as AggregateVersion,
      geometry: {
        x: 64 + (space.elements.length % 2) * 452,
        y: 96 + Math.floor(space.elements.length / 2) * 292,
        width: 420,
        height: 260,
      },
      zIndex: placement.zIndex,
      minimized: false,
      locked: false,
    };
    const element =
      command.kind === "notes"
        ? { ...shared, kind: "notes" as const, content: "" }
        : { ...shared, kind: "checklist" as const, items: [] };
    try {
      const updated = addElement(
        placement.space,
        element,
        command.expectedVersion,
        this.deps.localHostId,
      );
      if (signal?.aborted) {
        throw new ZenError({ reason: "interrupted", spaceId: command.spaceId });
      }
      const mutation: ZenWidgetMutation = {
        operation: "widget-created",
        kind: command.kind,
        elementId,
        widgetVersion: 0 as AggregateVersion,
      };
      const committed = this.deps.eventStore.appendWidgetMutation(
        updated,
        command.expectedVersion,
        mutation,
      );
      return { result: "mutation", space: committed };
    } catch (error) {
      throw this.widgetFailure(error, command.spaceId);
    }
  }

  private createReference(
    command: Extract<ZenCommand, { command: "create-reference" }>,
    windowId: WindowId,
  ): ZenMutationResult {
    const space = this.loadSpaceOrFail(command.spaceId, windowId);
    if (this.deps.uuid === undefined) {
      throw new ZenError({ reason: "missing-capability", spaceId: command.spaceId });
    }
    const elementId = decodeZenElementId(this.deps.uuid());
    const placement = allocateZenElementZOrder(space);
    try {
      const updated = addElement(
        placement.space,
        {
          elementId,
          kind: "reference",
          url: normalizeZenReferenceUrl(command.url) as typeof command.url,
          ...(command.label === undefined ? {} : { label: command.label }),
          geometry: {
            x: 64 + (space.elements.length % 2) * 452,
            y: 96 + Math.floor(space.elements.length / 2) * 292,
            width: 420,
            height: 260,
          },
          zIndex: placement.zIndex,
          minimized: false,
          locked: false,
        },
        command.expectedVersion,
        this.deps.localHostId,
      );
      const committed = this.deps.eventStore.append(updated, command.expectedVersion);
      return { result: "mutation", space: committed };
    } catch (error) {
      if (error instanceof ZenPolicyRejected) {
        throw new ZenError({ reason: error.code, spaceId: command.spaceId });
      }
      if (this.deps.eventStore.isConcurrencyConflict(error)) {
        throw new ZenError({ reason: "stale-version", spaceId: command.spaceId });
      }
      throw error;
    }
  }

  private addChecklistItem(
    command: Extract<ZenCommand, { command: "add-checklist-item" }>,
    windowId: WindowId,
    signal?: AbortSignal,
  ): ZenMutationResult {
    const space = this.loadSpaceOrFail(command.spaceId, windowId);
    if (this.deps.uuid === undefined) {
      throw new ZenError({ reason: "missing-capability", spaceId: command.spaceId });
    }
    const itemId = decodeZenChecklistItemId(this.deps.uuid());
    try {
      const updated = addChecklistItem(
        space,
        command.elementId,
        itemId,
        command.text,
        command.expectedVersion,
        command.expectedWidgetVersion,
      );
      if (signal?.aborted) {
        throw new ZenError({ reason: "interrupted", spaceId: command.spaceId });
      }
      const widgetVersion = widgetVersionFor(updated, command.elementId, "checklist");
      const committed = this.deps.eventStore.appendWidgetMutation(
        updated,
        command.expectedVersion,
        {
          operation: "checklist-item-added",
          elementId: command.elementId,
          itemId,
          widgetVersion,
        },
      );
      return { result: "mutation", space: committed };
    } catch (error) {
      throw this.widgetFailure(error, command.spaceId);
    }
  }

  private mutateWidget(
    command: Extract<
      ZenCommand,
      {
        command:
          | "save-notes"
          | "set-checklist-item-completed"
          | "reorder-checklist-item"
          | "remove-checklist-item";
      }
    >,
    windowId: WindowId,
    signal?: AbortSignal,
  ): ZenMutationResult {
    const space = this.loadSpaceOrFail(command.spaceId, windowId);
    try {
      const updated = processZenCommand(space, command, this.deps.localHostId);
      if (signal?.aborted) {
        throw new ZenError({ reason: "interrupted", spaceId: command.spaceId });
      }
      const widgetVersion = widgetVersionFor(
        updated,
        command.elementId,
        command.command === "save-notes" ? "notes" : "checklist",
      );
      const mutation: ZenWidgetMutation =
        command.command === "save-notes"
          ? { operation: "notes-saved", elementId: command.elementId, widgetVersion }
          : {
              operation:
                command.command === "set-checklist-item-completed"
                  ? "checklist-item-completed"
                  : command.command === "reorder-checklist-item"
                    ? "checklist-item-reordered"
                    : "checklist-item-removed",
              elementId: command.elementId,
              itemId: command.itemId,
              widgetVersion,
            };
      const committed = this.deps.eventStore.appendWidgetMutation(
        updated,
        command.expectedVersion,
        mutation,
      );
      return { result: "mutation", space: committed };
    } catch (error) {
      throw this.widgetFailure(error, command.spaceId);
    }
  }

  private widgetFailure(error: unknown, spaceId: ZenSpaceId): unknown {
    if (error instanceof ZenError) return error;
    if (error instanceof ZenPolicyRejected) {
      return new ZenError({ reason: error.code, spaceId });
    }
    if (this.deps.eventStore.isConcurrencyConflict(error)) {
      return new ZenError({ reason: "stale-version", spaceId });
    }
    return error;
  }

  private createSpace(command: ZenCreateSpaceCommand, windowId: WindowId): ZenCreateSpaceResult {
    // Verify window capability
    if (command.windowId !== windowId) {
      throw new ZenError({ reason: "wrong-window" });
    }

    // Check if space already exists for this window
    const existing = this.deps.loadSpaceByWindow(windowId);
    if (existing) {
      throw new ZenError({ reason: "duplicate-space", spaceId: existing.spaceId });
    }

    const space = createZenSpace(windowId, this.deps.localHostId, command.appearance);
    const committed = this.deps.eventStore.append(space, 0);
    return { result: "create-space", space: committed };
  }

  private mutate(
    command: Exclude<
      ZenCommand,
      ZenCreateSpaceCommand | ZenCreateTimerCommand | { command: "recover" }
    >,
    windowId: WindowId,
  ): ZenMutationResult {
    const space = this.loadSpaceOrFail(command.spaceId, windowId);

    try {
      const updated = processZenCommand(
        space,
        command,
        this.deps.localHostId,
        command.command === "timer-action" ? this.#timerClock() : undefined,
      );
      if (updated === space) return { result: "mutation", space };
      const committed = this.deps.eventStore.append(updated, command.expectedVersion);
      this.#syncTimerSchedules(committed);
      return { result: "mutation", space: committed };
    } catch (err) {
      if (err instanceof ZenPolicyRejected) {
        throw new ZenError({ reason: err.code, spaceId: command.spaceId });
      }
      if (this.deps.eventStore.isConcurrencyConflict(err)) {
        throw new ZenError({ reason: "stale-version", spaceId: command.spaceId });
      }
      throw err;
    }
  }

  private recover(
    command: { spaceId: ZenSpaceId; expectedVersion: AggregateVersion },
    windowId: WindowId,
  ): ZenRecoverResult {
    const space = this.loadSpaceOrFail(command.spaceId, windowId);
    try {
      const recovered = recoverSpace(space, command.expectedVersion);
      const committed = this.deps.eventStore.append(recovered, command.expectedVersion);
      this.#syncTimerSchedules(committed);
      return { result: "recover" };
    } catch (err) {
      if (err instanceof ZenPolicyRejected) {
        throw new ZenError({ reason: err.code, spaceId: command.spaceId });
      }
      if (this.deps.eventStore.isConcurrencyConflict(err)) {
        throw new ZenError({ reason: "stale-version", spaceId: command.spaceId });
      }
      throw err;
    }
  }

  private loadSpaceOrFail(spaceId: ZenSpaceId, windowId: WindowId): ZenSpace {
    const space = this.deps.loadSpace(spaceId);
    if (!space) {
      throw new ZenError({ reason: "unknown-space", spaceId });
    }
    if (space.windowId !== windowId) {
      throw new ZenError({ reason: "wrong-window", spaceId });
    }
    return space;
  }

  #currentRecipePreview(windowId: WindowId, threadId: ChatThreadId): ZenRecipePreview | null {
    this.#purgeExpiredRecipePreviews();
    for (const pending of [...this.#recipePreviews.values()].reverse()) {
      if (pending.windowId !== windowId || pending.threadId !== threadId) continue;
      return pending.preview;
    }
    return null;
  }

  #previewExpired(preview: ZenRecipePreview): boolean {
    return Date.parse(preview.expiresAt) <= this.#recipeClock();
  }

  #purgeExpiredRecipePreviews(): void {
    for (const [previewId, pending] of this.#recipePreviews) {
      if (this.#previewExpired(pending.preview)) this.#recipePreviews.delete(previewId);
    }
  }

  #assertRecipePreviewCapacity(
    windowId: WindowId,
    threadId: ChatThreadId,
    spaceId: ZenSpaceId,
  ): void {
    if (this.#recipePreviews.size >= MAX_ZEN_RECIPE_PREVIEWS) {
      throw new ZenError({
        reason: "limit-exceeded",
        spaceId,
        message:
          "Recipe preview capacity reached. Confirm, revise, or wait for an existing preview to expire.",
      });
    }
    const assistantPreviewCount = [...this.#recipePreviews.values()].filter(
      (pending) => pending.windowId === windowId && pending.threadId === threadId,
    ).length;
    if (assistantPreviewCount >= MAX_ZEN_RECIPE_PREVIEWS_PER_ASSISTANT) {
      throw new ZenError({
        reason: "limit-exceeded",
        spaceId,
        message:
          "Recipe preview capacity reached for this Navigator. Confirm, revise, or wait for an existing preview to expire.",
      });
    }
  }

  #assertRecipeToolAuthority(windowId: WindowId, space: ZenSpace): ZenAssistantProviderState {
    if (space.assistant === null || this.deps.assistantChat === undefined) {
      throw new ZenError({ reason: "missing-capability", spaceId: space.spaceId });
    }
    const view = this.deps.assistantChat.read(space.assistant.threadId);
    if (
      view === undefined ||
      view.thread.lifecycle !== "active" ||
      !this.isAssistantThread(windowId, view.thread.id)
    ) {
      throw new ZenError({ reason: "unavailable-source", spaceId: space.spaceId });
    }
    const provider = this.deps.assistantProviderState?.(view.thread);
    if (provider?.toolCapability !== "supported") {
      throw new ZenError({ reason: "missing-capability", spaceId: space.spaceId });
    }
    return provider;
  }

  private spaceForWindow(windowId: WindowId): ZenSpace {
    const space = this.deps.loadSpaceByWindow(windowId);
    if (space === null) throw new ZenError({ reason: "unknown-space" });
    if (space.windowId !== windowId) {
      throw new ZenError({ reason: "wrong-window", spaceId: space.spaceId });
    }
    return space;
  }

  #reconcileTimers(space: ZenSpace): ZenSpace {
    const updated = reconcileRunningTimers(space, this.#timerClock());
    if (updated === space) return space;
    try {
      return this.deps.eventStore.append(updated, space.version);
    } catch (error) {
      if (this.deps.eventStore.isConcurrencyConflict(error)) {
        const latest = this.deps.loadSpace(space.spaceId);
        return latest ?? space;
      }
      throw error;
    }
  }

  #reconcileScheduledTimer(
    space: ZenSpace,
    elementId: ReturnType<typeof decodeZenElementId>,
  ): ZenSpace {
    const updated = reconcileScheduledTimer(space, elementId, this.#timerClock());
    if (updated === space) return space;
    try {
      return this.deps.eventStore.append(updated, space.version);
    } catch (error) {
      if (this.deps.eventStore.isConcurrencyConflict(error)) {
        const latest = this.deps.loadSpace(space.spaceId);
        return latest ?? space;
      }
      throw error;
    }
  }

  #syncTimerSchedules(space: ZenSpace): void {
    const spaceId = String(space.spaceId);
    const runningIds = new Set(
      space.elements
        .filter((element) => element.kind === "timer" && element.status === "running")
        .map((element) => String(element.elementId)),
    );
    for (const [elementId, schedule] of this.#timerSchedules) {
      if (schedule.spaceId !== spaceId) continue;
      if (runningIds.has(elementId)) continue;
      schedule.cancel();
      this.#timerSchedules.delete(elementId);
    }
    const clock = this.#timerClock();
    for (const element of space.elements) {
      if (element.kind !== "timer" || element.status !== "running") continue;
      const key = String(element.elementId);
      const token = `${element.startedAt}:${element.remainingMs}:${element.clockSessionId}`;
      if (this.#timerSchedules.get(key)?.token === token) continue;
      this.#timerSchedules.get(key)?.cancel();
      const delayMs = timerRemainingMs(element, clock);
      const cancel = this.#scheduleTimer(delayMs, () => {
        if (this.#timerSchedules.get(key)?.token !== token) return;
        this.#timerSchedules.delete(key);
        const latest = this.deps.loadSpace(space.spaceId);
        if (latest === null) return;
        const reconciled = this.#reconcileScheduledTimer(latest, element.elementId);
        this.#syncTimerSchedules(reconciled);
      });
      this.#timerSchedules.set(key, { spaceId, token, cancel });
    }
  }
}

function allocateZenElementZOrder(space: ZenSpace): {
  readonly space: ZenSpace;
  readonly zIndex: number;
} {
  const nextZIndex = Math.max(0, ...space.elements.map((element) => element.zIndex)) + 1;
  if (nextZIndex <= MAX_ZEN_ELEMENT_Z_INDEX) {
    return { space, zIndex: nextZIndex };
  }
  const elements = [...space.elements]
    .sort((left, right) => left.zIndex - right.zIndex)
    .map((element, index) => ({ ...element, zIndex: index + 1 }));
  return {
    space: { ...space, elements },
    zIndex: elements.length + 1,
  };
}

function isWidgetCommand(command: ZenCommand): command is Extract<
  ZenCommand,
  {
    command:
      | "create-widget"
      | "save-notes"
      | "add-checklist-item"
      | "set-checklist-item-completed"
      | "reorder-checklist-item"
      | "remove-checklist-item";
  }
> {
  return (
    command.command === "create-widget" ||
    command.command === "save-notes" ||
    command.command === "add-checklist-item" ||
    command.command === "set-checklist-item-completed" ||
    command.command === "reorder-checklist-item" ||
    command.command === "remove-checklist-item"
  );
}

function widgetVersionFor(
  space: ZenSpace,
  elementId: ReturnType<typeof decodeZenElementId>,
  kind: "notes" | "checklist",
): AggregateVersion {
  const element = space.elements.find((candidate) => candidate.elementId === elementId);
  if (element === undefined)
    throw new ZenError({ reason: "unknown-element", spaceId: space.spaceId });
  if (element.kind !== kind) {
    throw new ZenError({ reason: "wrong-widget-kind", spaceId: space.spaceId });
  }
  return element.widgetVersion;
}

function recipeInitialState(
  recipe: ZenWidgetRecipeDraft,
): Record<string, string | number | boolean> {
  return Object.fromEntries(
    recipe.fields.flatMap((field) =>
      field.defaultValue === undefined ? [] : [[field.key, field.defaultValue]],
    ),
  );
}
