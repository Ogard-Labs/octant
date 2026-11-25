import {
  createArchivedWorktreesClient,
  type ArchivedWorktreesClient,
} from "@octant/client-runtime/archived-worktrees-client";
import {
  createDiskCleanupClient,
  type DiskCleanupClient,
} from "@octant/client-runtime/disk-cleanup-client";
import {
  createProtectedFilesClient,
  type ProtectedFilesClient,
} from "@octant/client-runtime/protected-files-client";
import {
  createSafeNetworksClient,
  type SafeNetworksClient,
} from "@octant/client-runtime/safe-networks-client";
import {
  createShieldServersClient,
  type ShieldServersClient,
} from "@octant/client-runtime/shield-servers-client";
import {
  createSpendCeilingClient,
  type SpendCeilingClient,
} from "@octant/client-runtime/spend-ceiling-client";
import type { RemoteProductPort } from "./remoteProductClients";

/** What Settings › Permissions reads and changes on the host, over the session. */
export interface RemotePermissionClients {
  readonly protectedFiles: ProtectedFilesClient;
  readonly safeNetworks: SafeNetworksClient;
  readonly shieldServers: ShieldServersClient;
  readonly archivedWorktrees: ArchivedWorktreesClient;
  readonly diskCleanup: DiskCleanupClient;
  readonly spendCeiling: SpendCeilingClient;
}

/**
 * The host's permission lists, worktree and build-data cleanup and spend
 * ceilings over the session. The host takes their changes only from a device
 * its own person paired, so the section that builds these is mounted for no
 * other session. Built there, not with the shell, so a first load carries none.
 */
export function createRemotePermissionClients(port: RemoteProductPort): RemotePermissionClients {
  return {
    protectedFiles: createProtectedFilesClient(port),
    safeNetworks: createSafeNetworksClient(port),
    shieldServers: createShieldServersClient(port),
    archivedWorktrees: createArchivedWorktreesClient(port),
    diskCleanup: createDiskCleanupClient(port),
    spendCeiling: createSpendCeilingClient(port),
  };
}
