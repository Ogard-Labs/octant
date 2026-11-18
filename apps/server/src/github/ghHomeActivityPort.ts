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

const MERGED_PULL_REQUESTS_QUERY =
  "query($owner:String!,$name:String!,$after:String){repository(owner:$owner,name:$name){pullRequests(states:MERGED,first:50,after:$after,orderBy:{field:UPDATED_AT,direction:DESC}){pageInfo{hasNextPage endCursor} nodes{number title mergedAt mergedBy{login}}}}}";
const MAX_MERGED_PR_PAGES = 4;
const MAX_EVENT_PAGES = 3;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampText(value: unknown, maximum: number): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, maximum) : "";
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
    readonly signal: AbortSignal;
  }): Promise<GhHomeActivityResult> {
    if (!validRepository(`${input.owner}/${input.name}`)) {
      return { status: "unavailable", reason: "read-failed" };
    }
    if (input.card === "prs-merged") return this.#mergedPullRequests(input);
    if (input.card === "issues-closed") return this.#issueEvents(input);
    return this.#releaseEvents(input);
  }

  async #mergedPullRequests(input: {
    readonly owner: string;
    readonly name: string;
    readonly signal: AbortSignal;
  }): Promise<GhHomeActivityResult> {
    const rows: GhHomeActivityRow[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_MERGED_PR_PAGES; page += 1) {
      const result = await this.#run(
        [
          "api",
          "graphql",
          "-f",
          `query=${MERGED_PULL_REQUESTS_QUERY}`,
          "-F",
          `owner=${input.owner}`,
          "-F",
          `name=${input.name}`,
          ...(cursor === undefined ? [] : ["-F", `after=${cursor}`]),
        ],
        input.signal,
      );
      if (result === undefined) return { status: "unavailable", reason: "read-failed" };
      if (result.exitCode !== 0) return this.#commandFailure(result, rows);
      const decoded = decodeMergedPullRequestPage(result.stdout);
      if (decoded === undefined) return { status: "unavailable", reason: "read-failed" };
      rows.push(...decoded.rows);
      // Paging ends only on the forge's own pageInfo: merge time is not the
      // UPDATED_AT ordering, so an old merge time must never stop the walk.
      if (!decoded.hasNextPage) return { status: "ready", rows };
      if (decoded.endCursor === undefined) {
        return { status: "partial", rows, reason: "incomplete" };
      }
      cursor = decoded.endCursor;
    }
    return { status: "partial", rows, reason: "incomplete" };
  }

  async #issueEvents(input: {
    readonly owner: string;
    readonly name: string;
    readonly signal: AbortSignal;
  }): Promise<GhHomeActivityResult> {
    const rows: GhHomeActivityRow[] = [];
    for (let page = 1; page <= MAX_EVENT_PAGES; page += 1) {
      const result = await this.#run(
        ["api", `repos/${input.owner}/${input.name}/issues/events?per_page=100&page=${page}`],
        input.signal,
      );
      if (result === undefined) return { status: "unavailable", reason: "read-failed" };
      if (result.exitCode !== 0) return this.#commandFailure(result, rows);
      const decoded = decodeIssueEventPage(result.stdout);
      if (decoded === undefined) return { status: "unavailable", reason: "read-failed" };
      rows.push(...decoded.rows);
      if (decoded.rawCount < 100) return { status: "ready", rows };
    }
    return { status: "partial", rows, reason: "incomplete" };
  }

  async #releaseEvents(input: {
    readonly owner: string;
    readonly name: string;
    readonly signal: AbortSignal;
  }): Promise<GhHomeActivityResult> {
    const rows: GhHomeActivityRow[] = [];
    for (let page = 1; page <= MAX_EVENT_PAGES; page += 1) {
      const result = await this.#run(
        ["api", `repos/${input.owner}/${input.name}/events?per_page=100&page=${page}`],
        input.signal,
      );
      if (result === undefined) return { status: "unavailable", reason: "read-failed" };
      if (result.exitCode !== 0) return this.#commandFailure(result, rows);
      const decoded = decodeReleaseEventPage(result.stdout, input.owner, input.name);
      if (decoded === undefined) return { status: "unavailable", reason: "read-failed" };
      rows.push(...decoded.rows);
      // The repository event feed is retention-bounded (roughly 30 days or
      // 300 events): even a natural end cannot prove the release history is
      // complete, so coverage is always partial, never fabricated ready.
      if (decoded.rawCount < 100) return { status: "partial", rows, reason: "incomplete" };
    }
    return { status: "partial", rows, reason: "incomplete" };
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
    if (/rate limit/i.test(detail)) return { status: "unavailable", reason: "rate-limited" };
    if (/404|not found/i.test(detail)) {
      return { status: "partial", rows, reason: "repository-missing" };
    }
    return rows.length > 0
      ? { status: "partial", rows, reason: "read-failed" }
      : { status: "unavailable", reason: "read-failed" };
  }
}

