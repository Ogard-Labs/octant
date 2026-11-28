import { Schema } from "effect";
import { PositiveInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import {
  GithubCatalogueUnavailableReason,
  GithubRepositoryName,
  GithubRepositoryOwner,
} from "./githubCatalogue";

/**
 * The only GitHub issue identity a renderer may attach to a new thread. The
 * server re-reads the issue, redacts it, and frames it; the client never
 * assembles issue text.
 */
export const GithubIssueContextRequest = Schema.Struct({
  owner: GithubRepositoryOwner,
  name: GithubRepositoryName,
  number: PositiveInt,
});
export type GithubIssueContextRequest = typeof GithubIssueContextRequest.Type;

export const GithubIssueContextRefusedReason = GithubCatalogueUnavailableReason;
export type GithubIssueContextRefusedReason = typeof GithubIssueContextRefusedReason.Type;

export const decodeGithubIssueContextRequest = Schema.decodeUnknownSync(
  GithubIssueContextRequest,
  STRICT_DECODE_OPTIONS,
);
