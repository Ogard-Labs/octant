import {
  type GhCommandPort,
  type GhCommandResult,
  sanitizeGhEnvironment,
  validRepository,
} from "../code/ghPullRequestPort";

/**
 * Bounded read-only GitHub history for the Code Home forge seam. Every row
 * is something the connected account's own `gh` observed; nothing is
 * inferred, and paging is bounded so a huge history stays honest rather than
 * silently truncated.
 */
export type GhHomeActivityRow =
  | Readonly<{
      kind: "prs-merged";
      number: number;
      title: string;
      mergedAt: string;
      mergedBy: string;
    }>
  | Readonly<{
      kind: "issues-closed";
      number: number;
      title: string;
      closedAt: string;
      closedBy: string;
    }>
  | Readonly<{
      kind: "releases-published";
      releaseId: number;
      tag: string;
      name: string;
      url: string;
      publishedAt: string;
      publishedBy: string;
    }>;

export type GhHomeActivityResult =
  | Readonly<{
      status: "ready";
      rows: ReadonlyArray<GhHomeActivityRow>;
    }>
  | Readonly<{
      /** A bounded page cap or an inaccessible repository kept history short. */
      status: "partial";
      rows: ReadonlyArray<GhHomeActivityRow>;
      reason: "incomplete" | "repository-missing" | "read-failed";
    }>
  | Readonly<{ status: "unavailable"; reason: "rate-limited" | "read-failed" }>;

const MAX_PAGES = 4;
/**
 * GitHub search never returns more than one thousand matches; a larger
 * `issueCount` means the window itself is uncountable, not just unpaged.
 */
const SEARCH_MATCH_LIMIT = 1000;
/**
 * A release page is ordered by creation, not publication: the walk reaches
 * this far past the window start so a draft published inside it is caught.
 * A draft published more than thirty days after creation is the documented
 * miss.
 */
const RELEASE_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

const MERGED_PULL_REQUESTS_QUERY =
  "query($q:String!,$after:String){search(type:ISSUE,first:50,after:$after,query:$q){issueCount pageInfo{hasNextPage endCursor} nodes{... on PullRequest{number title mergedAt mergedBy{login}}}}}";
const CLOSED_ISSUES_QUERY =
  "query($q:String!,$after:String){search(type:ISSUE,first:50,after:$after,query:$q){issueCount pageInfo{hasNextPage endCursor} nodes{... on Issue{number title closedAt timelineItems(itemTypes:[CLOSED_EVENT],last:1){nodes{... on ClosedEvent{createdAt actor{login}}}}}}}}";
const RELEASES_QUERY =
  "query($owner:String!,$name:String!,$after:String){repository(owner:$owner,name:$name){releases(first:50,after:$after,orderBy:{field:CREATED_AT,direction:DESC}){pageInfo{hasNextPage endCursor} nodes{databaseId tagName name url publishedAt createdAt isDraft author{login}}}}}";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampText(value: unknown, maximum: number): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, maximum) : "";
}

interface ObserveInput {
  readonly owner: string;
  readonly name: string;
  /**
   * UTC ISO lower bound (whole seconds) for the history walk, or undefined
   * when there is none. Delivered reads use it as a search qualifier; the
   * release walk uses it to bound how far back it pages.
   */
  readonly since: string | undefined;
  readonly signal: AbortSignal;
}

interface DecodedPage {
  readonly rows: ReadonlyArray<GhHomeActivityRow>;
  /** Search's match total; undefined on the releases connection. */
  readonly issueCount: number | undefined;
  /** Oldest node creation on a releases page, for the windowed walk stop. */
  readonly oldestCreatedAtMs: number | undefined;
  readonly hasNextPage: boolean;
  readonly endCursor: string | undefined;
}

export class GhHomeActivityPort {
  readonly #command: GhCommandPort;
  readonly #environment: NodeJS.ProcessEnv;

  constructor(options: {
    readonly command: GhCommandPort;
    readonly inheritedEnvironment?: NodeJS.ProcessEnv;
  }) {
    this.#command = options.command;
    this.#environment = sanitizeGhEnvironment(options.inheritedEnvironment ?? process.env);
  }

  /**
   * Reads one card's history for one repository on github.com. A missing
   * repository answers partial with no rows — never fabricated history.
   */
  async observe(input: {
    readonly owner: string;
    readonly name: string;
    readonly card: "prs-merged" | "issues-closed" | "releases-published";
    readonly since: string | undefined;
    readonly signal: AbortSignal;
  }): Promise<GhHomeActivityResult> {
    if (!validRepository(`${input.owner}/${input.name}`)) {
      return { status: "unavailable", reason: "read-failed" };
    }
    if (input.card === "prs-merged") return this.#mergedPullRequests(input);
    if (input.card === "issues-closed") return this.#closedIssues(input);
    return this.#releases(input);
  }

