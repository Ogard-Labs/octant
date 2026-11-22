import type { MediaToolSet } from "@octant/plugin-api/media-tools";
import type { AppManagedToolSet } from "./appManagedToolSet";
import {
  taintAppManagedToolResults,
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
  return taintAppManagedToolResults({
    tools: base,
    threadId: input.threadId,
    recordExternalContentIngestion: input.recordExternalContentIngestion,
    uuid: input.uuid,
  });
}
