import { Schema } from "effect";
import {
  GithubCatalogueUnavailableReason,
  GithubRepositoryName,
  GithubRepositoryOwner,
} from "./githubCatalogue";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * The only GitHub issue identity a renderer may attach to a new thread. The
 * server re-reads the issue, redacts it, and frames it; the client never
 * assembles issue text.
 */
export const GithubIssueContextRequest = Schema.Struct({
  owner: GithubRepositoryOwner,
  name: GithubRepositoryName,
  number: Schema.Int.pipe(Schema.positive()),
}).annotations(strict);
export type GithubIssueContextRequest = typeof GithubIssueContextRequest.Type;

export const GithubIssueContextRefusedReason = GithubCatalogueUnavailableReason;
export type GithubIssueContextRefusedReason = typeof GithubIssueContextRefusedReason.Type;

export const decodeGithubIssueContextRequest = Schema.decodeUnknownSync(GithubIssueContextRequest);