  /**
   * Both delivery cards are GitHub searches bounded by a date qualifier, so
   * a windowed read is exact: the search walks at most MAX_PAGES pages of
   * 50, and a match total beyond the search limit reports partial instead
   * of pretending the answer is countable.
   */
  async #search(
    input: ObserveInput & { readonly card: "prs-merged" | "issues-closed" },
  ): Promise<GhHomeActivityResult> {
    const qualifier =
      input.card === "prs-merged"
        ? `repo:${input.owner}/${input.name} is:pr is:merged`
        : `repo:${input.owner}/${input.name} is:issue is:closed`;
    const boundary = input.card === "prs-merged" ? "merged" : "closed";
    const q = input.since === undefined ? qualifier : `${qualifier} ${boundary}:>=${input.since}`;
    const query = input.card === "prs-merged" ? MERGED_PULL_REQUESTS_QUERY : CLOSED_ISSUES_QUERY;
    const decode =
      input.card === "prs-merged" ? decodeMergedPullRequestPage : decodeClosedIssuePage;
    const rows: GhHomeActivityRow[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const decoded = await this.#graphqlPage(
        [
          "api",
          "graphql",
          "-f",
          `query=${query}`,
          "-f",
          `q=${q}`,
          ...(cursor === undefined ? [] : ["-f", `after=${cursor}`]),
        ],
        input.signal,
        (data) => decode(data),
        rows,
      );
      if (decoded.kind === "outcome") return decoded.outcome;
      rows.push(...decoded.page.rows);
      if ((decoded.page.issueCount ?? 0) > SEARCH_MATCH_LIMIT) {
        return { status: "partial", rows, reason: "incomplete" };
      }
      if (!decoded.page.hasNextPage) return { status: "ready", rows };
      if (decoded.page.endCursor === undefined) {
        return { status: "partial", rows, reason: "incomplete" };
      }
      cursor = decoded.page.endCursor;
    }
    return { status: "partial", rows, reason: "incomplete" };
  }

  async #mergedPullRequests(input: ObserveInput): Promise<GhHomeActivityResult> {
    return this.#search({ ...input, card: "prs-merged" });
  }

  async #closedIssues(input: ObserveInput): Promise<GhHomeActivityResult> {
    return this.#search({ ...input, card: "issues-closed" });
  }

  /**
   * The releases connection has no published-date qualifier, so the walk is
   * bounded by creation order: keep reading while a page's oldest createdAt
   * can still hide a draft published inside the window (thirty days of draft
   * lag), then stop ready. Drafts are never rows — they were not published.
   */
  async #releases(input: ObserveInput): Promise<GhHomeActivityResult> {
    const stopBeforeMs =
      input.since === undefined ? undefined : Date.parse(input.since) - RELEASE_LOOKBACK_MS;
    const rows: GhHomeActivityRow[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const decoded = await this.#graphqlPage(
        [
          "api",
          "graphql",
          "-f",
          `query=${RELEASES_QUERY}`,
          "-f",
          `owner=${input.owner}`,
          "-f",
          `name=${input.name}`,
          ...(cursor === undefined ? [] : ["-f", `after=${cursor}`]),
        ],
        input.signal,
        (data) => decodeReleasesPage(data, input.owner, input.name),
        rows,
      );
      if (decoded.kind === "outcome") return decoded.outcome;
      rows.push(...decoded.page.rows);
      if (
        stopBeforeMs !== undefined &&
        decoded.page.oldestCreatedAtMs !== undefined &&
        decoded.page.oldestCreatedAtMs < stopBeforeMs
      ) {
        return { status: "ready", rows };
      }
      if (!decoded.page.hasNextPage) return { status: "ready", rows };
      if (decoded.page.endCursor === undefined) {
        return { status: "partial", rows, reason: "incomplete" };
      }
      cursor = decoded.page.endCursor;
    }
    return { status: "partial", rows, reason: "incomplete" };
  }

  /**
   * One `gh api graphql` call plus the outcome it implies: a page to consume,
   * or a finished result the card loop returns as-is.
   */
  async #graphqlPage(
    arguments_: readonly string[],
    signal: AbortSignal,
    decode: (data: unknown) => DecodedPage | undefined,
    rows: GhHomeActivityRow[],
  ): Promise<
    | { readonly kind: "page"; readonly page: DecodedPage }
    | { readonly kind: "outcome"; readonly outcome: GhHomeActivityResult }
  > {
    const result = await this.#run(arguments_, signal);
    const fail = (outcome: GhHomeActivityResult) => ({ kind: "outcome" as const, outcome });
    if (result === undefined) {
      return fail({ status: "unavailable", reason: "read-failed" });
    }
    if (result.exitCode !== 0) {
      return fail(this.#commandFailure(result, rows));
    }
    const payload = graphQlPayload(result.stdout);
    if (payload === undefined) {
      return fail({ status: "unavailable", reason: "read-failed" });
    }
    if (payload.errors.length > 0) {
      return fail(this.#graphQlFailure(payload.errors, rows));
    }
    const page = decode(payload.data);
    if (page === undefined) {
      return fail({ status: "unavailable", reason: "read-failed" });
    }
    return { kind: "page", page };
  }

  async #run(
    arguments_: readonly string[],
    signal: AbortSignal,
  ): Promise<GhCommandResult | undefined> {
    try {
      return await this.#command.run(
        arguments_,
        {
          environment: this.#environment,
          stdin: undefined,
        },
        signal,
      );
    } catch {
      return undefined;
    }
  }

  #commandFailure(result: GhCommandResult, rows: GhHomeActivityRow[]): GhHomeActivityResult {
    const detail = `${result.stderr ?? ""} ${result.stdout}`;
    // Rate limit first: GitHub's throttled 403 names the limit itself.
    if (/rate limit/i.test(detail)) return { status: "unavailable", reason: "rate-limited" };
    if (/Could not resolve to a Repository|404|not found/i.test(detail)) {
      return { status: "partial", rows, reason: "repository-missing" };
    }
    // An explicit access refusal is as permanent as a 404: the repository's
    // cached rows are purged rather than kept as partial coverage.
    if (/HTTP 403|SAML enforcement|Resource not accessible|FORBIDDEN/i.test(detail)) {
      return { status: "partial", rows, reason: "repository-missing" };
    }
    return rows.length > 0
      ? { status: "partial", rows, reason: "read-failed" }
      : { status: "unavailable", reason: "read-failed" };
  }

  /**
   * `gh api graphql` exits 0 on a GraphQL `errors` array; the array is the
   * answer, never the rows. A repository the token cannot resolve is a
   * missing repository, like a 404; anything else is a read failure.
   */
  #graphQlFailure(errors: ReadonlyArray<string>, rows: GhHomeActivityRow[]): GhHomeActivityResult {
    const detail = errors.join(" ");
    // Rate limit first: GitHub's throttled 403 names the limit itself.
    if (/rate limit/i.test(detail)) return { status: "unavailable", reason: "rate-limited" };
    if (
      /Could not resolve to a Repository|HTTP 403|SAML enforcement|Resource not accessible|FORBIDDEN/i.test(
        detail,
      )
    ) {
      return { status: "partial", rows, reason: "repository-missing" };
    }
    return { status: "unavailable", reason: "read-failed" };
  }
}

