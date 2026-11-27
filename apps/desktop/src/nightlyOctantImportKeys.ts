import {
  CredentialStoreFailure,
  makeSecretServiceCredentialStore,
  type CredentialStore,
} from "@octant/host-runtime";
import type { NightlyOctantImportKeys } from "@octant/contracts/app-updates";
import { makeKeychainCredentialStore, type KeychainServiceFamily } from "./keychainCredentialStore";

/**
 * The Keychain namespaces whose items come over when a person ticks "Copy
 * keys" (docs/design/nightly-app.md#importing-from-octant). Everything else
 * belongs to Octant's host: its identity, replica device and store keys, push
 * registrations and public share-link secrets, so the two hosts never both
 * control one of them.
 */
export const COPIED_KEY_NAMESPACES = [
  "provider",
  "mcp-server-credential",
  "desktop-provider-credential",
  "web-search-credential",
  "ssh-key",
  "thread-secret-credential",
] as const;
export type CopiedKeyNamespace = (typeof COPIED_KEY_NAMESPACES)[number];

export interface CredentialReference {
  readonly namespace: string;
  readonly id: string;
}

export type KeyStoreFactory = (namespace: CopiedKeyNamespace) => CredentialStore;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REFERENCES = 4_096;

const isCopiedNamespace = (value: string): value is CopiedKeyNamespace =>
  (COPIED_KEY_NAMESPACES as ReadonlyArray<string>).includes(value);

/**
 * Copies saved keys from Octant's Keychain names to Nightly's own. Neither
 * store can list its items, so the caller names the references the imported
 * data holds; an item absent from Octant is skipped, and an item Nightly
 * already has is never replaced. A value is held only between the read and
 * the write and appears in no result or message.
 */
export async function copyOctantKeys(input: {
  /** `undefined` when the references cannot be listed. */
  readonly references: ReadonlyArray<CredentialReference> | undefined;
  readonly octantStores: KeyStoreFactory | undefined;
  readonly nightlyStores: KeyStoreFactory | undefined;
}): Promise<NightlyOctantImportKeys> {
  if (input.octantStores === undefined || input.nightlyStores === undefined)
    return { status: "unavailable", reason: "unsupported-platform" };
  if (input.references === undefined) return { status: "unavailable", reason: "cannot-list" };
  const seen = new Set<string>();
  let copied = 0;
  let existing = 0;
  let failed = 0;
  for (const reference of input.references.slice(0, MAX_REFERENCES)) {
    if (!isCopiedNamespace(reference.namespace) || !UUID_PATTERN.test(reference.id)) continue;
    const identity = `${reference.namespace}\u0000${reference.id.toLowerCase()}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    try {
      const target = input.nightlyStores(reference.namespace);
      if (await target.has(reference.id)) {
        existing += 1;
        continue;
      }
      let value: string;
      try {
        value = await input.octantStores(reference.namespace).resolve(reference.id);
      } catch (error) {
        // Octant never held this item: there is nothing to copy.
        if (error instanceof CredentialStoreFailure && error.category === "missing") continue;
        throw error;
      }
      await target.set(reference.id, value);
      copied += 1;
    } catch {
      failed += 1;
    }
  }
  return { status: "copied", copied, existing, failed };
}

/**
 * The credential stores of one host: macOS Keychain items are scoped by the
 * host's derived id, Linux Secret Service items by the family's own `service`
 * names. `undefined` where neither exists.
 */
export function desktopKeyStores(options: {
  readonly platform: NodeJS.Platform;
  readonly keychainHelperPath: string;
  readonly storeScope: string;
  readonly family: KeychainServiceFamily;
  /** Octant's items are only read: no re-scoping, no write, no delete. */
  readonly readOnly?: boolean;
}): KeyStoreFactory | undefined {
  if (options.platform === "darwin")
    return (namespace) =>
      makeKeychainCredentialStore(options.keychainHelperPath, {
        storeScope: options.storeScope,
        serviceFamily: options.family,
        namespace,
        ...(options.readOnly === true ? { readOnly: true } : {}),
      });
  if (options.platform === "linux")
    return (namespace) => makeSecretServiceCredentialStore({ namespace, family: options.family });
  return undefined;
}

/**
 * Reads the references from the maintenance command's JSON output
 * (`{"references":[{"namespace","id"}]}`); anything else, including a command
 * the packaged server does not have, is "cannot list".
 */
export function decodeCredentialReferences(
  exitCode: number | null,
  stdout: string,
): ReadonlyArray<CredentialReference> | undefined {
  if (exitCode !== 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || !("references" in parsed)) return undefined;
  const references = parsed.references;
  if (!Array.isArray(references)) return undefined;
  const decoded: CredentialReference[] = [];
  for (const entry of references as ReadonlyArray<unknown>) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("namespace" in entry) ||
      !("id" in entry) ||
      typeof entry.namespace !== "string" ||
      typeof entry.id !== "string"
    )
      return undefined;
    decoded.push({ namespace: entry.namespace, id: entry.id });
  }
  return decoded;
}
