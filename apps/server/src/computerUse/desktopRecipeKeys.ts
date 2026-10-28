import type {
  DesktopCredentialRef,
  DesktopLease,
  DesktopRecipe,
  DesktopRecipeKeyState,
} from "@octant/contracts";
import type { ProviderCredentialStore } from "../providers/credentialBrokerClient";

export interface DesktopRecipeKeysOptions {
  /**
   * The credential broker's desktop-provider namespace. Absent on a host
   * without a broker, where no key can be saved.
   */
  readonly store: Pick<ProviderCredentialStore, "has" | "set" | "delete"> | undefined;
  /** Every lease this host has journaled. */
  readonly leases: () => ReadonlyArray<DesktopLease>;
  /** Whether teardown may still need the key a reference names. */
  readonly holdsCredential: (credentialRef: DesktopCredentialRef) => boolean;
  /** The credential references Projects' recipes name now, archived Projects included. */
  readonly namedByRecipes: () => ReadonlyArray<DesktopCredentialRef>;
}

export interface DesktopRecipeKeyView {
  readonly key: DesktopRecipeKeyState;
  readonly store: "available" | "unavailable";
}

export interface DesktopRecipeKeys {
  /** Stores a key a person entered under a reference no recipe has named yet. */
  readonly save: (
    credentialRef: DesktopCredentialRef,
    key: string,
  ) => Promise<{ readonly status: "saved" } | { readonly status: "unavailable" }>;
  /** Deletes a key whose recipe change did not stand, so nothing ever named it. */
  readonly discard: (credentialRef: DesktopCredentialRef) => Promise<void>;
  /**
   * A key no recipe names any more. It is deleted once no desktop made with it
   * may still be running, because teardown reaches the account with it.
   */
  readonly retire: (credentialRef: DesktopCredentialRef) => Promise<void>;
  /** Deletes the retired keys teardown no longer needs. */
  readonly settle: () => Promise<void>;
  /** What the recipe editor says about a recipe's key. Never the key. */
  readonly view: (recipe: DesktopRecipe | undefined) => Promise<DesktopRecipeKeyView>;
}

/**
 * The keys a person gives a cloud desktop recipe, kept only in the host
 * credential store's desktop-provider namespace. A recipe and the leases it
 * starts record the reference alone. A key is replaced by saving a new one
 * under a fresh reference, so a running desktop keeps the key it was made
 * with until it is verified gone, and the old key is deleted after that.
 */
export function createDesktopRecipeKeys(options: DesktopRecipeKeysOptions): DesktopRecipeKeys {
  const retired = new Set<string>();
  const refs = new Map<string, DesktopCredentialRef>();
  // A key retired before a restart is still in the store; the leases that
  // recorded it say so, and the first settle after a start takes them in.
  let adopted = false;
  let settling: Promise<void> | undefined;

  const retireLater = (credentialRef: DesktopCredentialRef): void => {
    retired.add(String(credentialRef));
    refs.set(String(credentialRef), credentialRef);
  };

  const settleOnce = async (): Promise<void> => {
    const store = options.store;
    if (store === undefined) return;
    const named = new Set(options.namedByRecipes().map(String));
    if (!adopted) {
      adopted = true;
      for (const lease of options.leases()) {
        if (lease.credentialRef !== undefined && !named.has(String(lease.credentialRef))) {
          retireLater(lease.credentialRef);
        }
      }
    }
    for (const key of retired) {
      const credentialRef = refs.get(key);
      if (credentialRef === undefined || named.has(key)) {
        retired.delete(key);
        continue;
      }
      if (options.holdsCredential(credentialRef)) continue;
      try {
        await store.delete(key);
        retired.delete(key);
        refs.delete(key);
      } catch {
        // The store could not be reached; the next settle tries again.
      }
    }
  };

  // One settle runs at a time; a key retired while one runs gets one more pass
  // rather than waiting for the next sweep.
  let again = false;
  const settle = (): Promise<void> => {
    if (settling !== undefined) {
      again = true;
      return settling;
    }
    const run = async (): Promise<void> => {
      try {
        do {
          again = false;
          await settleOnce();
        } while (again);
      } finally {
        settling = undefined;
      }
    };
    settling = run();
    return settling;
  };

  return {
    save: async (credentialRef, key) => {
      const store = options.store;
      if (store === undefined) return { status: "unavailable" };
      try {
        await store.set(String(credentialRef), key);
        return { status: "saved" };
      } catch {
        // A failed write may still have landed; nothing names it, so clear it.
        await store.delete(String(credentialRef)).catch(() => undefined);
        return { status: "unavailable" };
      }
    },
    discard: async (credentialRef) => {
      await options.store?.delete(String(credentialRef)).catch(() => undefined);
    },
    retire: async (credentialRef) => {
      retireLater(credentialRef);
      await settle();
    },
    settle,
    view: async (recipe) => {
      const store = options.store;
      const storeState = store === undefined ? "unavailable" : "available";
      const credentialRef = recipe?.credentialRef;
      if (credentialRef === undefined) return { key: "none", store: storeState };
      // The most recent lease that got an answer from the provider with this
      // key says whether the provider took it. A new key has a new reference,
      // so entering one clears a refusal.
      const answered = options
        .leases()
        .filter(
          (lease) =>
            String(lease.credentialRef ?? "") === String(credentialRef) &&
            lease.state !== "requested" &&
            lease.state !== "provisioning",
        )
        .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt))[0];
      if (answered?.credentialRejected === true) return { key: "rejected", store: storeState };
      if (store === undefined) return { key: "missing", store: "unavailable" };
      try {
        return {
          key: (await store.has(String(credentialRef))) ? "saved" : "missing",
          store: "available",
        };
      } catch {
        return { key: "missing", store: "unavailable" };
      }
    },
  };
}
