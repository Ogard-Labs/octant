/**
 * Settings › Secret stores: link a secret store, and point a provider's API
 * key at an item in it.
 *
 * The broker holds the pointer and fetches the value when it is used. This
 * service only validates who the pointer is for, asks the broker to write or
 * remove it, and journals the change. It never receives a value: nothing it
 * calls returns one, so there is no value here to log, journal, or return.
 *
 * A change is made first and journaled after. When the journal refuses, the
 * change is undone where it can be, and the answer says which case it is.
 */

import type { ProviderInstance, ProviderInstanceId, WindowId } from "@octant/contracts";
import {
  decodeSecretStoresResult,
  SECRET_STORE_REFUSAL_MESSAGES,
  type AwsCliKeyReference,
  type SecretStoreJournalRecord,
  type SecretStoreKind,
  type SecretStoreRefusalReason,
  type SecretStoresResult,
} from "@octant/contracts/secret-stores";
import { usesStoredKey } from "../providers/providerCredentialRoutes";
import type { SecretStoreBrokerClient, StoreCheckStatus } from "./secretStoreBrokerClient";
import type { SecretStoresJournal } from "./secretStoresJournal";

export interface SecretStoresServiceOptions {
  /** Undefined on a host with no credential broker. */
  readonly broker: SecretStoreBrokerClient | undefined;
  readonly journal: SecretStoresJournal;
  readonly readProviderInstances: () => ReadonlyArray<ProviderInstance>;
  /** Checks the provider again, so its card stops saying Needs key. */
  readonly reprobe?: (windowId: WindowId, instance: ProviderInstance) => Promise<void>;
}

export interface SecretStoresService {
  readonly view: () => Promise<SecretStoresResult>;
  readonly linkStore: (windowId: WindowId, store: SecretStoreKind) => Promise<SecretStoresResult>;
  readonly unlinkStore: (windowId: WindowId, store: SecretStoreKind) => Promise<SecretStoresResult>;
  readonly checkReference: (
    store: SecretStoreKind,
    reference: string,
  ) => Promise<SecretStoresResult>;
  readonly pointProviderKey: (
    windowId: WindowId,
    input: { instanceId: ProviderInstanceId; store: SecretStoreKind; reference: string },
  ) => Promise<SecretStoresResult>;
  readonly clearProviderKeyReference: (
    windowId: WindowId,
    instanceId: ProviderInstanceId,
  ) => Promise<SecretStoresResult>;
  readonly readProviderKeyReference: (
    instanceId: ProviderInstanceId,
  ) => Promise<SecretStoresResult>;
  readonly pointAwsCliKey: (
    windowId: WindowId,
    pointer: AwsCliKeyReference,
  ) => Promise<SecretStoresResult>;
  readonly clearAwsCliKey: (windowId: WindowId) => Promise<SecretStoresResult>;
  readonly readAwsCliKey: () => Promise<SecretStoresResult>;
}

/** Both halves of the AWS key pair's reference, journaled as one append. */
function awsCliRecords(
  pointer: AwsCliKeyReference,
  change:
    | { readonly name: "credential-reference.set"; readonly replaced: boolean }
    | { readonly name: "credential-reference.cleared" },
  windowId: WindowId,
): ReadonlyArray<SecretStoreJournalRecord> {
  const parts = [
    ["access-key-id", pointer.accessKeyIdReference],
    ["secret-access-key", pointer.secretAccessKeyReference],
  ] as const;
  return parts.map(([part, reference]) => ({
    ...change,
    target: { kind: "aws-cli-key", part },
    store: pointer.store,
    reference,
    windowId,
  }));
}

export function secretStoresRefusal(
  reason: SecretStoreRefusalReason,
  message: string = SECRET_STORE_REFUSAL_MESSAGES[reason],
): SecretStoresResult {
  return { kind: "secret-stores-refused", reason, message };
}

const CHECK_REFUSAL: Readonly<
  Record<Exclude<StoreCheckStatus, "found">, SecretStoreRefusalReason>
> = {
  locked: "store-locked",
  missing: "item-missing",
  unavailable: "store-unavailable",
  "not-linked": "not-linked",
  "invalid-reference": "invalid-reference",
};

