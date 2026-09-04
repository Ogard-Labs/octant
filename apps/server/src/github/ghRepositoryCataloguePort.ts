import { spawn } from "node:child_process";
import { constants, accessSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { sanitizedEnvironment } from "./ghAuthenticationPort";

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const READ_TIMEOUT_MS = 20_000;
/** Upstream REST fetches allowed while assembling one bounded page. */
const MAX_UPSTREAM_FETCHES = 10;
const UPSTREAM_PAGE_SIZE = 100;
const ISSUE_BODY_MAX_BYTES = 8 * 1024;
const COMMENT_BODY_MAX_BYTES = 2 * 1024;
const MAX_ISSUE_COMMENTS = 10;
const MAX_ISSUE_LABELS = 20;
const LABEL_MAX_CHARS = 50;
const MAX_SEARCH_QUERY_CHARS = 256;
/** Newest 30 per category; the inbox is a glance, not a catalogue. */
const ASSIGNED_WORK_CATEGORY_LIMIT = 30;
const SECRETISH =
  /(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|bearer\s+|token=|authorization)/gi;
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const NAME_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/;
const NODE_ID_PATTERN = /^[A-Za-z0-9+/=_-]{1,128}$/;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const GITHUB_URL_PATTERN = /^https:\/\/github\.com\/[A-Za-z0-9_.\-/#?=&%]*$/;
const PROJECTS_QUERY =
  "query($owner:String!,$name:String!,$first:Int!,$after:String){" +
  "repository(owner:$owner,name:$name){" +
  "projectsV2(first:$first,after:$after,orderBy:{field:UPDATED_AT,direction:DESC}){" +
  "nodes{number title closed updatedAt url} pageInfo{hasNextPage endCursor}}}}";

export interface GhCatalogueCommandPort {
  run(
    arguments_: readonly string[],
    options: { readonly environment: NodeJS.ProcessEnv },
    signal: AbortSignal,
  ): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr?: string }>;
  close?(): void;
}

export interface GhRepositoryObservationRow {
  readonly nodeId: string;
  readonly owner: string;
  readonly name: string;
  readonly visibility: "public" | "private" | "internal";
  readonly defaultBranch?: string;
  readonly viewerPermission: "admin" | "maintain" | "write" | "triage" | "read" | "none";
}

export interface GhIssueObservationRow {
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "closed";
  readonly author: string;
  readonly updatedAt: string;
  readonly url: string;
}

export interface GhIssueCommentObservation {
  readonly author: string;
  readonly createdAt: string;
  readonly body: string;
  readonly truncated: boolean;
}

export interface GhIssueDetailObservation {
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "closed";
  readonly author: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly url: string;
  readonly labels: readonly string[];
  readonly body: string;
  readonly bodyTruncated: boolean;
  readonly comments: readonly GhIssueCommentObservation[];
}

export interface GhPullRequestObservationRow {
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "draft" | "merged" | "closed";
  readonly author: string;
  readonly updatedAt: string;
  readonly url: string;
  readonly baseBranch?: string;
  readonly headBranch?: string;
}

export interface GhAssignedWorkObservationItem {
  readonly category: "issue" | "pull-request" | "review-request";
  readonly owner: string;
  readonly name: string;
  readonly number: number;
  readonly title: string;
  readonly author: string;
  readonly updatedAt: string;
  readonly url: string;
}

export interface GhProjectObservationRow {
  readonly number: number;
  readonly title: string;
  readonly closed: boolean;
  readonly updatedAt: string;
  readonly url: string;
}

export interface GhCataloguePageObservation<Row> {
  readonly rows: readonly Row[];
  readonly hasNextPage: boolean;
  readonly endCursor?: string;
}

export type GhCatalogueFailureKind =
  | "unauthorized"
  | "scope-limited"
  | "rate-limited"
  | "invalid-cursor"
  | "unavailable";

export type GhCatalogueFailure = {
  readonly kind: GhCatalogueFailureKind;
  readonly remediation?: string;
  readonly retryAfterSeconds?: number;
};

export type GhCatalogueResult<T> = { readonly kind: "ok"; readonly value: T } | GhCatalogueFailure;

export type GhOperationProbeResults = Partial<
  Record<"repository-catalogue" | "issues-read" | "pull-requests-read" | "projects-read", boolean>
>;

export interface GhOperationProbePort {
  probeOperations(signal: AbortSignal): Promise<GhOperationProbeResults>;
}

interface CursorPayload {
  readonly v: 1;
  readonly k: string;
  /** Discriminator binding the cursor to the exact query it belongs to. */
  readonly d: string;
  readonly p?: number;
  readonly o?: number;
  readonly a?: string;
}

/**
 * The only surface through which Octant reads GitHub repository, Issue,
 * pull-request, and Projects metadata. Every command is a fixed, non-mutating
 * `gh api` read against github.com; no caller-selected endpoint, GraphQL,
 * field, header, host, or flag can cross it.
 */
export class GhRepositoryCataloguePort implements GhOperationProbePort {
  readonly #command: GhCatalogueCommandPort;
  readonly #inheritedEnvironment: NodeJS.ProcessEnv;

  constructor(options: {
    readonly command?: GhCatalogueCommandPort;
    readonly ghExecutable?: string;
    readonly inheritedEnvironment?: NodeJS.ProcessEnv;
  }) {
    this.#command = options.command ?? createGhCatalogueCommandPort(options.ghExecutable);
    this.#inheritedEnvironment = options.inheritedEnvironment ?? process.env;
  }

  close(): void {
    this.#command.close?.();
  }

  async listRepositories(
    request: {
      readonly pageSize: number;
      readonly cursor?: string | undefined;
      readonly search?: string;
    },
    signal: AbortSignal,
  ): Promise<GhCatalogueResult<GhCataloguePageObservation<GhRepositoryObservationRow>>> {
    const search = (request.search ?? "").trim().toLowerCase();
    return this.#paginateRest({
      kind: "repositories",
      discriminator: search,
      pageSize: request.pageSize,
      cursor: request.cursor,
      pathFor: (page) =>
        "user/repos?affiliation=owner,collaborator,organization_member" +
        `&sort=pushed&direction=desc&per_page=${UPSTREAM_PAGE_SIZE}&page=${page}`,
      decodeItem: decodeRepositoryItem,
      matches: (row) => search === "" || `${row.owner}/${row.name}`.toLowerCase().includes(search),
      signal,
    });
  }

  async listIssues(
    request: {
      readonly owner: string;
      readonly name: string;
      readonly pageSize: number;
      readonly cursor?: string | undefined;
      readonly state: "open" | "closed" | "all";
      readonly search?: string | undefined;
      readonly assignee?: "none" | undefined;
    },
    signal: AbortSignal,
  ): Promise<GhCatalogueResult<GhCataloguePageObservation<GhIssueObservationRow>>> {
    const repository = validatedRepositoryPath(request.owner, request.name);
    if (repository === undefined) return { kind: "unavailable" };
    const search = (request.search ?? "").trim();
    if (search !== "") {
      const query = composeIssueSearchQuery({
        owner: request.owner,
        name: request.name,
        state: request.state,
        search,
        unassigned: request.assignee === "none",
      });
      if (query === undefined) return ok([], false);
      return this.#paginateRest({
        kind: "issues",
        discriminator: `${repository}|${request.state}|${search}${
          request.assignee === "none" ? "|unassigned" : ""
        }`,
        pageSize: request.pageSize,
        cursor: request.cursor,
        pathFor: (page) =>
          `search/issues?q=${encodeURIComponent(query)}` +
          `&sort=updated&order=desc&per_page=${UPSTREAM_PAGE_SIZE}&page=${page}`,
        decodeItem: decodeIssueItem,
        matches: () => true,
        extractItems: extractSearchIssueItems,
        signal,
      });
    }
    // `assignee=none` is GitHub's own filter for unassigned issues. It joins
    // the discriminator so a narrowed read never continues a page cursor that
    // was opened for the unnarrowed one.
    const unassigned = request.assignee === "none";
    return this.#paginateRest({
      kind: "issues",
      discriminator: `${repository}|${request.state}${unassigned ? "|unassigned" : ""}`,
      pageSize: request.pageSize,
      cursor: request.cursor,
      pathFor: (page) =>
        `repos/${repository}/issues?state=${request.state}` +
        (unassigned ? "&assignee=none" : "") +
        `&sort=updated&direction=desc&per_page=${UPSTREAM_PAGE_SIZE}&page=${page}`,
      decodeItem: decodeIssueItem,
      matches: () => true,
      signal,
    });
  }

  async readIssue(
    request: {
      readonly owner: string;
      readonly name: string;
      readonly number: number;
    },
    signal: AbortSignal,
  ): Promise<GhCatalogueResult<GhIssueDetailObservation>> {
    const repository = validatedRepositoryPath(request.owner, request.name);
    if (repository === undefined) return { kind: "unavailable" };
    if (!Number.isSafeInteger(request.number) || request.number <= 0) {
      return { kind: "unavailable" };
    }
    const issueResult = await this.#run(
      ["api", `repos/${repository}/issues/${request.number}`],
      signal,
    );
    if (issueResult.kind !== "ok") return issueResult;
    const issue = decodeIssueDetail(issueResult.stdout);
    if (issue === undefined) return { kind: "unavailable" };
    const comments = await this.#readIssueComments(repository, request.number, signal);
    if (comments.kind !== "ok") return comments;
    return { kind: "ok", value: { ...issue, comments: comments.value } };
  }

  async listPullRequests(
    request: {
      readonly owner: string;
      readonly name: string;
      readonly pageSize: number;
      readonly cursor?: string | undefined;
      readonly state: "open" | "closed" | "all";
    },
    signal: AbortSignal,
  ): Promise<GhCatalogueResult<GhCataloguePageObservation<GhPullRequestObservationRow>>> {
    const repository = validatedRepositoryPath(request.owner, request.name);
    if (repository === undefined) return { kind: "unavailable" };
    return this.#paginateRest({
      kind: "pull-requests",
      discriminator: `${repository}|${request.state}`,
      pageSize: request.pageSize,
      cursor: request.cursor,
      pathFor: (page) =>
        `repos/${repository}/pulls?state=${request.state}` +
        `&sort=updated&direction=desc&per_page=${UPSTREAM_PAGE_SIZE}&page=${page}`,
      decodeItem: decodePullRequestItem,
      matches: () => true,
      signal,
    });
  }

  async listProjects(
    request: {
      readonly owner: string;
      readonly name: string;
      readonly pageSize: number;
      readonly cursor?: string | undefined;
    },
    signal: AbortSignal,
  ): Promise<GhCatalogueResult<GhCataloguePageObservation<GhProjectObservationRow>>> {
    const repository = validatedRepositoryPath(request.owner, request.name);
    if (repository === undefined) return { kind: "unavailable" };
    let after: string | undefined;
    if (request.cursor !== undefined) {
      const payload = decodeCursor(request.cursor);
      if (
        payload === undefined ||
        payload.k !== "projects" ||
        payload.d !== repository ||
        typeof payload.a !== "string"
      ) {
        return { kind: "invalid-cursor" };
      }
      after = payload.a;
    }
    const result = await this.#run(
      [
        "api",
        "graphql",
        "-f",
        `query=${PROJECTS_QUERY}`,
        "-F",
        `owner=${request.owner}`,
        "-F",
        `name=${request.name}`,
        "-F",
        `first=${request.pageSize}`,
        ...(after === undefined ? [] : ["-F", `after=${after}`]),
      ],
      signal,
    );
    if (result.kind !== "ok") return result;
    return decodeProjectsPage(result.stdout, repository);
  }

  /**
   * Open items waiting on the signed-in account, across every repository it
   * can see. A bounded snapshot rather than a pageable catalogue: three fixed
   * search reads (assigned issues, assigned pull requests, requested reviews),
   * first page only. `@me` binds each query to gh's own authentication, so no
   * caller-chosen login can cross this surface.
   */
  async listAssignedWork(
    signal: AbortSignal,
  ): Promise<GhCatalogueResult<readonly GhAssignedWorkObservationItem[]>> {
    const searches = [
      { category: "review-request", query: "type:pr is:open archived:false review-requested:@me" },
      { category: "pull-request", query: "type:pr is:open archived:false assignee:@me" },
      { category: "issue", query: "type:issue is:open archived:false assignee:@me" },
    ] as const;
    const items = new Map<string, GhAssignedWorkObservationItem>();
    for (const search of searches) {
      const result = await this.#run(
        [
          "api",
          `search/issues?q=${encodeURIComponent(search.query)}` +
            `&sort=updated&order=desc&per_page=${ASSIGNED_WORK_CATEGORY_LIMIT}`,
        ],
        signal,
      );
      if (result.kind !== "ok") return result;
      const parsed = extractSearchIssueItems(result.stdout);
      if (parsed === undefined || parsed.length > UPSTREAM_PAGE_SIZE) {
        return { kind: "unavailable" };
      }
      for (const item of parsed) {
        const decoded = decodeAssignedWorkItem(item, search.category);
        if (decoded === undefined) return { kind: "unavailable" };
        if (decoded === "skip") continue;
        // A pull request can be both assigned and review-requested; the
        // review request wins because searches run in that order, and one
        // row per item keeps the inbox honest about how much is waiting.
        const key = `${decoded.owner}/${decoded.name}#${decoded.number}`;
        if (!items.has(key)) items.set(key, decoded);
      }
    }
    return { kind: "ok", value: [...items.values()] };
  }

  /**
   * Proves each normalized read capability with a minimal live operation.
   * OAuth scopes alone never become capability.
   */
  async probeOperations(signal: AbortSignal): Promise<GhOperationProbeResults> {
    const restProbe = await this.#run(
      ["api", "user/repos?per_page=1&affiliation=owner,collaborator,organization_member"],
      signal,
    );
    const repositoryCatalogue =
      restProbe.kind === "ok" && Array.isArray(tryParseJson(restProbe.stdout));
    return {
      "repository-catalogue": repositoryCatalogue,
      "issues-read": await this.#probeViewerGraphql("issues", signal),
      "pull-requests-read": await this.#probeViewerGraphql("pullRequests", signal),
      "projects-read": await this.#probeViewerGraphql("projectsV2", signal),
    };
  }

  async #probeViewerGraphql(
    field: "issues" | "pullRequests" | "projectsV2",
    signal: AbortSignal,
  ): Promise<boolean> {
    const result = await this.#run(
      ["api", "graphql", "-f", `query=query{viewer{${field}(first:1){totalCount}}}`],
      signal,
    );
    if (result.kind !== "ok") return false;
    const parsed = tryParseJson(result.stdout);
    return (
      isRecord(parsed) &&
      isRecord(parsed.data) &&
      (parsed.errors === undefined || (Array.isArray(parsed.errors) && parsed.errors.length === 0))
    );
  }

  async #readIssueComments(
    repository: string,
    number: number,
    signal: AbortSignal,
  ): Promise<GhCatalogueResult<readonly GhIssueCommentObservation[]>> {
    const comments: GhIssueCommentObservation[] = [];
    for (let page = 1; page <= MAX_UPSTREAM_FETCHES; page += 1) {
      const result = await this.#run(
        [
          "api",
          `repos/${repository}/issues/${number}/comments` +
            `?per_page=${UPSTREAM_PAGE_SIZE}&page=${page}`,
        ],
        signal,
      );
      if (result.kind !== "ok") return result;
      const items = tryParseJson(result.stdout);
      if (!Array.isArray(items) || items.length > UPSTREAM_PAGE_SIZE) {
        return { kind: "unavailable" };
      }
      for (const item of items) {
        const comment = decodeIssueComment(item);
        if (comment === undefined) return { kind: "unavailable" };
        comments.push(comment);
      }
      if (items.length < UPSTREAM_PAGE_SIZE) break;
    }
    return { kind: "ok", value: comments.slice(-MAX_ISSUE_COMMENTS) };
  }

  async #paginateRest<Row>(options: {
    readonly kind: string;
    readonly discriminator: string;
    readonly pageSize: number;
    readonly cursor?: string | undefined;
    readonly pathFor: (page: number) => string;
    readonly decodeItem: (item: unknown) => Row | "skip" | undefined;
    readonly matches: (row: Row) => boolean;
    readonly extractItems?: (stdout: string) => readonly unknown[] | undefined;
    readonly signal: AbortSignal;
  }): Promise<GhCatalogueResult<GhCataloguePageObservation<Row>>> {
    let page = 1;
    let offset = 0;
    if (options.cursor !== undefined) {
      const payload = decodeCursor(options.cursor);
      if (
        payload === undefined ||
        payload.k !== options.kind ||
        payload.d !== options.discriminator ||
        !isPositiveInteger(payload.p) ||
        !isNonNegativeInteger(payload.o)
      ) {
        return { kind: "invalid-cursor" };
      }
      page = payload.p;
      offset = payload.o;
    }
    const rows: Row[] = [];
    const cursorAt = (nextPage: number, nextOffset: number) =>
      encodeCursor({
        v: 1,
        k: options.kind,
        d: options.discriminator,
        p: nextPage,
        o: nextOffset,
      });
    for (let fetches = 0; fetches < MAX_UPSTREAM_FETCHES; fetches += 1) {
      const result = await this.#run(["api", options.pathFor(page)], options.signal);
      if (result.kind !== "ok") return result;
      const items =
        options.extractItems === undefined
          ? extractRestListItems(result.stdout)
          : options.extractItems(result.stdout);
      if (items === undefined || items.length > UPSTREAM_PAGE_SIZE) {
        return { kind: "unavailable" };
      }
      const decoded: Row[] = [];
      for (const item of items) {
        const row = options.decodeItem(item);
        if (row === undefined) return { kind: "unavailable" };
        if (row !== "skip") decoded.push(row);
      }
      const matched = decoded.filter((row) => options.matches(row));
      const taking = matched.slice(offset, offset + options.pageSize - rows.length);
      rows.push(...taking);
      const consumedInPage = offset + taking.length;
      const upstreamExhausted = items.length < UPSTREAM_PAGE_SIZE;
      if (rows.length >= options.pageSize) {
        if (consumedInPage < matched.length) {
          return ok(rows, true, cursorAt(page, consumedInPage));
        }
        if (upstreamExhausted) return ok(rows, false);
        return ok(rows, true, cursorAt(page + 1, 0));
      }
      if (upstreamExhausted) return ok(rows, false);
      page += 1;
      offset = 0;
    }
    // The fetch budget for this request is spent; the caller resumes from an
    // exact position instead of Octant walking GitHub unboundedly.
    return ok(rows, true, cursorAt(page, offset));
  }

  async #run(
    arguments_: readonly string[],
    signal: AbortSignal,
  ): Promise<
    { readonly kind: "ok"; readonly stdout: string; readonly stderr?: string } | GhCatalogueFailure
  > {
    let result: { readonly exitCode: number; readonly stdout: string; readonly stderr?: string };
    try {
      result = await this.#command.run(
        arguments_,
        { environment: sanitizedEnvironment(this.#inheritedEnvironment) },
        signal,
      );
    } catch {
      return { kind: "unavailable" };
    }
    if (
      Buffer.byteLength(result.stdout, "utf8") > MAX_OUTPUT_BYTES ||
      Buffer.byteLength(result.stderr ?? "", "utf8") > MAX_OUTPUT_BYTES
    ) {
      return { kind: "unavailable" };
    }
    if (result.exitCode !== 0) return classifyFailure(result);
    return {
      kind: "ok",
      stdout: result.stdout,
      ...(result.stderr === undefined ? {} : { stderr: result.stderr }),
    };
  }
}