function decodeMergedPullRequestPage(
  output: string,
): { rows: GhHomeActivityRow[]; hasNextPage: boolean; endCursor: string | undefined } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || !isRecord(value.data) || !isRecord(value.data.repository)) {
    return undefined;
  }
  const pullRequests = value.data.repository.pullRequests;
  if (!isRecord(pullRequests) || !Array.isArray(pullRequests.nodes)) return undefined;
  const pageInfo = pullRequests.pageInfo;
  if (!isRecord(pageInfo) || typeof pageInfo.hasNextPage !== "boolean") return undefined;
  const rows: GhHomeActivityRow[] = [];
  for (const node of pullRequests.nodes) {
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
    hasNextPage: pageInfo.hasNextPage,
    endCursor: typeof pageInfo.endCursor === "string" ? pageInfo.endCursor : undefined,
  };
}

function decodeIssueEventPage(
  output: string,
): { readonly rows: GhHomeActivityRow[]; readonly rawCount: number } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return undefined;
  }
  if (!Array.isArray(value)) return undefined;
  const rows: GhHomeActivityRow[] = [];
  for (const event of value) {
    if (!isRecord(event) || event.event !== "closed" || !isRecord(event.issue)) continue;
    // A closed pull request appears in the same feed; it is not an issue.
    if (event.issue.pull_request !== undefined) continue;
    const actor = event.actor;
    if (
      typeof event.issue.number !== "number" ||
      !Number.isSafeInteger(event.issue.number) ||
      event.issue.number <= 0 ||
      typeof event.created_at !== "string" ||
      !ISO_INSTANT.test(event.created_at) ||
      !isRecord(actor) ||
      typeof actor.login !== "string" ||
      actor.login === ""
    )
      continue;
    rows.push({
      kind: "issues-closed",
      number: event.issue.number,
      title: clampText(event.issue.title, 256),
      closedAt: event.created_at,
      closedBy: actor.login,
    });
  }
  return { rows, rawCount: value.length };
}

function decodeReleaseEventPage(
  output: string,
  owner: string,
  name: string,
): { readonly rows: GhHomeActivityRow[]; readonly rawCount: number } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return undefined;
  }
  if (!Array.isArray(value)) return undefined;
  const rows: GhHomeActivityRow[] = [];
  for (const event of value) {
    if (!isRecord(event) || event.type !== "ReleaseEvent" || !isRecord(event.payload)) continue;
    if (event.payload.action !== "published" || !isRecord(event.payload.release)) continue;
    const release = event.payload.release;
    const url = typeof release.html_url === "string" ? release.html_url : "";
    const actor = event.actor;
    // Only a canonical release link for this repository is a navigable
    // record — a third-party or credential-bearing href is dropped, never
    // shown — and only the event's own actor proves who published.
    if (
      !isCanonicalReleaseHref(url, owner, name) ||
      typeof event.created_at !== "string" ||
      !ISO_INSTANT.test(event.created_at) ||
      !isRecord(actor) ||
      typeof actor.login !== "string" ||
      actor.login === "" ||
      typeof release.id !== "number" ||
      !Number.isSafeInteger(release.id)
    )
      continue;
    const tag = clampText(release.tag_name, 256);
    const releaseName = clampText(release.name, 256) || tag;
    if (tag === "") continue;
    rows.push({
      kind: "releases-published",
      releaseId: release.id,
      tag,
      name: releaseName,
      url,
      publishedAt: event.created_at,
      publishedBy: actor.login,
    });
  }
  return { rows, rawCount: value.length };
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
