import type {
  ContextCompactionExecutor,
  ContextCompactionFailureReason,
  ContextCompactionRecord,
  ContextCompactionRefusalReason,
} from "@octant/contracts/context";
import type { ContextCompactionState } from "@octant/contracts/context-rpc";
import type { ProviderInstanceId, ProviderModelId } from "@octant/contracts/providers";
import { driverLabel, isModelEndpointDriverKind } from "../providers/providerSettingsPresentation";
import { compactTokenCount } from "./contextInspectorModel";

/**
 * The names the window knows for a provider instance and its models. Absent
 * names fall back to plain words; an id is never shown in their place.
 */
export interface CompactionNames {
  readonly provider: (providerInstanceId: ProviderInstanceId) => string | undefined;
  readonly model: (
    providerInstanceId: ProviderInstanceId,
    modelId: ProviderModelId,
  ) => string | undefined;
}

export type CompactionOffer =
  | { readonly kind: "hidden" }
  | { readonly kind: "available"; readonly executor: ContextCompactionExecutor }
  | { readonly kind: "disabled"; readonly reason: string };

/**
 * Refusals nothing at this window can change. The runtime cannot compact, or
 * the host refuses this client outright (a paired device), so the button is
 * left out instead of shown as something to wait for.
 */
const PERMANENT_REFUSALS: ReadonlySet<ContextCompactionRefusalReason> = new Set([
  "runtime-cannot-compact",
  "runtime-version-unsupported",
  "remote-client",
]);

/**
 * Whether the Compact session button shows, and whether it can be pressed.
 * Only the host's answer decides it; a window with no answer offers nothing.
 */
export function compactionOffer(state: ContextCompactionState | undefined): CompactionOffer {
  if (state === undefined) return { kind: "hidden" };
  const { compaction } = state;
  if (compaction.status === "available") {
    return state.executor === undefined
      ? { kind: "hidden" }
      : { kind: "available", executor: state.executor };
  }
  if (PERMANENT_REFUSALS.has(compaction.reason)) return { kind: "hidden" };
  return { kind: "disabled", reason: sentence(refusalClause(compaction.reason)) };
}

export function refusalClause(reason: ContextCompactionRefusalReason): string {
  switch (reason) {
    case "nothing-to-compact":
      return "there is nothing earlier to summarize yet";
    case "no-session":
      return "this thread has no session to compact yet";
    case "runtime-version-unsupported":
      return "this version of the runtime can't compact";
    case "runtime-cannot-compact":
      return "this runtime can't compact";
    case "turn-running":
      return "a reply is running";
    case "compaction-running":
      return "this session is already being compacted";
    case "provider-unavailable":
      return "the provider is unavailable";
    case "spend-ceiling-reached":
      return "a spend limit has been reached";
    case "mode-disabled":
      return "this mode is turned off";
    case "remote-client":
      return "a session is compacted from a window on the host";
  }
}

function failureClause(reason: ContextCompactionFailureReason, executor: string): string {
  switch (reason) {
    case "runtime-failed":
      return `${executor} reported a failure`;
    case "summary-failed":
      return "the summary request failed";
    case "summary-not-smaller":
      return "the summary was not smaller than what it replaces";
    case "context-changed":
      return "the context changed while the summary was written";
    case "timed-out":
      return "it took too long";
    case "subject-unavailable":
      return "the thread or its session was unavailable";
    case "interrupted":
      return "Octant restarted while it ran";
  }
}

/** Who writes the summary, in the words the result line and the confirm use. */
export function executorName(executor: ContextCompactionExecutor, names: CompactionNames): string {
  if (executor.kind === "host") {
    return names.provider(executor.providerInstanceId) ?? "the thread's provider";
  }
  // Octant Harness keeps a Code session on a model endpoint, and it is the one
  // that summarizes, not the endpoint.
  return isModelEndpointDriverKind(executor.driverKind)
    ? "Octant Harness"
    : driverLabel(executor.driverKind);
}

/** Where the confirm says the conversation goes: provider, then model. */
export function executorDestination(
  executor: ContextCompactionExecutor,
  names: CompactionNames,
): string {
  const provider = names.provider(executor.providerInstanceId) ?? "the thread's provider";
  if (executor.modelId === undefined) return provider;
  const model =
    names.model(executor.providerInstanceId, executor.modelId) ?? String(executor.modelId);
  return `${provider} · ${model}`;
}

/** The line that says how the latest compaction went, or that one is running. */
export function compactionResultLine(
  record: ContextCompactionRecord,
  names: CompactionNames,
): string {
  if (record.status === "running") return "Compacting…";
  if (record.status === "failed") {
    const reason = failureClause(record.reason, executorName(record.executor, names));
    return record.sessionMayHaveChanged
      ? `Couldn't compact: ${reason}. The session may have changed; the next reply shows what it holds.`
      : `Couldn't compact: ${reason}.`;
  }
  const { receipt } = record;
  const by = `summary by ${executorName(receipt.executor, names)}`;
  const freed = receipt.tokensFreed;
  if (freed.kind === "unknown") {
    return freed.reason === "awaiting-next-report"
      ? `Compacted · freed amount shows after the next reply · ${by}`
      : `Compacted · freed amount not reported · ${by}`;
  }
  if (freed.tokens === 0) return `Compacted · nothing freed · ${by}`;
  return `Compacted · ${compactTokenCount(freed.tokens)} freed · ${by}`;
}

export function refusalLine(reason: ContextCompactionRefusalReason): string {
  return `Couldn't compact: ${refusalClause(reason)}.`;
}

function sentence(clause: string): string {
  return `${clause.charAt(0).toUpperCase()}${clause.slice(1)}.`;
}