export function createGhCatalogueCommandPort(
  ghExecutable: string | undefined,
): GhCatalogueCommandPort {
  if (ghExecutable === undefined || !resolvedExecutableIsUsable(ghExecutable)) {
    return {
      run: async () => {
        throw new Error("gh-cli-unavailable");
      },
    };
  }
  const lifecycle = new AbortController();
  const ownedChildren = new Set<ReturnType<typeof spawn>>();
  return {
    run: (arguments_, options, signal) =>
      new Promise((resolve, reject) => {
        if (signal.aborted || lifecycle.signal.aborted) {
          reject(new Error("operation-aborted"));
          return;
        }
        const deadline = new AbortController();
        const abortForParent = () => deadline.abort(signal.reason);
        const abortForLifecycle = () => deadline.abort(lifecycle.signal.reason);
        signal.addEventListener("abort", abortForParent, { once: true });
        lifecycle.signal.addEventListener("abort", abortForLifecycle, { once: true });
        const timeout = setTimeout(
          () => deadline.abort(new Error("github-read-deadline-exceeded")),
          READ_TIMEOUT_MS,
        );
        const child = spawn(ghExecutable, [...arguments_], {
          env: options.environment,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          signal: deadline.signal,
          detached: process.platform !== "win32",
          windowsHide: true,
        });
        ownedChildren.add(child);
        let stdout = "";
        let stderr = "";
        let overflow = false;
        const terminate = () => terminateProcessTree(child);
        deadline.signal.addEventListener("abort", terminate, { once: true });
        const cleanup = () => {
          clearTimeout(timeout);
          signal.removeEventListener("abort", abortForParent);
          lifecycle.signal.removeEventListener("abort", abortForLifecycle);
          deadline.signal.removeEventListener("abort", terminate);
          ownedChildren.delete(child);
        };
        child.stdout.on("data", (chunk: Buffer) => {
          if (overflow) return;
          if (Buffer.byteLength(stdout, "utf8") + chunk.byteLength > MAX_OUTPUT_BYTES) {
            overflow = true;
            terminate();
            return;
          }
          stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk: Buffer) => {
          if (Buffer.byteLength(stderr, "utf8") <= MAX_OUTPUT_BYTES)
            stderr += chunk.toString("utf8");
        });
        child.once("error", (error) => {
          cleanup();
          reject(error);
        });
        child.once("close", (code) => {
          cleanup();
          if (overflow) {
            reject(new Error("github-read-output-overflow"));
            return;
          }
          resolve({ exitCode: code ?? 1, stdout, stderr });
        });
      }),
    close: () => {
      lifecycle.abort(new Error("server-shutdown"));
      for (const child of ownedChildren) terminateProcessTree(child);
    },
  };
}

