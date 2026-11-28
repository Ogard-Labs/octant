import {
  GithubRepositoryName,
  GithubRepositoryOwner,
  type GithubCatalogueReadRequest,
  type GithubCatalogueReadResponse,
} from "@octant/contracts";
import {
  decodeLinearIssueListPage,
  LINEAR_ISSUE_LIST_OPERATION,
} from "@octant/contracts/linear-issues";
import { Schema } from "effect";
import type { LinearOperationRunner } from "../trackerIssues/trackerIssuePorts";
import type { TrackerMentionSearchSources } from "./trackerMentionSearch";

const PAGE_SIZE = 10;

/** The `#` list's reads of GitHub, through the host's own catalogue. */
export function githubTrackerSource(input: {
  readonly catalogue: {
    readonly read: (
      request: GithubCatalogueReadRequest,
      signal: AbortSignal,
    ) => Promise<GithubCatalogueReadResponse>;
  };
  readonly connected: () => boolean;
}): TrackerMentionSearchSources["github"] {
  const repository = (named: { readonly owner: string; readonly name: string }) => ({
    owner: Schema.decodeUnknownSync(GithubRepositoryOwner)(named.owner),
    name: Schema.decodeUnknownSync(GithubRepositoryName)(named.name),
  });
  return {
    connected: input.connected,
    search: async (query, signal) => {
      const response = await input.catalogue.read(
        {
          kind: "search",
          ...repository(query),
          query: query.text,
          pageSize: PAGE_SIZE,
          state: "all",
          match: "title",
        },
        signal,
      );
      // A page kept from before a failed read is not what the tracker holds now.
      return response.kind === "search" && response.page.freshness.status === "fresh"
        ? response.page.rows
        : [];
    },
    item: async (query, signal) => {
      const response = await input.catalogue.read(
        { kind: "item", ...repository(query), number: query.number },
        signal,
      );
      return response.kind === "item" && response.freshness.status === "fresh"
        ? response.row
        : undefined;
    },
  };
}

/** The `#` list's reads of Linear, through the host's Linear operations. */
export function linearTrackerSource(input: {
  readonly run: LinearOperationRunner;
  readonly connected: () => boolean;
}): TrackerMentionSearchSources["linear"] {
  return {
    connected: input.connected,
    list: async (query, signal) => {
      const inputPayload = {
        ...("identifier" in query ? { identifier: query.identifier } : { search: query.search }),
        pageSize: PAGE_SIZE,
        ...(query.teamId === undefined ? {} : { filter: { teamId: query.teamId } }),
      };
      const result =
        query.accountRef === undefined
          ? await input.run(LINEAR_ISSUE_LIST_OPERATION, inputPayload, signal)
          : await input.run(LINEAR_ISSUE_LIST_OPERATION, inputPayload, signal, query.accountRef);
      return result.kind === "ok" ? decodeLinearIssueListPage(result.value).rows : [];
    },
  };
}