/** The top level of a `gh api graphql` answer: `data`, plus any `errors`. */
function graphQlPayload(
  output: string,
): { readonly data: unknown; readonly errors: ReadonlyArray<string> } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const errors = Array.isArray(value.errors)
    ? value.errors
        .filter(isRecord)
        .map((entry) =>
          [
            typeof entry.message === "string" ? entry.message : "",
            typeof entry.type === "string" ? entry.type : "",
          ]
            .filter((part) => part !== "")
            .join(" "),
        )
    : [];
  return { data: value.data, errors };
}

function searchConnection(data: unknown):
  | Readonly<{
      nodes: ReadonlyArray<unknown>;
      issueCount: number;
      hasNextPage: boolean;
      endCursor: string | undefined;
    }>
  | undefined {
  if (!isRecord(data) || !isRecord(data.search)) return undefined;
  const search = data.search;
  if (
    !Array.isArray(search.nodes) ||
    typeof search.issueCount !== "number" ||
    !Number.isSafeInteger(search.issueCount) ||
    !isRecord(search.pageInfo) ||
    typeof search.pageInfo.hasNextPage !== "boolean"
  )
    return undefined;
  return {
    nodes: search.nodes,
    issueCount: search.issueCount,
    hasNextPage: search.pageInfo.hasNextPage,
    endCursor:
      typeof search.pageInfo.endCursor === "string" ? search.pageInfo.endCursor : undefined,
  };
}