function ok<Row>(
  rows: readonly Row[],
  hasNextPage: boolean,
  endCursor?: string,
): GhCatalogueResult<GhCataloguePageObservation<Row>> {
  return {
    kind: "ok",
    value: { rows, hasNextPage, ...(endCursor === undefined ? {} : { endCursor }) },
  };
}

function decodeRepositoryItem(item: unknown): GhRepositoryObservationRow | "skip" | undefined {
  if (!isRecord(item)) return undefined;
  const owner = isRecord(item.owner) ? item.owner.login : undefined;
  if (
    typeof item.node_id !== "string" ||
    !NODE_ID_PATTERN.test(item.node_id) ||
    typeof owner !== "string" ||
    !OWNER_PATTERN.test(owner) ||
    typeof item.name !== "string" ||
    !NAME_PATTERN.test(item.name)
  ) {
    return undefined;
  }
  const visibility = item.visibility;
  if (visibility !== "public" && visibility !== "private" && visibility !== "internal") {
    return undefined;
  }
  const defaultBranch =
    typeof item.default_branch === "string" && isValidBranch(item.default_branch)
      ? item.default_branch
      : undefined;
  return {
    nodeId: item.node_id,
    owner,
    name: item.name,
    visibility,
    ...(defaultBranch === undefined ? {} : { defaultBranch }),
    viewerPermission: viewerPermission(item.permissions),
  };
}

