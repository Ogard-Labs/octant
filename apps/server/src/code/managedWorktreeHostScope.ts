import {
  decodeKeychainServiceFamily,
  KEYCHAIN_SERVICE_FAMILY_ENVIRONMENT,
  managedWorktreesFolderName,
} from "@octant/host-runtime";

/**
 * What keeps this host's managed worktrees apart from another host's on the
 * same account: the folder they sit in beside each repository, and the label
 * their checkout ids derive under. Nightly's own host is the one the desktop
 * starts with Nightly's Keychain family, so the family decides both.
 *
 * A Code thread imported from Octant keeps its id, and a worktree's folder and
 * checkout id both derive from the thread. Under one name the worktree Nightly
 * makes for it would be Octant's folder, and its checkpoint refs, which live
 * in the repository's shared ref store under the checkout id, would be
 * Octant's too, so Octant's cleanup would drop Nightly's restore points.
 */
export interface ManagedWorktreeHostScope {
  readonly folderName: string;
  readonly checkoutLabel: string;
  /**
   * Every name pair this host's own worktrees may carry, its current one
   * first. Nightly's own host made worktrees under Octant's names until it had
   * its own, so a receipt it wrote then keeps resolving, cleaning up and
   * reclaiming by the folder and checkout id it records; new ones take the
   * current names. A receipt imported from Octant carries those same names,
   * so every removal path refuses an imported receipt before it asks this.
   */
  /**
   * Whether this host continues Code threads imported from Octant on
   * worktrees of its own: only Nightly's own host imports from Octant.
   */
  readonly continuesImportedThreads: boolean;
  readonly recognized: ReadonlyArray<{
    readonly folderName: string;
    readonly checkoutLabel: string;
  }>;
}

const OCTANT_NAMES = {
  folderName: managedWorktreesFolderName("octant"),
  checkoutLabel: "octant.managed-worktree-checkout.v1",
} as const;

export function managedWorktreeHostScope(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ManagedWorktreeHostScope {
  const family = decodeKeychainServiceFamily(env[KEYCHAIN_SERVICE_FAMILY_ENVIRONMENT]);
  // Host startup refuses an unknown family, so one here is a broken invariant;
  // guessing Octant's names would put this host's worktrees in Octant's folder.
  if (family === undefined) throw new Error("The host's Keychain family is not recognized.");
  if (family === "octant") {
    return { ...OCTANT_NAMES, continuesImportedThreads: false, recognized: [OCTANT_NAMES] };
  }
  const own = {
    folderName: managedWorktreesFolderName(family),
    checkoutLabel: "octant-nightly.managed-worktree-checkout.v1",
  };
  return { ...own, continuesImportedThreads: true, recognized: [own, OCTANT_NAMES] };
}
