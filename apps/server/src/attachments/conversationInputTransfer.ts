import { randomUUID } from "node:crypto";
import { Schema } from "effect";
import type { ProviderAttachmentInput } from "@octant/contracts";
import {
  decodeConversationInputManifest,
  decodeConversationInputReceipt,
  type ConversationInputManifest,
  type ConversationInputPolicy,
  type ConversationInputPurpose,
  type ConversationInputReceipt,
  type ConversationInputReference,
} from "@octant/contracts/conversation-inputs";
import { ManagedAttachmentStore } from "./managedAttachmentStore";
import { prepareConversationInputs } from "./conversationInputs";

const uuid = Schema.decodeUnknownSync(Schema.UUID);
const SNAPSHOT_PREFIX = "continuation-";
const directories = { chat: "threads", work: "work-threads", code: "code-threads" } as const;
export interface ConversationInputOwner {
  readonly mode: "chat" | "work" | "code";
  readonly threadId: string;
  readonly projectId?: string | null;
}
export interface ConversationInputTarget {
  readonly providerInstanceId: string;
  readonly modelId: string;
}
export type ConversationInputTransferResult =
  | {
      readonly status: "ready";
      readonly manifest: ConversationInputManifest;
      readonly attachments: ReadonlyArray<ProviderAttachmentInput>;
      readonly receipt?: ConversationInputReceipt;
      readonly inputsCurrent?: () => boolean;
    }
  | { readonly status: "refused"; readonly message: string };
export interface ConversationInputTransferRequest {
  readonly owner: ConversationInputOwner;
  readonly purpose: ConversationInputPurpose;
  readonly target: ConversationInputTarget;
  readonly policy?: ConversationInputPolicy;
  readonly previous?: ConversationInputReceipt;
  readonly selection?: {
    readonly inputs?: ReadonlyArray<ConversationInputReference>;
    readonly inputUnavailable?: boolean;
  };
  readonly current: () => boolean;
}

