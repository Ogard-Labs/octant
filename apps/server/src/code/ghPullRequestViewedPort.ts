import { MAX_PULL_REQUEST_VIEWED_FILES } from "@octant/contracts/pull-request-guide";
import {
  sanitizeGhEnvironment,
  validRepository,
  type GhCommandPort,
  type GhCommandResult,
} from "./ghPullRequestPort";

const FILES_PAGE = 100;
const MAX_FILE_PAGES = Math.ceil(MAX_PULL_REQUEST_VIEWED_FILES / FILES_PAGE);
const FILES_QUERY = `query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){id files(first:${FILES_PAGE},after:$after){pageInfo{hasNextPage endCursor} nodes{path viewerViewedState}}}}}`;
const NODE_ID_QUERY =
  "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id headRefOid}}}";
/**
 * Every call names github.com: a `GH_HOST` set for an Enterprise login
 * would otherwise send a github.com pull request's query, and its Viewed
 * mark, to a pull request of the same name there.
 */
const GITHUB_HOST = ["--hostname", "github.com"] as const;
const MARK_MUTATION =
  "mutation($id:ID!,$path:String!){markFileAsViewed(input:{pullRequestId:$id,path:$path}){clientMutationId}}";
const UNMARK_MUTATION =
  "mutation($id:ID!,$path:String!){unmarkFileAsViewed(input:{pullRequestId:$id,path:$path}){clientMutationId}}";

export interface GhPullRequestIdentity {
  readonly owner: string;
  readonly name: string;
  readonly number: number;
}

/** GitHub's own per-person state; DISMISSED (the file changed after it was viewed) reads as `changed`. */
export type GhViewedState = "viewed" | "unviewed" | "changed";

export type GhViewedRead =
  | {
      readonly status: "read";
      readonly files: ReadonlyArray<{ readonly path: string; readonly state: GhViewedState }>;
    }
  | { readonly status: "unavailable" };

export type GhViewedWrite =
  | { readonly status: "done" }
  /** The pull request's head is no longer the one the person reviewed. */
  | { readonly status: "head-moved" }
  | { readonly status: "unavailable" };

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function viewedState(value: unknown): GhViewedState {
  if (value === "VIEWED") return "viewed";
  if (value === "DISMISSED") return "changed";
  return "unviewed";
}

/**
 * Viewed files on a pull request, through the host's `gh` login. The state
 * is GitHub's own `viewerViewedState`, so it follows the person to github.com
 * and back; Octant keeps no copy and journals nothing for it. A write acts
 * under the person's GitHub name.
 */
export class GhPullRequestViewedPort {
  readonly #command: GhCommandPort;
  readonly #environment: NodeJS.ProcessEnv;

  constructor(options: {
    readonly command: GhCommandPort;
    readonly inheritedEnvironment?: NodeJS.ProcessEnv;
  }) {
    this.#command = options.command;
    this.#environment = sanitizeGhEnvironment(options.inheritedEnvironment ?? process.env);
  }

  async read(request: GhPullRequestIdentity, signal: AbortSignal): Promise<GhViewedRead> {
    if (!validRepository(`${request.owner}/${request.name}`)) return { status: "unavailable" };
    const files: Array<{ readonly path: string; readonly state: GhViewedState }> = [];
    let found = false;
    let after: string | undefined;
    for (let page = 0; page < MAX_FILE_PAGES; page += 1) {
      const result = await this.#run(
        [
          "api",
          "graphql",
          ...GITHUB_HOST,
          "-f",
          `owner=${request.owner}`,
          "-f",
          `name=${request.name}`,
          "-F",
          `number=${String(request.number)}`,
          ...(after === undefined ? [] : ["-f", `after=${after}`]),
          "-f",
          `query=${FILES_QUERY}`,
        ],
        signal,
      );
      if (result === undefined || result.exitCode !== 0) return { status: "unavailable" };
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        return { status: "unavailable" };
      }
      const pullRequest = record(record(record(record(parsed)?.data)?.repository)?.pullRequest);
      const connection = record(pullRequest?.files);
      if (typeof pullRequest?.id !== "string" || connection === undefined) {
        return { status: "unavailable" };
      }
      found = true;
      for (const node of Array.isArray(connection.nodes) ? connection.nodes : []) {
        const file = record(node);
        if (typeof file?.path === "string") {
          files.push({ path: file.path, state: viewedState(file.viewerViewedState) });
        }
      }
      const pageInfo = record(connection.pageInfo);
      if (pageInfo?.hasNextPage !== true || typeof pageInfo.endCursor !== "string") break;
      after = pageInfo.endCursor;
    }
    return found ? { status: "read", files } : { status: "unavailable" };
  }

  /**
   * Marks or unmarks one file, on the pull request GitHub names at this
   * number now, and only while its head is the one the person reviewed.
   */
  async write(
    request: GhPullRequestIdentity & {
      readonly path: string;
      readonly viewed: boolean;
      readonly headSha?: string;
    },
    signal: AbortSignal,
  ): Promise<GhViewedWrite> {
    if (!validRepository(`${request.owner}/${request.name}`)) return { status: "unavailable" };
    const lookup = await this.#run(
      [
        "api",
        "graphql",
        ...GITHUB_HOST,
        "-f",
        `owner=${request.owner}`,
        "-f",
        `name=${request.name}`,
        "-F",
        `number=${String(request.number)}`,
        "-f",
        `query=${NODE_ID_QUERY}`,
        "--jq",
        '.data.repository.pullRequest | "\\(.id) \\(.headRefOid)"',
      ],
      signal,
    );
    const [nodeId = "", head = ""] = lookup?.exitCode === 0 ? lookup.stdout.trim().split(" ") : [];
    if (!/^[A-Za-z0-9+/=_-]{1,128}$/.test(nodeId)) return { status: "unavailable" };
    // Unmarking claims nothing was seen, so only a mark waits on the head.
    if (request.viewed && request.headSha !== undefined && head !== request.headSha) {
      return { status: "head-moved" };
    }
    const result = await this.#run(
      [
        "api",
        "graphql",
        ...GITHUB_HOST,
        "-f",
        `id=${nodeId}`,
        "-f",
        `path=${request.path}`,
        "-f",
        `query=${request.viewed ? MARK_MUTATION : UNMARK_MUTATION}`,
      ],
      signal,
    );
    return result !== undefined && result.exitCode === 0
      ? { status: "done" }
      : { status: "unavailable" };
  }

  async #run(
    arguments_: readonly string[],
    signal: AbortSignal,
  ): Promise<GhCommandResult | undefined> {
    try {
      return await this.#command.run(
        arguments_,
        { environment: this.#environment, stdin: undefined },
        signal,
      );
    } catch {
      return undefined;
    }
  }
}
