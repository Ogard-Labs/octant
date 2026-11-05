import {
  decodeCommandCredentialBinding,
  decodeCommandCredentialRequest,
  decodeCommandCredentialReceipt,
  type CommandCredentialBinding,
  type CommandCredentialDefinition,
  type CommandCredentialJournalRecord,
  type CommandCredentialReceipt,
  type CommandCredentialRequest,
  type CommandCredentialResult,
} from "@octant/contracts/command-credentials";
import {
  commandCredentialDefinitionAllowed,
  commandCredentialPostureAllowed,
} from "@octant/domain/command-credential-policy";
import { decodeWindowId } from "@octant/contracts";
export interface CommandCredentialContext {
  readonly windowId: string;
  readonly threadId: string;
  readonly projectId: string;
  readonly root: string;
  readonly authorityKey: string;
  readonly executionPolicy: string;
  readonly current: () => boolean;
  readonly revalidate: () => Promise<boolean>;
}
type Outcome = Omit<CommandCredentialReceipt, "kind" | "requestId">;
interface Pending {
  readonly request: CommandCredentialRequest;
  readonly binding: CommandCredentialBinding;
  readonly context: CommandCredentialContext;
  readonly abort: AbortController;
  readonly operationId: string;
  readonly ends: number;
  readonly wait: Promise<CommandCredentialReceipt>;
  readonly finish: (value: CommandCredentialReceipt) => void;
  state: "pending" | "running" | "settled";
  started: boolean;
  receipt: CommandCredentialReceipt | undefined;
  settledAt: number | undefined;
  revoked: boolean;
}
export interface CommandCredentialBindingsOptions {
  readonly now: () => number;
  readonly uuid: () => string;
  readonly canConfigure: (windowId: string, projectId: string) => boolean;
  readonly context: (
    windowId: string,
    threadId: string,
  ) => Promise<CommandCredentialContext | undefined>;
  readonly pin: (executable: string) => Promise<
    | {
        readonly executable: string;
        readonly digest: string;
        readonly credentialExecutable: string;
        readonly credentialExecutableDigest: string;
        readonly credentialVersion: string;
      }
    | undefined
  >;
  readonly execute: (
    binding: CommandCredentialBinding,
    context: CommandCredentialContext,
    signal: AbortSignal,
    current: () => boolean,
    onStart: () => void,
  ) => Promise<Outcome>;
  readonly record: (record: CommandCredentialJournalRecord) => void;
  readonly records: ReadonlyArray<CommandCredentialJournalRecord>;
}
const refused = (
  reason: Extract<CommandCredentialResult, { kind: "command-credential-refused" }>["reason"],
  message: string,
): CommandCredentialResult => ({ kind: "command-credential-refused", reason, message });
export class CommandCredentialBindings {
  readonly #options: CommandCredentialBindingsOptions;
  readonly #bindings = new Map<string, CommandCredentialBinding>();
  readonly #pending = new Map<string, Pending>();
  readonly #timer: ReturnType<typeof setInterval>;
  #closed = false;
  #linkEpoch = 0;
  constructor(options: CommandCredentialBindingsOptions) {
    this.#options = options;
    for (const record of options.records) {
      if (record.name === "command-binding.saved")
        this.#bindings.set(record.binding.bindingId, record.binding);
      else if (record.name === "command-binding.removed") this.#bindings.delete(record.bindingId);
    }
    this.#timer = setInterval(() => this.#sweep(), 1000);
    this.#timer.unref();
  }
  view(windowId: string, projectId?: string, threadId?: string): CommandCredentialResult {
    this.#sweep();
    return {
      kind: "command-credential-view",
      bindings: [...this.#bindings.values()].filter(
        (binding) =>
          (projectId === undefined || String(binding.definition.projectId) === projectId) &&
          this.#options.canConfigure(windowId, String(binding.definition.projectId)),
      ),
      requests: [...this.#pending.values()]
        .filter(
          (entry) =>
            entry.context.windowId === windowId &&
            (threadId === undefined || entry.context.threadId === threadId) &&
            (projectId === undefined || entry.context.projectId === projectId) &&
            entry.state !== "settled" &&
            this.#visible(entry),
        )
        .map((entry) => ({ ...entry.request, state: entry.state })),
      receipts: [...this.#pending.values()]
        .filter(
          (entry) =>
            entry.context.windowId === windowId &&
            (threadId === undefined || entry.context.threadId === threadId) &&
            (projectId === undefined || entry.context.projectId === projectId) &&
            this.#visible(entry),
        )
        .flatMap((entry) => (entry.receipt === undefined ? [] : [entry.receipt])),
    };
  }
  async save(
    windowId: string,
    definition: CommandCredentialDefinition,
    bindingId?: string,
    expectedRevision?: number,
  ): Promise<CommandCredentialResult> {
    if (this.#closed || !this.#options.canConfigure(windowId, String(definition.projectId)))
      return refused("unauthorized", "This Project is not available to this window.");
    if (!commandCredentialDefinitionAllowed(definition))
      return refused(
        "invalid",
        "Choose a fixed executable, Project directory and credential environment names.",
      );
    const previous = bindingId === undefined ? undefined : this.#bindings.get(bindingId);
    if (
      bindingId !== undefined &&
      (previous === undefined ||
        previous.revision !== expectedRevision ||
        String(previous.definition.projectId) !== String(definition.projectId))
    )
      return refused("stale", "The command binding changed. Review it again.");
    if (previous === undefined && this.#bindings.size >= 64)
      return refused("limit", "Remove another binding first.");
    const pinned = await this.#options.pin(definition.executable);
    if (
      pinned === undefined ||
      !commandCredentialDefinitionAllowed({ ...definition, executable: pinned.executable })
    )
      return refused("invalid", "That executable could not be verified.");
    if (
      this.#closed ||
      !this.#options.canConfigure(windowId, String(definition.projectId)) ||
      (bindingId !== undefined && this.#bindings.get(bindingId) !== previous)
    )
      return refused("stale", "The Project or binding changed during review.");
    if (previous === undefined && this.#bindings.size >= 64)
      return refused("limit", "Remove another binding first.");
    const binding = decodeCommandCredentialBinding({
      kind: "command-credential-binding",
      bindingId: bindingId ?? this.#options.uuid(),
      revision: (previous?.revision ?? 0) + 1,
      definition: { ...definition, executable: pinned.executable },
      executableDigest: pinned.digest,
      credentialExecutable: pinned.credentialExecutable,
      credentialExecutableDigest: pinned.credentialExecutableDigest,
      credentialVersion: pinned.credentialVersion,
    });
    try {
      this.#options.record({
        name: "command-binding.saved",
        binding,
        windowId: decodeWindowId(windowId),
      });
    } catch {
      return refused("journal-unavailable", "The binding could not be recorded.");
    }
    this.#bindings.set(binding.bindingId, binding);
    this.#invalidate(binding.bindingId);
    return this.view(windowId);
  }
  remove(windowId: string, bindingId: string, expectedRevision: number): CommandCredentialResult {
    const binding = this.#bindings.get(bindingId);
    if (
      binding === undefined ||
      !this.#options.canConfigure(windowId, String(binding.definition.projectId))
    )
      return refused("unauthorized", "This command binding is not available.");
    if (binding.revision !== expectedRevision)
      return refused("stale", "The binding changed. Refresh it first.");
    try {
      this.#options.record({
        name: "command-binding.removed",
        bindingId: binding.bindingId,
        revision: binding.revision,
        windowId: decodeWindowId(windowId),
      });
    } catch {
      return refused("journal-unavailable", "The removal could not be recorded.");
    }
    this.#bindings.delete(bindingId);
    this.#invalidate(bindingId);
    return this.view(windowId);
  }
  async review(
    windowId: string,
    threadId: string,
    bindingId: string,
    operationId: string,
  ): Promise<CommandCredentialResult> {
    this.#sweep();
    const replay = [...this.#pending.values()].find(
      (entry) => entry.context.windowId === windowId && entry.operationId === operationId,
    );
    if (replay !== undefined && !this.#visible(replay))
      return refused("unauthorized", "This request is no longer available to this Code task.");
    if (replay !== undefined)
      return replay.context.threadId === threadId &&
        String(replay.request.binding.bindingId) === bindingId
        ? (replay.receipt ?? this.view(windowId, replay.context.projectId))
        : refused("stale", "This operation already names another command.");
    const binding = this.#bindings.get(bindingId);
    const context = await this.#options.context(windowId, threadId);
    if (
      this.#closed ||
      binding === undefined ||
      context === undefined ||
      !context.current() ||
      context.windowId !== windowId ||
      context.threadId !== threadId ||
      String(binding.definition.projectId) !== context.projectId ||
      this.#bindings.get(bindingId) !== binding
    )
      return refused("unauthorized", "This command is not available to this Code task.");
    if (!commandCredentialPostureAllowed(context.executionPolicy))
      return refused(
        "posture-unsupported",
        "Credential commands are unavailable in Plan or an unsupported access posture.",
      );
    if (
      this.#pending.size >= 64 ||
      [...this.#pending.values()].some(
        (entry) => entry.context.threadId === threadId && entry.state !== "settled",
      )
    )
      return refused("limit", "Finish the existing credential command first.");
    const ends = this.#options.now() + 180000;
    const request = decodeCommandCredentialRequest({
      requestId: this.#options.uuid(),
      binding,
      threadId,
      expiresAt: new Date(Date.now() + 180000).toISOString(),
      executionPolicy: context.executionPolicy,
      state: "pending",
    });
    let finish: ((value: CommandCredentialReceipt) => void) | undefined;
    const wait = new Promise<CommandCredentialReceipt>((resolve) => {
      finish = resolve;
    });
    if (finish === undefined) throw new Error("Command completion is unavailable.");
    this.#pending.set(request.requestId, {
      request,
      binding,
      context,
      operationId,
      ends,
      state: "pending",
      started: false,
      receipt: undefined,
      settledAt: undefined,
      revoked: false,
      abort: new AbortController(),
      wait,
      finish,
    });
    return this.view(windowId, context.projectId);
  }
  async approve(windowId: string, requestId: string): Promise<CommandCredentialResult> {
    const entry = this.#pending.get(requestId);
    if (entry === undefined || entry.context.windowId !== windowId)
      return refused("unauthorized", "This request is not available to this window.");
    if (!this.#visible(entry))
      return refused("unauthorized", "This request is no longer available to this Code task.");
    if (entry.state !== "pending")
      return this.#published(entry, entry.receipt ?? (await entry.wait));
    if (!this.#current(entry))
      return this.#settle(entry, {
        status: this.#options.now() >= entry.ends ? "expired" : "refused",
        effect: "none",
        output: "",
        truncated: false,
      });
    entry.state = "running";
    const epoch = this.#linkEpoch;
    const current = () => this.#current(entry) && this.#linkEpoch === epoch;
    try {
      this.#record(entry, "approved", "none");
      const context = await this.#options.context(windowId, entry.context.threadId);
      if (
        context === undefined ||
        context.authorityKey !== entry.context.authorityKey ||
        !current()
      )
        return this.#settle(entry, {
          status: "cancelled",
          effect: "none",
          output: "",
          truncated: false,
        });
      const result = await this.#options.execute(
        entry.request.binding,
        context,
        entry.abort.signal,
        current,
        () => {
          entry.started = true;
          try {
            this.#record(entry, "started", "possible");
          } catch {
            entry.abort.abort();
          }
        },
      );
      return this.#published(entry, this.#settle(entry, result));
    } catch {
      return this.#settle(entry, {
        status: "failed",
        effect: entry.started ? "possible" : "none",
        output: "",
        truncated: false,
      });
    }
  }
  cancel(windowId: string, requestId: string, denied = false): CommandCredentialResult {
    const entry = this.#pending.get(requestId);
    if (entry === undefined || entry.context.windowId !== windowId)
      return refused("unauthorized", "This request is not available to this window.");
    if (entry.state === "settled")
      return this.#visible(entry)
        ? (entry.receipt ?? refused("stale", "This request has settled."))
        : refused("unauthorized", "This request is no longer available.");
    entry.abort.abort();
    const result = {
      status: denied ? ("denied" as const) : ("cancelled" as const),
      effect: entry.started ? ("possible" as const) : ("none" as const),
      output: "",
      truncated: false,
    };
    return entry.state === "pending"
      ? this.#settle(entry, result)
      : decodeCommandCredentialReceipt({
          kind: "command-credential-receipt",
          requestId: entry.request.requestId,
          ...result,
        });
  }
  async wait(windowId: string, requestId: string): Promise<CommandCredentialResult> {
    const entry = this.#pending.get(requestId);
    if (entry === undefined || entry.context.windowId !== windowId || !this.#visible(entry))
      return refused("unauthorized", "This request is not available.");
    return this.#published(entry, entry.receipt ?? (await entry.wait));
  }
  #visible(entry: Pending): boolean {
    try {
      return (
        !this.#closed &&
        !entry.revoked &&
        this.#options.canConfigure(entry.context.windowId, entry.context.projectId) &&
        entry.context.current()
      );
    } catch {
      return false;
    }
  }
  #published(entry: Pending, receipt: CommandCredentialReceipt): CommandCredentialResult {
    return this.#visible(entry)
      ? receipt
      : refused("unauthorized", "This request is no longer available to this Code task.");
  }

  windowRevoked(windowId: string): void {
    for (const entry of this.#pending.values())
      if (entry.context.windowId === windowId) {
        entry.revoked = true;
        if (entry.state !== "settled") this.cancel(windowId, entry.request.requestId);
      }
  }
  linkChanged(): void {
    this.#linkEpoch += 1;
    for (const entry of this.#pending.values())
      if (entry.state !== "settled") this.cancel(entry.context.windowId, entry.request.requestId);
  }
  close(): void {
    this.#closed = true;
    clearInterval(this.#timer);
    for (const entry of this.#pending.values())
      if (entry.state !== "settled") this.cancel(entry.context.windowId, entry.request.requestId);
  }
  #current(entry: Pending): boolean {
    return (
      !this.#closed &&
      !entry.abort.signal.aborted &&
      entry.state !== "settled" &&
      (entry.started || this.#options.now() < entry.ends) &&
      this.#bindings.get(entry.request.binding.bindingId) === entry.binding &&
      this.#visible(entry) &&
      commandCredentialPostureAllowed(entry.context.executionPolicy)
    );
  }
  #invalidate(bindingId: string): void {
    for (const entry of this.#pending.values())
      if (entry.request.binding.bindingId === bindingId && entry.state !== "settled")
        this.cancel(entry.context.windowId, entry.request.requestId);
  }
  #record(
    entry: Pending,
    status: "approved" | "started" | CommandCredentialReceipt["status"],
    effect: CommandCredentialReceipt["effect"],
    exitCode?: number,
  ): void {
    this.#options.record({
      name: "command-binding.run",
      requestId: entry.request.requestId,
      bindingId: entry.request.binding.bindingId,
      revision: entry.request.binding.revision,
      threadId: entry.request.threadId,
      windowId: decodeWindowId(entry.context.windowId),
      status,
      effect,
      ...(exitCode === undefined ? {} : { exitCode }),
    });
  }
  #settle(entry: Pending, outcome: Outcome): CommandCredentialReceipt {
    const receipt = decodeCommandCredentialReceipt({
      kind: "command-credential-receipt",
      requestId: entry.request.requestId,
      ...outcome,
    });
    entry.receipt = receipt;
    entry.state = "settled";
    entry.settledAt = this.#options.now();
    try {
      this.#record(entry, receipt.status, receipt.effect, receipt.exitCode);
    } catch {
      entry.receipt = {
        ...receipt,
        status: "failed",
        output: "The command outcome could not be recorded.",
        truncated: false,
      };
    }
    entry.finish(entry.receipt);
    return entry.receipt;
  }
  #sweep(): void {
    for (const [id, entry] of this.#pending) {
      if (entry.state !== "settled" && !this.#current(entry))
        this.cancel(entry.context.windowId, id);
      if (
        entry.state === "settled" &&
        entry.settledAt !== undefined &&
        this.#options.now() > entry.settledAt + 60000
      )
        this.#pending.delete(id);
    }
  }
}