export function createSecretStoresService(
  options: SecretStoresServiceOptions,
): SecretStoresService {
  const { broker } = options;
  // One change at a time: a point reads the old reference, writes the new one,
  // and journals, and no other change can run between those steps.
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task);
    queue = run.catch(() => undefined);
    return run;
  };

  const journaled = (
    record: SecretStoreJournalRecord | ReadonlyArray<SecretStoreJournalRecord>,
  ): boolean => {
    try {
      options.journal.record(record);
      return true;
    } catch {
      return false;
    }
  };

  const viewFromBroker = async (): Promise<SecretStoresResult> => {
    if (broker === undefined) {
      return decodeSecretStoresResult({
        kind: "secret-stores-view",
        brokerAvailable: false,
        stores: [],
      });
    }
    const answer = await broker.status();
    if (answer.status !== "ok") return secretStoresRefusal("broker-unavailable");
    return decodeSecretStoresResult({
      kind: "secret-stores-view",
      brokerAvailable: true,
      stores: answer.stores,
    });
  };

  const provider = (instanceId: ProviderInstanceId): ProviderInstance | undefined =>
    options.readProviderInstances().find((instance) => String(instance.id) === String(instanceId));

  const reprobe = (windowId: WindowId, instance: ProviderInstance): void => {
    void options.reprobe?.(windowId, instance).catch(() => undefined);
  };

  return {
    view: viewFromBroker,

    linkStore: (windowId, store) =>
      serialized(async () => {
        if (broker === undefined) return secretStoresRefusal("broker-unavailable");
        const linked = await broker.link(store);
        if (linked.status === "broker-unavailable")
          return secretStoresRefusal("broker-unavailable");
        if (linked.status === "locked") return secretStoresRefusal("store-locked");
        if (linked.status === "not-installed") return secretStoresRefusal("tool-not-installed");
        if (linked.status === "unavailable") return secretStoresRefusal("store-unavailable");
        if (!journaled({ name: "secret-store.linked", store, windowId })) {
          await broker.unlink(store);
          return secretStoresRefusal("journal-unavailable");
        }
        return viewFromBroker();
      }),

    unlinkStore: (windowId, store) =>
      serialized(async () => {
        if (broker === undefined) return secretStoresRefusal("broker-unavailable");
        const unlinked = await broker.unlink(store);
        if (unlinked.status === "broker-unavailable") {
          return secretStoresRefusal("broker-unavailable");
        }
        if (!journaled({ name: "secret-store.unlinked", store, windowId })) {
          return secretStoresRefusal(
            "journal-unavailable",
            "The store was unlinked, but the change could not be recorded.",
          );
        }
        return viewFromBroker();
      }),

    checkReference: async (store, reference) => {
      if (broker === undefined) return secretStoresRefusal("broker-unavailable");
      const checked = await broker.check(store, reference);
      if (checked.status === "broker-unavailable") return secretStoresRefusal("broker-unavailable");
      return { kind: "secret-stores-checked", store, outcome: checked.status };
    },

    pointProviderKey: (windowId, input) =>
      serialized(async () => {
        if (broker === undefined) return secretStoresRefusal("broker-unavailable");
        const instance = provider(input.instanceId);
        if (instance === undefined) return secretStoresRefusal("unknown-provider");
        if (!usesStoredKey(instance)) return secretStoresRefusal("no-stored-key-authentication");
        const id = String(instance.id);
        const before = await broker.reference({ namespace: "provider", id });
        if (before.status === "broker-unavailable")
          return secretStoresRefusal("broker-unavailable");

        const pointed = await broker.point({
          namespace: "provider",
          id,
          store: input.store,
          reference: input.reference,
        });
        if (pointed.status === "broker-unavailable")
          return secretStoresRefusal("broker-unavailable");
        if (pointed.status === "key-already-stored")
          return secretStoresRefusal("key-already-stored");
        if (pointed.status !== "pointed") return secretStoresRefusal(CHECK_REFUSAL[pointed.status]);

        // Checking the item can take a while. If the provider was removed or
        // reconfigured meanwhile, the service has already cleared its key; a
        // pointer written now would bring the credential back for the old
        // endpoint, so it is deleted and the change refused.
        const current = provider(input.instanceId);
        if (current === undefined || current.version !== instance.version) {
          await broker.clear({ namespace: "provider", id });
          return secretStoresRefusal("provider-changed");
        }

        const recorded = journaled({
          name: "credential-reference.set",
          target: { kind: "provider-key", instanceId: instance.id },
          store: input.store,
          reference: input.reference,
          replaced: before.status === "linked",
          windowId,
        });
        if (!recorded) {
          // Put back what was there: the earlier pointer, or nothing. The
          // earlier pointer goes back without reading its item (it may be gone
          // or its store locked by now). If it cannot be put back, the new,
          // unjournaled pointer is removed rather than left active.
          const restored =
            before.status === "linked"
              ? await broker.restore({ namespace: "provider", id, ...before })
              : await broker.clear({ namespace: "provider", id });
          if (restored.status === "pointed" || restored.status === "cleared") {
            return secretStoresRefusal("journal-unavailable");
          }
          const removed = await broker.clear({ namespace: "provider", id });
          return secretStoresRefusal(
            "journal-unavailable",
            removed.status === "broker-unavailable"
              ? "The change could not be recorded or undone. Remove this provider's secret store reference, then set it again."
              : "The change could not be recorded and the earlier item could not be restored, so this provider's secret store reference was removed.",
          );
        }
        reprobe(windowId, instance);
        return {
          kind: "secret-stores-provider-reference",
          instanceId: instance.id,
          reference: { store: input.store, reference: input.reference },
        };
      }),

    clearProviderKeyReference: (windowId, instanceId) =>
      serialized(async () => {
        if (broker === undefined) return secretStoresRefusal("broker-unavailable");
        const instance = provider(instanceId);
        if (instance === undefined) return secretStoresRefusal("unknown-provider");
        const cleared = await broker.clear({ namespace: "provider", id: String(instance.id) });
        if (cleared.status === "broker-unavailable")
          return secretStoresRefusal("broker-unavailable");
        if (cleared.status === "cleared") {
          if (
            !journaled({
              name: "credential-reference.cleared",
              target: { kind: "provider-key", instanceId: instance.id },
              store: cleared.store,
              reference: cleared.reference,
              windowId,
            })
          ) {
            return secretStoresRefusal(
              "journal-unavailable",
              "The reference was removed, but the change could not be recorded.",
            );
          }
          reprobe(windowId, instance);
        }
        return {
          kind: "secret-stores-provider-reference",
          instanceId: instance.id,
          reference: null,
        };
      }),

    pointAwsCliKey: (windowId, pointer) =>
      serialized(async () => {
        if (broker === undefined) return secretStoresRefusal("broker-unavailable");
        const before = await broker.awsCliReference();
        if (before.status === "broker-unavailable")
          return secretStoresRefusal("broker-unavailable");
        const pointed = await broker.pointAwsCli(pointer);
        if (pointed.status === "broker-unavailable")
          return secretStoresRefusal("broker-unavailable");
        if (pointed.status !== "pointed") return secretStoresRefusal(CHECK_REFUSAL[pointed.status]);
        const recorded = journaled(
          awsCliRecords(
            pointer,
            { name: "credential-reference.set", replaced: before.status === "linked" },
            windowId,
          ),
        );
        if (!recorded) {
          // As for a provider key: put back the earlier pointer or nothing, and
          // never leave an unjournaled pointer active.
          const restored =
            before.status === "linked"
              ? await broker.restoreAwsCli(before.pointer)
              : await broker.clearAwsCli();
          if (restored.status === "pointed" || restored.status === "cleared") {
            return secretStoresRefusal("journal-unavailable");
          }
          const removed = await broker.clearAwsCli();
          return secretStoresRefusal(
            "journal-unavailable",
            removed.status === "broker-unavailable"
              ? "The change could not be recorded or undone. Remove the AWS command line's secret store reference, then set it again."
              : "The change could not be recorded and the earlier items could not be restored, so the AWS command line's secret store reference was removed.",
          );
        }
        return { kind: "secret-stores-aws-cli-key", reference: pointer };
      }),

    clearAwsCliKey: (windowId) =>
      serialized(async () => {
        if (broker === undefined) return secretStoresRefusal("broker-unavailable");
        const cleared = await broker.clearAwsCli();
        if (cleared.status === "broker-unavailable")
          return secretStoresRefusal("broker-unavailable");
        if (
          cleared.status === "cleared" &&
          !journaled(
            awsCliRecords(cleared.pointer, { name: "credential-reference.cleared" }, windowId),
          )
        ) {
          return secretStoresRefusal(
            "journal-unavailable",
            "The reference was removed, but the change could not be recorded.",
          );
        }
        return { kind: "secret-stores-aws-cli-key", reference: null };
      }),

    readAwsCliKey: async () => {
      if (broker === undefined) return secretStoresRefusal("broker-unavailable");
      const answer = await broker.awsCliReference();
      if (answer.status === "broker-unavailable") return secretStoresRefusal("broker-unavailable");
      return {
        kind: "secret-stores-aws-cli-key",
        reference: answer.status === "linked" ? answer.pointer : null,
      };
    },

    readProviderKeyReference: async (instanceId) => {
      if (broker === undefined) return secretStoresRefusal("broker-unavailable");
      const instance = provider(instanceId);
      if (instance === undefined) return secretStoresRefusal("unknown-provider");
      const answer = await broker.reference({ namespace: "provider", id: String(instance.id) });
      if (answer.status === "broker-unavailable") return secretStoresRefusal("broker-unavailable");
      return {
        kind: "secret-stores-provider-reference",
        instanceId: instance.id,
        reference:
          answer.status === "linked" ? { store: answer.store, reference: answer.reference } : null,
      };
    },
  };
}
