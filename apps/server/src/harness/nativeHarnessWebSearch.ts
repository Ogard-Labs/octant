import type { WebSearchBackendEntry } from "@octant/contracts";
import type { WebSearchAnswer, WebSearchInput } from "../webSearch/webSearchBackends";
import type { NativeHarnessToolPorts } from "./nativeHarnessTools";

/**
 * The harness `web-search` port over the web search backends the host's data
 * policy leaves eligible, or nothing when none is, so the tool is not offered
 * and no request can leave the host. Call it when a turn's tools are composed:
 * the list can change while the host runs.
 */
export function harnessWebSearch(options: {
  readonly readEligible: () => ReadonlyArray<WebSearchBackendEntry>;
  /** Searches the backends eligible at the call, with fallback, and journals where it went. */
  readonly search: (input: WebSearchInput) => Promise<WebSearchAnswer>;
}): NativeHarnessToolPorts["webSearch"] {
  if (options.readEligible().length === 0) return undefined;
  return async (input) => {
    // A backend the policy no longer allows must stop receiving queries.
    if (options.readEligible().length === 0) return [];
    return (await options.search(input)).results;
  };
}