/** Immutable handoff manifests use the same path, digest and purge boundary as attachments. */
export class ConversationInputTransfer {
  readonly #stores: Readonly<Record<ConversationInputOwner["mode"], ManagedAttachmentStore>>;
  readonly #options: {
    readonly ownerCurrent: (owner: ConversationInputOwner) => boolean;
    readonly sourceCurrent: (input: ConversationInputReference) => boolean;
    readonly read: (input: ConversationInputReference) => Promise<Uint8Array | undefined>;
    readonly supports: (target: ConversationInputTarget, mediaType: string) => boolean;
  };
  constructor(options: {
    readonly dataDirectory: string;
    readonly ownerCurrent: (owner: ConversationInputOwner) => boolean;
    readonly sourceCurrent: (input: ConversationInputReference) => boolean;
    readonly read: (input: ConversationInputReference) => Promise<Uint8Array | undefined>;
    readonly supports: (target: ConversationInputTarget, mediaType: string) => boolean;
  }) {
    this.#options = options;
    const store = (mode: ConversationInputOwner["mode"]) =>
      new ManagedAttachmentStore(options.dataDirectory, {
        scopesDirectory: directories[mode],
        maxBytes: 131072,
        decodeScopeId: uuid,
        // Ordinary attachment recovery skips this namespace; whole-thread purge
        // still removes it. Snapshot recovery owns only these prefixed records.
        decodeAttachmentId: (value) => {
          if (typeof value !== "string" || !value.startsWith(SNAPSHOT_PREFIX))
            throw new Error("Invalid continuation input identity.");
          return `${SNAPSHOT_PREFIX}${uuid(value.slice(SNAPSHOT_PREFIX.length))}`;
        },
        tooLarge: () => new Error("Continuation inputs exceed their metadata bound."),
        empty: () => new Error("Continuation input manifest is empty."),
        invalidDisplayName: (message) => new Error(message),
      });
    this.#stores = { chat: store("chat"), work: store("work"), code: store("code") };
  }

  async read(
    owner: ConversationInputOwner,
    receipt: ConversationInputReceipt,
  ): Promise<ConversationInputManifest | undefined> {
    try {
      if (!this.#options.ownerCurrent(owner)) return undefined;
      const reference = decodeConversationInputReceipt(receipt);
      const bytes = await this.#stores[owner.mode].read({
        scopeId: owner.threadId,
        attachmentId: `${SNAPSHOT_PREFIX}${reference.snapshotId}`,
        displayName: "continuation.json",
        size: reference.byteLength,
        hash: reference.digest,
        finalizedAt: new Date(0).toISOString(),
      });
      const manifest = decodeConversationInputManifest(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
      return manifest.purpose === reference.purpose &&
        manifest.items.filter((item) => item.status === "included").length === reference.included &&
        manifest.items.filter((item) => item.status === "omitted").length +
          (manifest.omittedUnlistedInputs ?? 0) ===
          reference.omitted &&
        manifest.sourceMetadataUnavailable === reference.sourceMetadataUnavailable &&
        (reference.policy === "text-only"
          ? manifest.items.every((item) => item.status === "omitted")
          : manifest.omittedUnlistedInputs === undefined &&
            manifest.sourceMetadataUnavailable === undefined &&
            manifest.items.every((item) => item.status === "included"))
        ? manifest
        : undefined;
    } catch {
      return undefined;
    }
  }

  async prepare(input: ConversationInputTransferRequest): Promise<ConversationInputTransferResult> {
    const refuse = (message: string): ConversationInputTransferResult => ({
      status: "refused",
      message,
    });
    if (!input.current() || !this.#options.ownerCurrent(input.owner))
      return refuse("The continuation is no longer authorized. No inputs were sent.");
    const previous =
      input.previous === undefined ? undefined : await this.read(input.owner, input.previous);
    if (
      input.previous !== undefined &&
      (previous === undefined || previous.purpose !== input.purpose)
    )
      return refuse(
        "The admitted source input manifest is unavailable. Restore it or explicitly start a new handoff.",
      );
    const policy = input.policy ?? input.previous?.policy ?? "preserve";
    if (
      policy === "preserve" &&
      (previous?.omittedUnlistedInputs !== undefined ||
        previous?.sourceMetadataUnavailable === true)
    )
      return refuse(
        "The omitted originals were not retained by this text-only admission. Start a new handoff to select them explicitly.",
      );
    if (
      previous === undefined &&
      input.selection?.inputUnavailable === true &&
      policy === "preserve"
    )
      return refuse(
        "A selected source input is unavailable. Restore it or explicitly choose text-only context.",
      );
    const inputs = previous?.items.map((item) => item.input) ?? input.selection?.inputs ?? [];
    const inputsCurrent = () =>
      this.#options.ownerCurrent(input.owner) &&
      (policy === "text-only" || inputs.every(this.#options.sourceCurrent));
    const current = () => input.current() && inputsCurrent();
    let prepared = await prepareConversationInputs({
      purpose: input.purpose,
      sourceMetadataUnavailable:
        previous?.sourceMetadataUnavailable === true || input.selection?.inputUnavailable === true,
      inputs,
      policy,
      supports: (type) => this.#options.supports(input.target, type),
      current,
      read: this.#options.read,
    });
    if (prepared.status === "refused")
      return refuse(
        `The source input ${prepared.items.map((item) => `${item.input.displayName} (${item.reason})`).join(", ") || "selection"} could not be transferred. Retry, remove it, or explicitly choose text-only context. Nothing was sent.`,
      );
    if (previous?.omittedUnlistedInputs !== undefined)
      prepared = {
        ...prepared,
        manifest: { ...prepared.manifest, omittedUnlistedInputs: previous.omittedUnlistedInputs },
      };
    if (inputs.length === 0 && prepared.manifest.sourceMetadataUnavailable !== true)
      return { ...prepared, inputsCurrent };
    if (input.previous !== undefined && policy === input.previous.policy)
      return { ...prepared, inputsCurrent, receipt: input.previous };
    const store = this.#stores[input.owner.mode];
    const snapshotId = uuid(randomUUID());
    const attachmentId = `${SNAPSHOT_PREFIX}${snapshotId}`;
    try {
      const staged = await store.stage({
        scopeId: input.owner.threadId,
        attachmentId,
        displayName: "continuation.json",
        bytes: new TextEncoder().encode(JSON.stringify(prepared.manifest)),
      });
      const retained = await store.finalize(staged);
      if (!current()) {
        await store.remove(input.owner.threadId, attachmentId);
        return refuse(
          "The continuation was revoked while its inputs were prepared. Nothing was sent.",
        );
      }
      return {
        ...prepared,
        inputsCurrent,
        receipt: decodeConversationInputReceipt({
          snapshotId,
          purpose: input.purpose,
          policy,
          byteLength: retained.size,
          digest: retained.hash,
          included: prepared.manifest.items.filter((item) => item.status === "included").length,
          omitted:
            prepared.manifest.items.filter((item) => item.status === "omitted").length +
            (prepared.manifest.omittedUnlistedInputs ?? 0),
          ...(prepared.manifest.sourceMetadataUnavailable === true
            ? { sourceMetadataUnavailable: true }
            : {}),
        }),
      };
    } catch {
      return refuse(
        "The selected source inputs could not be retained for this continuation. Retry; no reduced-input request was sent.",
      );
    }
  }

  async recover(): Promise<void> {
    for (const store of Object.values(this.#stores)) await store.recover();
  }
}