function decodeMergedPullRequestPage(data: unknown): DecodedPage | undefined {
  const search = searchConnection(data);
  if (search === undefined) return undefined;
  const rows: GhHomeActivityRow[] = [];
  for (const node of search.nodes) {
    if (!isRecord(node)) continue;
    // A merge observation carries its audited merger; without both fields
    // the row is unconfirmed and counts nothing.
    if (
      typeof node.number !== "number" ||
      !Number.isSafeInteger(node.number) ||
      node.number <= 0 ||
      typeof node.mergedAt !== "string" ||
      !ISO_INSTANT.test(node.mergedAt) ||
      !isRecord(node.mergedBy) ||
      typeof node.mergedBy.login !== "string" ||
      node.mergedBy.login === ""
    )
      continue;
    rows.push({
      kind: "prs-merged",
      number: node.number,
      title: clampText(node.title, 256),
      mergedAt: node.mergedAt,
      mergedBy: node.mergedBy.login,
    });
  }
  return {
    rows,
    issueCount: search.issueCount,
    oldestCreatedAtMs: undefined,
    hasNextPage: search.hasNextPage,
    endCursor: search.endCursor,
  };
}

function decodeClosedIssuePage(data: unknown): DecodedPage | undefined {
  const search = searchConnection(data);
  if (search === undefined) return undefined;
  const rows: GhHomeActivityRow[] = [];
  for (const node of search.nodes) {
    if (!isRecord(node)) continue;
    // The row counts the issue's own close time and the actor of its last
    // ClosedEvent; a close with neither is unconfirmed and counts nothing.
    const timeline = isRecord(node.timelineItems) ? node.timelineItems.nodes : undefined;
    const event =
      Array.isArray(timeline) && timeline.length > 0 ? timeline[timeline.length - 1] : undefined;
    const actor = isRecord(event) && isRecord(event.actor) ? event.actor.login : undefined;
    if (
      typeof node.number !== "number" ||
      !Number.isSafeInteger(node.number) ||
      node.number <= 0 ||
      typeof node.closedAt !== "string" ||
      !ISO_INSTANT.test(node.closedAt) ||
      !isRecord(event) ||
      typeof actor !== "string" ||
      actor === ""
    )
      continue;
    rows.push({
      kind: "issues-closed",
      number: node.number,
      title: clampText(node.title, 256),
      closedAt: node.closedAt,
      closedBy: actor,
    });
  }
  return {
    rows,
    issueCount: search.issueCount,
    oldestCreatedAtMs: undefined,
    hasNextPage: search.hasNextPage,
    endCursor: search.endCursor,
  };
}

function decodeReleasesPage(data: unknown, owner: string, name: string): DecodedPage | undefined {
  if (!isRecord(data) || !isRecord(data.repository) || !isRecord(data.repository.releases)) {
    return undefined;
  }
  const releases = data.repository.releases;
  if (
    !Array.isArray(releases.nodes) ||
    !isRecord(releases.pageInfo) ||
    typeof releases.pageInfo.hasNextPage !== "boolean"
  )
    return undefined;
  const rows: GhHomeActivityRow[] = [];
  let oldestCreatedAtMs: number | undefined;
  for (const node of releases.nodes) {
    if (!isRecord(node)) continue;
    // The walk bound comes from every node's creation, skipped or not: a
    // draft is exactly the row whose publication can lag its creation.
    if (typeof node.createdAt === "string" && ISO_INSTANT.test(node.createdAt)) {
      const createdAtMs = Date.parse(node.createdAt);
      if (oldestCreatedAtMs === undefined || createdAtMs < oldestCreatedAtMs) {
        oldestCreatedAtMs = createdAtMs;
      }
    }
    if (
      node.isDraft === true ||
      typeof node.publishedAt !== "string" ||
      !ISO_INSTANT.test(node.publishedAt) ||
      !isRecord(node.author) ||
      typeof node.author.login !== "string" ||
      node.author.login === "" ||
      typeof node.databaseId !== "number" ||
      !Number.isSafeInteger(node.databaseId)
    )
      continue;
    // GitHub exposes no publisher on a release: the author is the account
    // that created it, and only a canonical tag link for this repository is
    // a navigable record.
    const url = typeof node.url === "string" ? node.url : "";
    const tag = clampText(node.tagName, 256);
    if (!isCanonicalReleaseHref(url, owner, name) || tag === "") continue;
    rows.push({
      kind: "releases-published",
      releaseId: node.databaseId,
      tag,
      name: clampText(node.name, 256) || tag,
      url,
      publishedAt: node.publishedAt,
      publishedBy: node.author.login,
    });
  }
  return {
    rows,
    issueCount: undefined,
    oldestCreatedAtMs,
    hasNextPage: releases.pageInfo.hasNextPage,
    endCursor:
      typeof releases.pageInfo.endCursor === "string" ? releases.pageInfo.endCursor : undefined,
  };
}

function isCanonicalReleaseHref(url: string, owner: string, name: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "github.com" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    return false;
  }
  const prefix = `/${owner.toLowerCase()}/${name.toLowerCase()}/releases/tag/`;
  const path = parsed.pathname.toLowerCase();
  return path.startsWith(prefix) && path.length > prefix.length;
}