function decodeIssueItem(item: unknown): GhIssueObservationRow | "skip" | undefined {
  if (!isRecord(item)) return undefined;
  // The Issues REST collection interleaves pull requests; they are served
  // through the dedicated pull-request read instead.
  if (item.pull_request !== undefined) return "skip";
  const shared = decodeSharedItemFacts(item);
  if (shared === undefined) return undefined;
  if (item.state !== "open" && item.state !== "closed") return undefined;
  return { ...shared, state: item.state };
}

function decodeIssueDetail(stdout: string): Omit<GhIssueDetailObservation, "comments"> | undefined {
  const item = tryParseJson(stdout);
  if (!isRecord(item) || item.pull_request !== undefined) return undefined;
  const shared = decodeSharedItemFacts(item);
  if (shared === undefined) return undefined;
  if (item.state !== "open" && item.state !== "closed") return undefined;
  if (typeof item.created_at !== "string" || !ISO_PATTERN.test(item.created_at)) return undefined;
  const body = boundUtf8(item.body, ISSUE_BODY_MAX_BYTES);
  return {
    ...shared,
    state: item.state,
    createdAt: item.created_at,
    labels: decodeLabels(item.labels),
    body: body.text,
    bodyTruncated: body.truncated,
  };
}

function decodeIssueComment(item: unknown): GhIssueCommentObservation | undefined {
  if (!isRecord(item)) return undefined;
  if (typeof item.created_at !== "string" || !ISO_PATTERN.test(item.created_at)) return undefined;
  const author = isRecord(item.user) && typeof item.user.login === "string" ? item.user.login : "";
  const body = boundUtf8(item.body, COMMENT_BODY_MAX_BYTES);
  return {
    author: normalizeText(author, 128, "unknown"),
    createdAt: item.created_at,
    body: body.text,
    truncated: body.truncated,
  };
}

