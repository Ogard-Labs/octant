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
}

export function managedWorktreeHostScope(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ManagedWorktreeHostScope {
  const family = decodeKeychainServiceFamily(env[KEYCHAIN_SERVICE_FAMILY_ENVIRONMENT]);
  // Host startup refuses an unknown family, so one here is a broken invariant;
  // guessing Octant's names would put this host's worktrees in Octant's folder.
  if (family === undefined) throw new Error("The host's Keychain family is not recognized.");
  return {
    folderName: managedWorktreesFolderName(family),
    checkoutLabel:
      family === "octant"
        ? "octant.managed-worktree-checkout.v1"
        : "octant-nightly.managed-worktree-checkout.v1",
  };
}
