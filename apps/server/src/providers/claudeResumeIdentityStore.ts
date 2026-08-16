import type { ProviderInstanceId } from "@octant/contracts";
import type { ClaudeResumeIdentity } from "./claudeDriver";

export class ClaudeResumeIdentityStoreClosed extends Error {
  override readonly name = "ClaudeResumeIdentityStoreClosed";
  constructor() {
    super("Claude resume identity storage is closed.");
  }
}

export class ClaudeResumeIdentityStoreCapacityExceeded extends Error {
  override readonly name = "ClaudeResumeIdentityStoreCapacityExceeded";
  constructor() {
    super("Claude resume identity capacity is exhausted.");
  }
}

export interface ClaudeResumeIdentityStoreOptions {
  readonly maxIdentities?: number;
  readonly maxIdentitiesPerProvider?: number;
}

const DEFAULT_MAX_IDENTITIES = 1_024;
const DEFAULT_MAX_IDENTITIES_PER_PROVIDER = 128;

export class ClaudeResumeIdentityStore {
  readonly #identities = new Map<ProviderInstanceId, Map<string, ClaudeResumeIdentity>>();
  readonly #maxIdentities: number;
  readonly #maxIdentitiesPerProvider: number;
  #identityCount = 0;
  #closed = false;

  constructor(options: ClaudeResumeIdentityStoreOptions = {}) {
    this.#maxIdentities = options.maxIdentities ?? DEFAULT_MAX_IDENTITIES;
    this.#maxIdentitiesPerProvider =
      options.maxIdentitiesPerProvider ?? DEFAULT_MAX_IDENTITIES_PER_PROVIDER;
  }

  async lookup(
    input: {
      readonly providerInstanceId: ProviderInstanceId;
      readonly sdkSessionId: string;
    },
    signal: AbortSignal,
  ): Promise<ClaudeResumeIdentity | undefined> {
    await this.#checkpoint(signal);
    return this.#identities.get(input.providerInstanceId)?.get(input.sdkSessionId);
  }

  async put(identity: ClaudeResumeIdentity, signal: AbortSignal): Promise<void> {
    await this.#checkpoint(signal);
    const existingProviderIdentities = this.#identities.get(identity.providerInstanceId);
    const replacesExisting = existingProviderIdentities?.has(identity.sdkSessionId) ?? false;
    if (
      !replacesExisting &&
      (this.#identityCount >= this.#maxIdentities ||
        (existingProviderIdentities?.size ?? 0) >= this.#maxIdentitiesPerProvider)
    ) {
      throw new ClaudeResumeIdentityStoreCapacityExceeded();
    }
    const providerIdentities = existingProviderIdentities ?? new Map();
    const stored = Object.freeze({ ...identity });
    providerIdentities.set(identity.sdkSessionId, stored);
    this.#identities.set(identity.providerInstanceId, providerIdentities);
    if (!replacesExisting) this.#identityCount += 1;
  }

  async remove(
    input: {
      readonly providerInstanceId: ProviderInstanceId;
      readonly sdkSessionId: string;
    },
    signal: AbortSignal,
  ): Promise<void> {
    await this.#checkpoint(signal);
    const providerIdentities = this.#identities.get(input.providerInstanceId);
    if (providerIdentities?.delete(input.sdkSessionId)) this.#identityCount -= 1;
    if (providerIdentities?.size === 0) this.#identities.delete(input.providerInstanceId);
  }

  async removeProvider(providerInstanceId: ProviderInstanceId, signal: AbortSignal): Promise<void> {
    await this.#checkpoint(signal);
    const providerIdentities = this.#identities.get(providerInstanceId);
    if (providerIdentities === undefined) return;
    this.#identities.delete(providerInstanceId);
    this.#identityCount -= providerIdentities.size;
  }

  identityCount(): number {
    return this.#identityCount;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#identities.clear();
    this.#identityCount = 0;
  }

  #assertOpen(): void {
    if (this.#closed) throw new ClaudeResumeIdentityStoreClosed();
  }

  async #checkpoint(signal: AbortSignal): Promise<void> {
    this.#assertOpen();
    signal.throwIfAborted();
    await Promise.resolve();
    this.#assertOpen();
    signal.throwIfAborted();
  }
}
