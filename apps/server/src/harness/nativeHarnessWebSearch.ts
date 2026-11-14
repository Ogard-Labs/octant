import type { WebSearchBackendEntry } from "@octant/contracts";
import type { SearxngFetch } from "../chat/research/searxngClient";
import { searchWebSearchBackends } from "../webSearch/webSearchBackends";
import type { NativeHarnessToolPorts } from "./nativeHarnessTools";

/**
 * The harness `web-search` port over the web search backends the host's data
 * policy leaves eligible, or nothing when none is, so the tool is not offered
 * and no request can leave the host. Call it when a turn's tools are composed:
 * the list can change while the host runs.
 */
export function harnessWebSearch(options: {
  readonly readEligible: () => ReadonlyArray<WebSearchBackendEntry>;
  readonly fetch?: SearxngFetch;
}): NativeHarnessToolPorts["webSearch"] {
  if (options.readEligible().length === 0) return undefined;
  return async (input) => {
    // Read again per call: a turn may outlive the setting it started with,
    // and a backend the policy no longer allows must stop receiving queries.
    const backends = options.readEligible();
    if (backends.length === 0) return [];
    const found = await searchWebSearchBackends({
      backends,
      search: input,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    return found.results;
  };
}
