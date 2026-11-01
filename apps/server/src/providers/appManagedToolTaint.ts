import { createHash } from "node:crypto";
import type { ShieldWatcherLabel } from "@octant/contracts";
import {
  callReadsProtectedSecret,
  SHIELD_WATCHER_SOURCE_PREFIX,
  watchedTextOf,
  watchOutsideContent,
} from "@octant/domain/shield-watcher-policy";
import type {
  ExternalContentIngestionResult,
  RecordExternalContentIngestionInput,
} from "../context/externalContentIngestionStore";
import type { AppManagedToolSet } from "./appManagedToolSet";

export interface TaintAppManagedToolResultsInput {
  readonly tools: AppManagedToolSet;
  readonly threadId: unknown;
  readonly recordExternalContentIngestion: (
    input: RecordExternalContentIngestionInput,
  ) => ExternalContentIngestionResult;
  readonly uuid: () => string;
  /**
   * Whether this call's successful result brings in outside content. Absent
   * means every result does, which is right for tools that reach the browser,
   * another application, or an MCP server.
   */
  readonly resultTaintsThread?: (
    call: { readonly name: string; readonly inputJson: string },
    result: unknown,
  ) => boolean;
  /**
   * The secret guard's list: whether a path the agent named is one it
   * protects. Absent, no read is flagged for it.
   */
  readonly protectedSecretPath?: (path: string) => boolean;
}

/**
 * Journal thread-lifetime taint for successful native app-managed tool results
 * before they reach the next model turn, and run Octant Shield's Watcher over
 * each one.
 *
 * The Watcher only raises. A result it labels marks the thread even when the
 * tool's results do not otherwise count as outside content (a file inside the
 * root, a command's output), each label is journaled beside the tool's own
 * source, and the result goes through unchanged with the labels for its tool
 * row. It never withholds a result for what it found and never allows
 * anything.
 *
 * Host-side refusals stay unrecorded as outside content: they are Octant
 * answers, not untrusted content. One exception is flagged: a refused call
 * that named a protected secret path is journaled as the Watcher's
 * `secret-path-read`, because the attempt is what the person should see, and
 * the refusal goes back unchanged whether or not the flag could be kept.
 * Recording failure withholds the result rather than handing it to
 * the model without a taint event. Structured tool JSON is kept as-is; the
 * journal never stores the body.
 */
export function taintAppManagedToolResults(
  input: TaintAppManagedToolResultsInput,
): AppManagedToolSet {
  return {
    definitions: input.tools.definitions,
    ...(input.tools.close === undefined ? {} : { close: input.tools.close }),
    execute: async (call) => {
      const outcome = await input.tools.execute(call);
      if (outcome.isError === true) return flagRefusedSecretRead(input, call, outcome);
      const labels = watchToolResult(call, outcome.result, input.protectedSecretPath);
      const outside = input.resultTaintsThread?.(call, outcome.result) !== false;
      if (!outside && labels.length === 0) return outcome;
      return taintSuccessfulResult(input, call.name, outcome, { outside, labels });
    },
  };
}

function flagRefusedSecretRead(
  input: TaintAppManagedToolResultsInput,
  call: { readonly inputJson: string },
  outcome: Awaited<ReturnType<AppManagedToolSet["execute"]>>,
): Awaited<ReturnType<AppManagedToolSet["execute"]>> {
  if (!callNamesProtectedSecret(call, input.protectedSecretPath)) return outcome;
  const labels: ReadonlyArray<ShieldWatcherLabel> = ["secret-path-read"];
  const recorded = recordShieldWatcherLabels({
    record: input.recordExternalContentIngestion,
    threadId: input.threadId,
    uuid: input.uuid,
    labels,
    digest: createHash("sha256").update(call.inputJson).digest("hex"),
  });
  return recorded ? { ...outcome, outsideContent: { labels } } : outcome;
}

function callNamesProtectedSecret(
  call: { readonly inputJson: string },
  protectedSecretPath: ((path: string) => boolean) | undefined,
): boolean {
  if (protectedSecretPath === undefined) return false;
  let args: unknown;
  try {
    args = JSON.parse(call.inputJson);
  } catch {
    return false;
  }
  return callReadsProtectedSecret(args, protectedSecretPath);
}

/** What the Watcher finds in one tool result, and in the paths its call named. */
export function watchToolResult(
  call: { readonly inputJson: string },
  result: unknown,
  protectedSecretPath: ((path: string) => boolean) | undefined,
): ReadonlyArray<ShieldWatcherLabel> {
  const labels = watchOutsideContent(watchedTextOf(result));
  return callNamesProtectedSecret(call, protectedSecretPath)
    ? [...labels, "secret-path-read"]
    : labels;
}

function taintSuccessfulResult(
  input: TaintAppManagedToolResultsInput,
  toolName: string,
  outcome: Awaited<ReturnType<AppManagedToolSet["execute"]>>,
  found: { readonly outside: boolean; readonly labels: ReadonlyArray<ShieldWatcherLabel> },
): Awaited<ReturnType<AppManagedToolSet["execute"]>> {
  let body: string;
  try {
    const serialized = JSON.stringify(outcome.result);
    if (typeof serialized !== "string") {
      return { result: { error: "tool-unavailable" }, isError: true };
    }
    body = serialized;
  } catch {
    return { result: { error: "tool-unavailable" }, isError: true };
  }
  const digest = createHash("sha256").update(body).digest("hex");
  if (found.outside) {
    let ingested: ExternalContentIngestionResult;
    try {
      ingested = input.recordExternalContentIngestion({
        threadId: input.threadId,
        provenance: { origin: "tool-result", sourceLabel: toolName },
        contentReference: `app-managed-${toolName}-${digest}`,
        correlationId: input.uuid(),
        authorized: true,
      });
    } catch {
      return { result: { error: "tool-unavailable" }, isError: true };
    }
    if (ingested.kind === "refused") {
      return { result: { error: "tool-unavailable" }, isError: true };
    }
  }
  const recorded = recordShieldWatcherLabels({
    record: input.recordExternalContentIngestion,
    threadId: input.threadId,
    uuid: input.uuid,
    labels: found.labels,
    digest,
  });
  if (!recorded) return { result: { error: "tool-unavailable" }, isError: true };
  return { ...outcome, outsideContent: { labels: found.labels } };
}

/**
 * Journals each Watcher label beside the result it was found in, which marks
 * the thread. False when any could not be journaled: the caller withholds the
 * result rather than hand the model content the mark does not cover.
 */
export function recordShieldWatcherLabels(input: {
  readonly record: (input: RecordExternalContentIngestionInput) => ExternalContentIngestionResult;
  readonly threadId: unknown;
  readonly uuid: () => string;
  readonly labels: ReadonlyArray<ShieldWatcherLabel>;
  /** The result body's digest, so the same finding in the same result is journaled once. */
  readonly digest: string;
}): boolean {
  for (const label of input.labels) {
    try {
      const ingested = input.record({
        threadId: input.threadId,
        provenance: {
          origin: "tool-result",
          sourceLabel: `${SHIELD_WATCHER_SOURCE_PREFIX}${label}`,
        },
        contentReference: `${SHIELD_WATCHER_SOURCE_PREFIX}${label}-${input.digest}`,
        correlationId: input.uuid(),
        authorized: true,
      });
      if (ingested.kind === "refused") return false;
    } catch {
      return false;
    }
  }
  return true;
}
