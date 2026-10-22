import { MobileInboxFailure } from "@octant/client-runtime";
import type { SelectedThreadGuard } from "./selectedThreadGuard";
import type { MutationGate, ThreadUi } from "./threadTypes";

export function failureMessage(cause: unknown, fallback: string): string {
  return cause instanceof MobileInboxFailure ? cause.message : fallback;
}

export type MutationOutcome = "refused" | "stale" | "done" | "failed";

/**
 * One path for every phone mutation: honour the stale-host gate, show busy,
 * run the network step for this thread, and commit only if the thread is still
 * on screen. `run` does network work only; `onDone` paints.
 */
export async function runMutation<T>(input: {
  readonly guard: SelectedThreadGuard;
  readonly identity: string;
  readonly gate: MutationGate;
  readonly ui: ThreadUi;
  readonly failure: string;
  readonly run: () => Promise<T>;
  readonly onDone: (value: T) => void;
  readonly onFailed?: (message: string) => void;
}): Promise<MutationOutcome> {
  if (!input.gate.allowProductMutations) {
    input.ui.setError(input.gate.message);
    return "refused";
  }
  input.ui.setBusy(true);
  input.ui.setError(undefined);
  const result = await input.guard.guarded(input.identity, input.run);
  // A stale result must not touch busy either: the newly selected thread owns it.
  if (result.status === "stale") return "stale";
  input.ui.setBusy(false);
  if (result.status === "failed") {
    const message = failureMessage(result.cause, input.failure);
    input.ui.setError(message);
    input.onFailed?.(message);
    return "failed";
  }
  input.onDone(result.value);
  return "done";
}

/**
 * Send, then reload what the host now holds. Once the send resolves the host
 * has accepted the turn, so `onSent` runs before the reload and a failed reload
 * yields `undefined` instead of failing the send: retrying would submit the
 * same turn twice. The event stream catches the view up.
 */
export async function sendThenReload<T>(input: {
  readonly send: () => Promise<unknown>;
  readonly onSent: () => void;
  readonly reload: () => Promise<T>;
}): Promise<T | undefined> {
  await input.send();
  input.onSent();
  try {
    return await input.reload();
  } catch {
    return undefined;
  }
}

/** Read-side twin of `runMutation`: a quiet reload never shows busy or errors. */
export async function runLoad<T>(input: {
  readonly guard: SelectedThreadGuard;
  readonly identity: string;
  readonly quiet: boolean;
  readonly ui: ThreadUi;
  readonly failure: string;
  readonly load: () => Promise<T>;
  readonly onLoaded: (value: T) => void;
  readonly onFailed: () => void;
}): Promise<void> {
  if (!input.quiet) {
    input.ui.setBusy(true);
    input.ui.setError(undefined);
  }
  const result = await input.guard.guarded(input.identity, input.load);
  if (result.status === "stale") return;
  if (!input.quiet) input.ui.setBusy(false);
  if (result.status === "done") {
    input.onLoaded(result.value);
    return;
  }
  if (input.quiet) return;
  input.onFailed();
  input.ui.setError(failureMessage(result.cause, input.failure));
}
