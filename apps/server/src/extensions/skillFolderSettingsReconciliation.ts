import type { SkillFolderSettings } from "@octant/contracts";
import type { Journal } from "../persistence/journal";

/** Host-owned reconciliation, independent of whether Settings is mounted. */
export function observeSkillFolderSettings(options: {
  readonly journal: Pick<Journal, "subscribeCommitted">;
  readonly read: () => SkillFolderSettings;
  readonly reconcile: () => Promise<unknown>;
}): () => void {
  let key = JSON.stringify(options.read());
  let stopped = false;
  let dirty = false;
  let pending: Promise<void> | undefined;
  const drain = () => {
    dirty = true;
    if (pending !== undefined || stopped) return;
    pending = (async () => {
      while (dirty && !stopped) {
        dirty = false;
        try {
          await options.reconcile();
        } catch {
          /* A later explicit change or Refresh can retry; no busy error loop. */
        }
      }
    })().finally(() => {
      pending = undefined;
      if (dirty && !stopped) drain();
    });
  };
  const unsubscribe = options.journal.subscribeCommitted((append) => {
    if (stopped || !append.events.some((event) => event.eventName === "shell.settings-replaced"))
      return;
    const next = JSON.stringify(options.read());
    if (next === key) return;
    key = next;
    drain();
  });
  return () => {
    stopped = true;
    dirty = false;
    unsubscribe();
  };
}
