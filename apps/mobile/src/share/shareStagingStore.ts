import {
  validateStagedShare,
  type ShareStagingFs,
  type ValidatedStagedShare,
} from "./shareValidation";

export interface LoadedStagedShares {
  readonly shares: ReadonlyArray<ValidatedStagedShare>;
  readonly notices: ReadonlyArray<string>;
}

/**
 * Reads the share staging directory, deletes expired (> 1 day) and structurally
 * invalid/tampered entries, and returns valid shares newest-first.
 */
export async function loadAndSweepStagedShares(
  fs: ShareStagingFs,
  nowMs: number = Date.now(),
): Promise<LoadedStagedShares> {
  if (!fs.available) return { shares: [], notices: [] };
  let entries;
  try {
    entries = await fs.listShareFolders();
  } catch {
    return { shares: [], notices: [] };
  }
  const shares: ValidatedStagedShare[] = [];
  const notices: string[] = [];
  for (const entry of entries) {
    const validated = await validateStagedShare({ entry, fs, nowMs });
    if (validated.status === "ok") {
      shares.push(validated.share);
    } else if (validated.status === "invalid") {
      notices.push(validated.reason);
    }
  }
  shares.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return { shares, notices };
}

export async function discardStagedShare(fs: ShareStagingFs, shareId: string): Promise<void> {
  if (!fs.available) return;
  await fs.deleteShareFolder(shareId);
}

/** Removes every staged share, called when the last paired computer leaves the phone. */
export async function clearAllStagedShares(fs: ShareStagingFs): Promise<void> {
  if (!fs.available) return;
  await fs.deleteAllShares();
}
