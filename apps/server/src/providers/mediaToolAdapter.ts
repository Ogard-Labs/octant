import { createHash } from "node:crypto";
import type { MediaToolSet } from "@octant/plugin-api/media-tools";
import type { AppManagedToolSet } from "./appManagedToolSet";
import {
  recordShieldWatcherLabels,
  taintAppManagedToolResults,
  watchToolResult,
  type TaintAppManagedToolResultsInput,
} from "./appManagedToolTaint";

export interface AdaptMediaToolSetInput {
  readonly tools: MediaToolSet;
  readonly threadId?: unknown;
  readonly recordExternalContentIngestion?: TaintAppManagedToolResultsInput["recordExternalContentIngestion"];
  readonly uuid?: () => string;
}

/**
 * Bridges a public `MediaToolSet` onto the server's provider-facing
 * `AppManagedToolSet`, applying host-owned outside-content tainting and
 * Watcher inspection according to the tool set's taint policy.
 */
export function adaptMediaToolSet(input: AdaptMediaToolSetInput): AppManagedToolSet {
  const base: AppManagedToolSet = {
    definitions: input.tools.definitions,
    close: () => input.tools.close(),
    execute: ({ name, inputJson, signal }) =>
      input.tools.execute({
        name,
        inputJson,
        ...(signal === undefined ? {} : { signal }),
      }),
  };
  if (input.tools.taintPolicy === "none") return base;
  if (input.tools.taintPolicy === "watcher-only") {
    if (
      input.recordExternalContentIngestion === undefined ||
      input.threadId === undefined ||
      input.uuid === undefined
    ) {
      return base;
    }
    return taintAppManagedToolResults({
      tools: base,
      threadId: input.threadId,
      recordExternalContentIngestion: input.recordExternalContentIngestion,
      uuid: input.uuid,
      resultTaintsThread: () => false,
    });
  }
  // Fail closed: outside-content results cannot reach a model without a host taint recorder.
  if (
    input.recordExternalContentIngestion === undefined ||
    input.threadId === undefined ||
    input.uuid === undefined
  ) {
    return {
      definitions: base.definitions,
      ...(base.close === undefined ? {} : { close: base.close }),
      execute: async () => ({
        result: { status: "refused", reason: "Outside-content tainting is unavailable." },
        isError: true,
      }),
    };
  }
  const record = input.recordExternalContentIngestion;
  const threadId = input.threadId;
  const uuid = input.uuid;
  if (input.tools.taintErrorResults !== true) {
    return taintAppManagedToolResults({
      tools: base,
      threadId,
      recordExternalContentIngestion: record,
      uuid,
    });
  }
  // Contributed plugins control `isError`, so every plugin-produced result
  // (including `isError: true`) must pass Watcher inspection and outside-content
  // tainting. Only explicit host-bridge refusals (`hostRefused: true`) stay unmarked.
  return {
    definitions: base.definitions,
    ...(base.close === undefined ? {} : { close: base.close }),
    execute: async (call) => {
      const outcome = await input.tools.execute({
        name: call.name,
        inputJson: call.inputJson,
        ...(call.signal === undefined ? {} : { signal: call.signal }),
      });
      if (outcome.hostRefused === true) {
        return {
          result: outcome.result,
          ...(outcome.isError === undefined ? {} : { isError: outcome.isError }),
        };
      }
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
      const labels = watchToolResult(call, outcome.result, undefined);
      try {
        const ingested = record({
          threadId,
          provenance: { origin: "tool-result", sourceLabel: call.name },
          contentReference: `app-managed-${call.name}-${digest}`,
          correlationId: uuid(),
          authorized: true,
        });
        if (ingested.kind === "refused") {
          return { result: { error: "tool-unavailable" }, isError: true };
        }
      } catch {
        return { result: { error: "tool-unavailable" }, isError: true };
      }
      const recordedLabels = recordShieldWatcherLabels({
        record,
        threadId,
        uuid,
        labels,
        digest,
      });
      if (!recordedLabels) {
        return { result: { error: "tool-unavailable" }, isError: true };
      }
      return {
        result: outcome.result,
        ...(outcome.isError === undefined ? {} : { isError: outcome.isError }),
        ...(outcome.images === undefined ? {} : { images: outcome.images }),
        outsideContent: { labels },
      };
    },
  };
}
