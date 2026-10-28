import {
  decodeCodeProjectDesktopRecipeChanged,
  type DesktopCredentialRef,
  type DesktopLease,
  type DesktopRecipe,
  type DesktopRecipeKeyState,
  type ProjectId,
} from "@octant/contracts";
import type { Journal } from "../persistence/journal";
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
  /**
   * Every credential reference a journaled recipe change ever named: the keys
   * Octant itself stored, replaced and removed ones included.
   */
  readonly namedEver: () => ReadonlyArray<DesktopRecipeKeyNaming>;
}

/** A key reference a journaled recipe change named, and the Project whose recipe named it. */
export interface DesktopRecipeKeyNaming {
  readonly credentialRef: DesktopCredentialRef;
  readonly projectId: ProjectId;
}

export interface DesktopRecipeKeyView {
  readonly key: DesktopRecipeKeyState;
  readonly store: "available" | "unavailable";
  /**
   * A key this Project's recipe stopped naming is still in the store, because
   * a desktop made with it may need it for teardown.
   */
  readonly releasing?: true;
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
  readonly retire: (credentialRef: DesktopCredentialRef, projectId: ProjectId) => Promise<void>;
  /** Deletes the retired keys teardown no longer needs. */
  readonly settle: () => Promise<void>;
  /** What the recipe editor says about a recipe's key. Never the key. */
  readonly view: (
    projectId: ProjectId,
    recipe: DesktopRecipe | undefined,
  ) => Promise<DesktopRecipeKeyView>;
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
  const owners = new Map<string, ProjectId>();
  // A key retired before a restart may still be in the store when its
  // deletion failed or had not run yet. The first settle after a start takes
  // in every key a lease recorded or a journaled recipe ever named that no
  // recipe names now; a key no lease recorded would otherwise stay forever.
  let adopted = false;
  let settling: Promise<void> | undefined;

  const retireLater = (credentialRef: DesktopCredentialRef, projectId?: ProjectId): void => {
    retired.add(String(credentialRef));
    refs.set(String(credentialRef), credentialRef);
    if (projectId !== undefined) owners.set(String(credentialRef), projectId);
  };

  const settleOnce = async (): Promise<void> => {
    const store = options.store;
    if (store === undefined) return;
    // A sweep follows every journal commit; with nothing retired there is
    // nothing to read.
    if (adopted && retired.size === 0) return;
    const named = new Set(options.namedByRecipes().map(String));
    if (!adopted) {
      const known: ReadonlyArray<{
        readonly credentialRef: DesktopCredentialRef;
        readonly projectId?: ProjectId;
      }> = [
        ...options
          .leases()
          .flatMap((lease) =>
            lease.credentialRef === undefined ? [] : [{ credentialRef: lease.credentialRef }],
          ),
        ...options.namedEver(),
      ];
      adopted = true;
      for (const { credentialRef, projectId } of known) {
        if (!named.has(String(credentialRef))) retireLater(credentialRef, projectId);
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
        owners.delete(key);
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
    retire: async (credentialRef, projectId) => {
      retireLater(credentialRef, projectId);
      await settle();
    },
    settle,
    view: async (projectId, recipe) => {
      const store = options.store;
      const storeState = store === undefined ? "unavailable" : "available";
      // A retired key waits only while a desktop made with it may still need it.
      const waiting = [...retired].some((key) => {
        const credentialRef = refs.get(key);
        return (
          credentialRef !== undefined &&
          String(owners.get(key) ?? "") === String(projectId) &&
          options.holdsCredential(credentialRef)
        );
      });
      const releasing = waiting ? ({ releasing: true } as const) : {};
      const credentialRef = recipe?.credentialRef;
      if (credentialRef === undefined) return { key: "none", store: storeState, ...releasing };
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
      if (answered?.credentialRejected === true)
        return { key: "rejected", store: storeState, ...releasing };
      if (store === undefined) return { key: "missing", store: "unavailable", ...releasing };
      try {
        return {
          key: (await store.has(String(credentialRef))) ? "saved" : "missing",
          store: "available",
          ...releasing,
        };
      } catch {
        return { key: "missing", store: "unavailable", ...releasing };
      }
    },
  };
}

const RECIPE_HISTORY_BATCH = 1_000;

/**
 * Every credential reference a journaled desktop recipe change named. Only
 * the host mints a recipe's reference, so these are the keys Octant stored.
 */
export function credentialRefsRecipesNamed(
  journal: Pick<Journal, "replayAggregateType">,
): ReadonlyArray<DesktopRecipeKeyNaming> {
  const named = new Map<string, DesktopRecipeKeyNaming>();
  let afterSequence = 0;
  for (;;) {
    const batch = journal.replayAggregateType({
      aggregateType: "project",
      eventName: "project.code-desktop-recipe-changed@1",
      afterSequence,
      limit: RECIPE_HISTORY_BATCH,
    });
    for (const envelope of batch) {
      afterSequence = envelope.globalSequence;
      const { project } = decodeCodeProjectDesktopRecipeChanged(envelope.payload);
      const credentialRef = project.desktopRecipe?.credentialRef;
      if (credentialRef !== undefined) {
        named.set(String(credentialRef), { credentialRef, projectId: project.id });
      }
    }
    if (batch.length < RECIPE_HISTORY_BATCH) return [...named.values()];
  }
}
