import type { PermissionMode } from "@octant/contracts/providers";
import { useState, type ReactNode } from "react";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";

export const FULL_ACCESS_WARNING =
  "Agents can change any file and run any command without asking, with no sandbox. Only protected files, such as SSH and cloud keys, stay out of their reach.";

/**
 * Where the warning was seen: this machine (its Settings default and first
 * run) or one Project (its default and its threads). Kept in the window's
 * storage because only a window on this host can pick Full access; a paired
 * device is refused it at the route.
 */
export type FullAccessWarningScope = "machine" | { readonly projectId: string };

function storageKey(scope: FullAccessWarningScope): string {
  return scope === "machine"
    ? "octant.full-access-warned.machine"
    : `octant.full-access-warned.project.${scope.projectId}`;
}

function defaultStorage(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

function warned(scope: FullAccessWarningScope, storage: Storage | undefined): boolean {
  try {
    return storage?.getItem(storageKey(scope)) === "1";
  } catch {
    return false;
  }
}

function markWarned(scope: FullAccessWarningScope, storage: Storage | undefined): void {
  try {
    storage?.setItem(storageKey(scope), "1");
  } catch {
    // Storage blocked: the warning shows again next time, which is the safe side.
  }
}

/**
 * The one-time warning before the first Full access pick in a scope. `guard`
 * runs a pick straight away unless it is Full access in a scope that has not
 * seen the warning; then the pick waits for the person to confirm it.
 */
export function useFullAccessWarning(
  scope: FullAccessWarningScope,
  storage: Storage | undefined = defaultStorage(),
): {
  readonly guard: (mode: PermissionMode | undefined, apply: () => void) => void;
  readonly dialog: ReactNode;
} {
  const [pending, setPending] = useState<(() => void) | undefined>(undefined);
  return {
    guard: (mode, apply) => {
      if (mode !== "full-access" || warned(scope, storage)) {
        apply();
        return;
      }
      setPending(() => apply);
    },
    dialog:
      pending === undefined ? null : (
        <OctantConfirmDialog
          confirmLabel="Use Full access"
          destructive
          onCancel={() => setPending(undefined)}
          onConfirm={() => {
            markWarned(scope, storage);
            setPending(undefined);
            pending();
          }}
          title="Use Full access?"
        >
          {FULL_ACCESS_WARNING}
        </OctantConfirmDialog>
      ),
  };
}
