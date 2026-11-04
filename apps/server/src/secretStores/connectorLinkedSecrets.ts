/**
 * Points an MCP server's secret value at an item in a linked secret store.
 *
 * A server the person adds by hand can name an item instead of holding a
 * value. The broker keeps the pointer under the secret id the package
 * references and follows it when the server is launched. Each pointer and each
 * removal is journaled; the value is not an input here.
 */

import { SECRET_STORE_REFUSAL_MESSAGES, SecretStoreKind } from "@octant/contracts/secret-stores";
import { Schema } from "effect";
import type { LinkedSecretPointers } from "../extensions/userAddedMcpServers";
import type { SecretStoreBrokerClient } from "./secretStoreBrokerClient";
import type { SecretStoresJournal } from "./secretStoresJournal";

const isSecretStoreKind = Schema.is(SecretStoreKind);

const REFUSAL = {
  locked: SECRET_STORE_REFUSAL_MESSAGES["store-locked"],
  missing: SECRET_STORE_REFUSAL_MESSAGES["item-missing"],
  unavailable: SECRET_STORE_REFUSAL_MESSAGES["store-unavailable"],
  "not-linked": SECRET_STORE_REFUSAL_MESSAGES["not-linked"],
  "invalid-reference": SECRET_STORE_REFUSAL_MESSAGES["invalid-reference"],
  "key-already-stored": SECRET_STORE_REFUSAL_MESSAGES["key-already-stored"],
  "broker-unavailable": SECRET_STORE_REFUSAL_MESSAGES["broker-unavailable"],
} as const;

export function makeConnectorLinkedSecrets(options: {
  readonly broker: Pick<SecretStoreBrokerClient, "point" | "clear">;
  readonly journal: Pick<SecretStoresJournal, "record">;
}): LinkedSecretPointers {
  const retire = async (secretId: string): Promise<"cleared" | "uncertain"> => {
    const cleared = await options.broker.clear({ namespace: "mcp-server", id: secretId });
    if (cleared.status === "none") return "cleared";
    if (cleared.status !== "cleared") return "uncertain";
    // The pointer is already gone; a journal that refuses here has nothing
    // left to undo, and the removal of the server carries on.
    try {
      options.journal.record({
        name: "credential-reference.cleared",
        target: { kind: "connector-secret", secretId },
        store: cleared.store,
        reference: cleared.reference,
      });
    } catch {
      // Best effort, like the other removal cleanup.
    }
    return "cleared";
  };
  return {
    point: async (secretId, linked) => {
      if (!isSecretStoreKind(linked.store)) {
        return { status: "refused", message: SECRET_STORE_REFUSAL_MESSAGES.malformed };
      }
      let pointed: Awaited<ReturnType<SecretStoreBrokerClient["point"]>>;
      try {
        pointed = await options.broker.point({
          namespace: "mcp-server",
          id: secretId,
          store: linked.store,
          reference: linked.reference,
        });
      } catch {
        return {
          status: "uncertain",
          message: SECRET_STORE_REFUSAL_MESSAGES["broker-unavailable"],
        };
      }
      if (pointed.status !== "pointed") {
        const knownRefusal =
          pointed.status === "locked" ||
          pointed.status === "missing" ||
          pointed.status === "not-linked" ||
          pointed.status === "invalid-reference";
        return { status: knownRefusal ? "refused" : "uncertain", message: REFUSAL[pointed.status] };
      }
      try {
        options.journal.record({
          name: "credential-reference.set",
          target: { kind: "connector-secret", secretId },
          store: linked.store,
          reference: linked.reference,
          replaced: false,
        });
      } catch {
        let cleared: Awaited<ReturnType<SecretStoreBrokerClient["clear"]>>;
        try {
          cleared = await options.broker.clear({ namespace: "mcp-server", id: secretId });
        } catch {
          return {
            status: "uncertain",
            message: SECRET_STORE_REFUSAL_MESSAGES["journal-unavailable"],
          };
        }
        return {
          status:
            cleared.status === "cleared" || cleared.status === "none" ? "refused" : "uncertain",
          message: SECRET_STORE_REFUSAL_MESSAGES["journal-unavailable"],
        };
      }
      return { status: "pointed" };
    },
    retire,
    forget: async (secretId) => {
      await retire(secretId);
    },
  };
}
