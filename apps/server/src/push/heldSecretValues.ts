// Collects the secret values this host holds in memory and in its own local
// credential store so every free-text field in a push notification can be
// checked against them before leaving the host.
//
// Rules:
// - Never reads a linked 1Password item (checks reference kind first and skips
//   `linked` items; skips remembered thread secrets whose source is `onepassword`).
// - Never logs, journals, or writes secret values anywhere.
// - A missing entry is skipped; any other read failure (locked keyring, broker
//   down, unreadable store) returns `{ status: "unavailable" }` so the push
//   builder fails closed and emits only the generic placeholder.

import type { HeldSecretSnapshot } from "@octant/domain/push-notification-policy";
import { isHoldableSecretValue } from "@octant/domain/secret-guard-policy";
import { readInMemoryHostSecrets, secretForms } from "../process/secretRedaction";
import type { ProviderCredentialResolver } from "../providers/credentialBrokerClient";

export type SecretReferenceStatus = "none" | "linked" | "unavailable";

export interface StoredSecretNamespace {
  readonly listIds: () => ReadonlyArray<string>;
  readonly store: Pick<ProviderCredentialResolver, "has" | "resolve">;
  /**
   * When present, asked before `has`/`resolve`. `"linked"` entries (such as
   * 1Password pointers) are skipped without reading; `"unavailable"` fails
   * closed so the generic placeholder is sent instead.
   */
  readonly referenceStatus?: (id: string) => Promise<SecretReferenceStatus>;
}

export interface RememberedPastedSecretsPort {
  readonly listPasted: () => ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly resolvePasted: (
    id: string,
    name: string,
  ) => Promise<
    | { readonly status: "found"; readonly value: string }
    | { readonly status: "missing" }
    | { readonly status: "unavailable" }
  >;
}

export interface HeldSecretValuesOptions {
  readonly namespaces?: ReadonlyArray<StoredSecretNamespace>;
  readonly rememberedThreadSecrets?: RememberedPastedSecretsPort;
  readonly readInMemory?: () => ReadonlyArray<string>;
}

export interface HeldSecretValuesReader {
  /**
   * Returns every known host secret value (raw and encoded forms) in memory,
   * or `{ status: "unavailable" }` if any local credential store could not be
   * read.
   */
  readonly read: () => Promise<HeldSecretSnapshot>;
  /** Drops the cached stored-secret snapshot so the next send reloads it. */
  readonly invalidate: () => void;
}

function isMissingCredentialError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "category" in error &&
    (error as { readonly category?: unknown }).category === "unauthenticated"
  );
}

function addForms(target: Set<string>, value: string): void {
  if (!isHoldableSecretValue(value)) return;
  for (const form of secretForms(value)) {
    target.add(form);
  }
}

/**
 * Extracts secret strings from JSON-wrapped credentials (for example Apple
 * `.p8` JSON `{ privateKey }` or Google service account JSON `{ privateKey }`)
 * as well as the raw string itself.
 */
function addCredentialForms(target: Set<string>, raw: string): void {
  addForms(target, raw);
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
    for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof entry !== "string") continue;
      if (
        key === "privateKey" ||
        key === "private_key" ||
        key === "secretAccessKey" ||
        key === "accessKeyId" ||
        key === "token" ||
        key === "secret" ||
        key === "apiKey" ||
        key === "password" ||
        key === "credential"
      ) {
        addForms(target, entry);
      }
    }
  } catch {
    // Not JSON: raw string forms are already added above.
  }
}

export function createHeldSecretValuesReader(
  options: HeldSecretValuesOptions = {},
): HeldSecretValuesReader {
  const namespaces = options.namespaces ?? [];
  const readInMemory = options.readInMemory ?? readInMemoryHostSecrets;
  // Cached once a full load of stored secrets succeeds; an unavailable store
  // is never cached so unlocking the keyring recovers on the next push.
  let cachedStored: ReadonlyArray<string> | undefined;

  const loadStored = async (): Promise<
    | { readonly status: "ready"; readonly values: ReadonlyArray<string> }
    | { readonly status: "unavailable" }
  > => {
    if (cachedStored !== undefined) return { status: "ready", values: cachedStored };
    const collected = new Set<string>();

    if (options.rememberedThreadSecrets !== undefined) {
      for (const entry of options.rememberedThreadSecrets.listPasted()) {
        try {
          const resolved = await options.rememberedThreadSecrets.resolvePasted(
            entry.id,
            entry.name,
          );
          if (resolved.status === "unavailable") return { status: "unavailable" };
          if (resolved.status === "found") addCredentialForms(collected, resolved.value);
        } catch {
          return { status: "unavailable" };
        }
      }
    }

    for (const namespace of namespaces) {
      let ids: ReadonlyArray<string>;
      try {
        ids = namespace.listIds();
      } catch {
        return { status: "unavailable" };
      }
      for (const id of ids) {
        if (namespace.referenceStatus !== undefined) {
          let reference: SecretReferenceStatus;
          try {
            reference = await namespace.referenceStatus(id);
          } catch {
            return { status: "unavailable" };
          }
          if (reference === "unavailable") return { status: "unavailable" };
          // Never read linked items (such as 1Password references).
          if (reference === "linked") continue;
        }
        let present: boolean;
        try {
          present = await namespace.store.has(id);
        } catch (error) {
          if (isMissingCredentialError(error)) continue;
          return { status: "unavailable" };
        }
        if (!present) continue;
        try {
          const value = await namespace.store.resolve(id);
          addCredentialForms(collected, value);
        } catch (error) {
          if (isMissingCredentialError(error)) continue;
          return { status: "unavailable" };
        }
      }
    }

    cachedStored = [...collected];
    return { status: "ready", values: cachedStored };
  };

  return {
    async read() {
      const stored = await loadStored();
      if (stored.status === "unavailable") return { status: "unavailable" };
      const combined = new Set<string>(stored.values);
      for (const value of readInMemory()) {
        if (isHoldableSecretValue(value)) combined.add(value);
      }
      return { status: "ready", values: [...combined] };
    },
    invalidate() {
      cachedStored = undefined;
    },
  };
}