function decodeLabels(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const labels: string[] = [];
  for (const item of value) {
    if (labels.length >= MAX_ISSUE_LABELS) break;
    const name = isRecord(item) && typeof item.name === "string" ? item.name : undefined;
    if (name === undefined) continue;
    const normalized = normalizeText(name, LABEL_MAX_CHARS, "");
    if (normalized.length === 0) continue;
    labels.push(normalized);
  }
  return labels;
}

function extractRestListItems(stdout: string): readonly unknown[] | undefined {
  const parsed = tryParseJson(stdout);
  return Array.isArray(parsed) ? parsed : undefined;
}

function extractSearchIssueItems(stdout: string): readonly unknown[] | undefined {
  const parsed = tryParseJson(stdout);
  if (!isRecord(parsed) || !Array.isArray(parsed.items)) return undefined;
  return parsed.items;
}

const AUTHOR_SEARCH_TERM = /^author:([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})$/i;
const NUMBER_SEARCH_TERM = /^#([1-9][0-9]{0,8})$/;

/**
 * Compose the GitHub search query from bounded client terms. Unknown
 * `qualifier:` tokens are dropped so the client can never inject repo,
 * type, or other search syntax.
 */
function composeIssueSearchQuery(input: {
  readonly owner: string;
  readonly name: string;
  readonly state: "open" | "closed" | "all";
  readonly search: string;
  readonly unassigned: boolean;
}): string | undefined {
  const authors: string[] = [];
  const numbers: string[] = [];
  const titleParts: string[] = [];
  for (const token of input.search.trim().split(/\s+/)) {
    if (token.length === 0) continue;
    const author = AUTHOR_SEARCH_TERM.exec(token);
    if (author !== null && author[1] !== undefined) {
      authors.push(author[1]);
      continue;
    }
    const numbered = NUMBER_SEARCH_TERM.exec(token);
    if (numbered !== null && numbered[1] !== undefined) {
      numbers.push(numbered[1]);
      continue;
    }
    if (token.includes(":")) continue;
    const cleaned = token.replaceAll(/["\\]/g, "");
    if (cleaned.length > 0) titleParts.push(cleaned);
  }
  if (authors.length === 0 && numbers.length === 0 && titleParts.length === 0) {
    return undefined;
  }
  const prefix = [`repo:${input.owner}/${input.name}`, "type:issue"];
  if (input.state === "open") prefix.push("is:open");
  if (input.state === "closed") prefix.push("is:closed");
  // Search has its own vocabulary for the REST `assignee=none` filter, so a
  // narrowed read stays narrowed when the caller also passes a search term.
  if (input.unassigned) prefix.push("no:assignee");
  const userTerms: string[] = [];
  for (const author of authors) userTerms.push(`author:${author}`);
  for (const number of numbers) userTerms.push(number);
  if (titleParts.length > 0) {
    userTerms.push(`"${titleParts.join(" ")}"`, "in:title");
  }
  const parts = [...prefix];
  let addedUserTerm = false;
  for (const term of userTerms) {
    const candidate = `${parts.join(" ")} ${term}`;
    if (candidate.length > MAX_SEARCH_QUERY_CHARS) break;
    parts.push(term);
    addedUserTerm = true;
  }
  if (!addedUserTerm) return undefined;
  return parts.join(" ");
}

const SEARCH_REPOSITORY_URL_PATTERN =
  /^https:\/\/api\.github\.com\/repos\/([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})\/((?!\.{1,2}$)[A-Za-z0-9_.-]{1,100})$/;

function decodeAssignedWorkItem(
  item: unknown,
  category: "issue" | "pull-request" | "review-request",
): GhAssignedWorkObservationItem | "skip" | undefined {
  if (!isRecord(item)) return undefined;
  const shared = decodeSharedItemFacts(item);
  if (shared === undefined) return undefined;
  const repository =
    typeof item.repository_url === "string"
      ? SEARCH_REPOSITORY_URL_PATTERN.exec(item.repository_url)
      : null;
  const owner = repository?.[1];
  const name = repository?.[2];
  if (owner === undefined || name === undefined) return undefined;
  return { category, owner, name, ...shared };
}

function decodePullRequestItem(item: unknown): GhPullRequestObservationRow | "skip" | undefined {
  if (!isRecord(item)) return undefined;
  const shared = decodeSharedItemFacts(item);
  if (shared === undefined) return undefined;
  if (item.state !== "open" && item.state !== "closed") return undefined;
  const state =
    typeof item.merged_at === "string"
      ? ("merged" as const)
      : item.state === "closed"
        ? ("closed" as const)
        : item.draft === true
          ? ("draft" as const)
          : ("open" as const);
  const baseBranch = branchOf(item.base);
  const headBranch = branchOf(item.head);
  return {
    ...shared,
    state,
    ...(baseBranch === undefined ? {} : { baseBranch }),
    ...(headBranch === undefined ? {} : { headBranch }),
  };
}

function decodeSharedItemFacts(item: Record<string, unknown>):
  | {
      readonly number: number;
      readonly title: string;
      readonly author: string;
      readonly updatedAt: string;
      readonly url: string;
    }
  | undefined {
  if (
    typeof item.number !== "number" ||
    !Number.isSafeInteger(item.number) ||
    item.number <= 0 ||
    typeof item.updated_at !== "string" ||
    !ISO_PATTERN.test(item.updated_at) ||
    typeof item.html_url !== "string" ||
    item.html_url.length > 512 ||
    !GITHUB_URL_PATTERN.test(item.html_url)
  ) {
    return undefined;
  }
  const author = isRecord(item.user) && typeof item.user.login === "string" ? item.user.login : "";
  return {
    number: item.number,
    title: normalizeText(item.title, 256, "(untitled)"),
    author: normalizeText(author, 128, "unknown"),
    updatedAt: item.updated_at,
    url: item.html_url,
  };
}

function decodeProjectsPage(
  stdout: string,
  repository: string,
): GhCatalogueResult<GhCataloguePageObservation<GhProjectObservationRow>> {
  const parsed = tryParseJson(stdout);
  if (!isRecord(parsed)) return { kind: "unavailable" };
  if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
    return classifyGraphqlErrors(parsed.errors);
  }
  const data = parsed.data;
  if (!isRecord(data)) return { kind: "unavailable" };
  if (data.repository === null) {
    return { kind: "scope-limited", remediation: "repository-access-or-scope-required" };
  }
  if (!isRecord(data.repository) || !isRecord(data.repository.projectsV2)) {
    return { kind: "unavailable" };
  }
  const collection = data.repository.projectsV2;
  if (!Array.isArray(collection.nodes) || !isRecord(collection.pageInfo)) {
    return { kind: "unavailable" };
  }
  const rows: GhProjectObservationRow[] = [];
  for (const node of collection.nodes) {
    if (
      !isRecord(node) ||
      typeof node.number !== "number" ||
      !Number.isSafeInteger(node.number) ||
      node.number <= 0 ||
      typeof node.closed !== "boolean" ||
      typeof node.updatedAt !== "string" ||
      !ISO_PATTERN.test(node.updatedAt) ||
      typeof node.url !== "string" ||
      node.url.length > 512 ||
      !GITHUB_URL_PATTERN.test(node.url)
    ) {
      return { kind: "unavailable" };
    }
    rows.push({
      number: node.number,
      title: normalizeText(node.title, 256, "(untitled)"),
      closed: node.closed,
      updatedAt: node.updatedAt,
      url: node.url,
    });
  }
  const hasNextPage = collection.pageInfo.hasNextPage === true;
  const upstreamCursor = collection.pageInfo.endCursor;
  const endCursor =
    hasNextPage && typeof upstreamCursor === "string" && upstreamCursor.length <= 256
      ? encodeCursor({ v: 1, k: "projects", d: repository, a: upstreamCursor })
      : undefined;
  return {
    kind: "ok",
    value: {
      rows,
      hasNextPage: endCursor !== undefined,
      ...(endCursor === undefined ? {} : { endCursor }),
    },
  };
}

function classifyGraphqlErrors(errors: readonly unknown[]): GhCatalogueFailure {
  const types = errors
    .map((error) => (isRecord(error) && typeof error.type === "string" ? error.type : ""))
    .map((type) => type.toUpperCase());
  const messages = errors
    .map((error) => (isRecord(error) && typeof error.message === "string" ? error.message : ""))
    .join("\n");
  if (types.includes("RATE_LIMITED") || /rate limit/i.test(messages)) {
    return { kind: "rate-limited" };
  }
  if (
    types.includes("INSUFFICIENT_SCOPES") ||
    types.includes("FORBIDDEN") ||
    types.includes("NOT_FOUND") ||
    /scope|saml|sso|permission/i.test(messages)
  ) {
    return { kind: "scope-limited", remediation: "scope-or-authorization-required" };
  }
  return { kind: "unavailable" };
}

function classifyFailure(result: {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr?: string;
}): GhCatalogueFailure {
  const diagnostic = `${result.stderr ?? ""}\n${result.stdout}`;
  if (/rate limit/i.test(diagnostic)) {
    const retryAfter = /retry.after[:\s]+(\d{1,6})/i.exec(diagnostic)?.[1];
    return {
      kind: "rate-limited",
      ...(retryAfter === undefined ? {} : { retryAfterSeconds: Number(retryAfter) }),
    };
  }
  if (/HTTP 401|bad credentials|authentication required|not logged in/i.test(diagnostic)) {
    return { kind: "unauthorized" };
  }
  if (/saml|sso/i.test(diagnostic)) {
    return { kind: "scope-limited", remediation: "sso-authorization-required" };
  }
  if (/HTTP 403|HTTP 404|insufficient_scopes|missing.*scope|read:project/i.test(diagnostic)) {
    return { kind: "scope-limited", remediation: "repository-access-or-scope-required" };
  }
  return { kind: "unavailable" };
}

function viewerPermission(permissions: unknown): GhRepositoryObservationRow["viewerPermission"] {
  if (!isRecord(permissions)) return "none";
  if (permissions.admin === true) return "admin";
  if (permissions.maintain === true) return "maintain";
  if (permissions.push === true) return "write";
  if (permissions.triage === true) return "triage";
  if (permissions.pull === true) return "read";
  return "none";
}

function validatedRepositoryPath(owner: string, name: string): string | undefined {
  if (!OWNER_PATTERN.test(owner) || !NAME_PATTERN.test(name)) return undefined;
  return `${owner}/${name}`;
}

/**
 * GitHub-controlled display text is attacker-influenced. Strip control
 * characters, redact anything credential-shaped, and clamp before it can
 * reach contracts, events, or providers.
 */
function redactText(value: string): string {
  // oxlint-disable-next-line no-control-regex
  let normalized = value.replaceAll(/[\u0000-\u001f\u007f]/g, " ");
  for (let pass = 0; pass < 5 && SECRETISH.test(normalized); pass += 1) {
    normalized = normalized.replaceAll(SECRETISH, "[redacted]");
  }
  return normalized;
}

function normalizeText(value: unknown, limit: number, fallback: string): string {
  if (typeof value !== "string") return fallback;
  let normalized = redactText(value).trim();
  if (normalized.length > limit) normalized = normalized.slice(0, limit).trim();
  return normalized.length === 0 ? fallback : normalized;
}

function boundUtf8(
  value: unknown,
  maxBytes: number,
): { readonly text: string; readonly truncated: boolean } {
  if (typeof value !== "string") return { text: "", truncated: false };
  const redacted = redactText(value);
  const encoded = Buffer.from(redacted, "utf8");
  if (encoded.byteLength <= maxBytes) {
    return { text: redacted.trim(), truncated: false };
  }
  let end = maxBytes;
  while (end > 0 && ((encoded[end] ?? 0) & 0b1100_0000) === 0b1000_0000) {
    end -= 1;
  }
  return { text: encoded.subarray(0, end).toString("utf8").trim(), truncated: true };
}

function isValidBranch(value: string): boolean {
  return value.length > 0 && value.length <= 255 && !/\s/.test(value) && !value.includes("..");
}

function branchOf(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.ref !== "string" || !isValidBranch(value.ref)) {
    return undefined;
  }
  return value.ref;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): CursorPayload | undefined {
  if (cursor.length > 600 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.v !== 1 || typeof parsed.k !== "string") return undefined;
  if (typeof parsed.d !== "string") return undefined;
  return parsed as unknown as CursorPayload;
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function resolvedExecutableIsUsable(path: string): boolean {
  if (!isAbsolute(path)) return false;
  try {
    const metadata = statSync(path);
    if (!metadata.isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function terminateProcessTree(child: ReturnType<typeof spawn>): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    void spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}
