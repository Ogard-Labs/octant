import {
  DEFAULT_WEB_SEARCH_RESULTS,
  NativeHarnessWebSearchArguments,
  WEB_SEARCH_TOOL_DEFINITION,
} from "@octant/contracts";
import { Schema } from "effect";
import type { AppManagedToolSet } from "../../providers/appManagedToolSet";
import type { ResearchExecuteInput, ResearchExecutionResult } from "./researchRouter";

/**
 * Octant's web search for a Chat thread whose research route searches through
 * SearXNG: the same definition, argument schema, and result shape as the
 * harness's `web-search`, executed through the route.
 *
 * A call without a usable query is refused as invalid. Earlier, a missing
 * query silently searched the person's whole prompt, which sent text they
 * never meant as a query to the search service.
 */
export function createWebSearchTools(
  search: (input: ResearchExecuteInput) => Promise<ResearchExecutionResult>,
): AppManagedToolSet {
  return {
    definitions: [WEB_SEARCH_TOOL_DEFINITION],
    execute: async ({ name, inputJson, signal }) => {
      if (name !== WEB_SEARCH_TOOL_DEFINITION.name) {
        return { result: { error: "tool-unavailable" }, isError: true };
      }
      const input = webSearchArguments(inputJson);
      if (input === undefined) {
        return {
          result: {
            error: "invalid-query",
            message: "query is required: a non-empty search of at most 512 characters.",
          },
          isError: true,
        };
      }
      try {
        const found = await search({
          query: input.query,
          limit: input.limit ?? DEFAULT_WEB_SEARCH_RESULTS,
          ...(signal === undefined ? {} : { signal }),
        });
        return { result: { query: input.query, results: found.results } };
      } catch {
        // A failed search is an answer the model can act on, not a reason to
        // end the person's turn.
        return {
          result: { error: "search-failed", message: "The search service did not answer." },
          isError: true,
        };
      }
    },
  };
}

const decodeWebSearchArguments = Schema.decodeUnknownSync(NativeHarnessWebSearchArguments);

function webSearchArguments(inputJson: string): NativeHarnessWebSearchArguments | undefined {
  try {
    return decodeWebSearchArguments(JSON.parse(inputJson));
  } catch {
    return undefined;
  }
}
