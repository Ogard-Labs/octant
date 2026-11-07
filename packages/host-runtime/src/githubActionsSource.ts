import { GITHUB_MCP_OAUTH_APP } from "./githubMcpOAuth";

export interface GithubActionsSourceOwner {
  readonly credentialRef: string;
  readonly clientId: string;
  readonly secretRef: string;
  readonly accountId: string;
}
export interface GithubActionsRepository {
  readonly id: number;
  readonly nodeId: string;
  readonly owner: string;
  readonly name: string;
}
export type GithubActionsSourceRead = GithubActionsSourceOwner &
  (
    | { readonly kind: "repository"; readonly owner: string; readonly name: string }
    | {
        readonly kind: "runs";
        readonly repository: GithubActionsRepository;
        readonly page: number;
        readonly workflowId?: number;
        readonly branch?: string;
      }
  );
export interface GithubActionsCompletedRun {
  readonly id: number;
  readonly attempt: number;
  readonly workflowId: number;
  readonly headSha: string;
  readonly branch?: string;
  readonly conclusion: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly url: string;
}
export type GithubActionsSourceResult =
  | {
      readonly kind: "repository";
      readonly accountId: string;
      readonly repository: GithubActionsRepository;
    }
  | {
      readonly kind: "page";
      readonly accountId: string;
      readonly repository: GithubActionsRepository;
      readonly runs: ReadonlyArray<GithubActionsCompletedRun>;
      readonly totalCount: number;
      readonly nextPage?: number;
    }
  | {
      readonly kind: "refused";
      readonly reason:
        | "invalid-request"
        | "connection-unavailable"
        | "account-changed"
        | "repository-changed"
        | "permission-denied"
        | "rate-limited"
        | "source-unavailable";
      readonly retryAfterSeconds?: number;
    };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const NAME = /^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/;
const NODE = /^[A-Za-z0-9+/=_-]{1,256}$/;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const ID = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const text = (value: unknown, limit: number): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= limit &&
  ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const timestamp = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value));

function repository(value: unknown): GithubActionsRepository | undefined {
  if (
    !object(value) ||
    !ID(value.id) ||
    typeof value.nodeId !== "string" ||
    !NODE.test(value.nodeId) ||
    typeof value.owner !== "string" ||
    !OWNER.test(value.owner) ||
    typeof value.name !== "string" ||
    !NAME.test(value.name) ||
    !keys(value, ["id", "nodeId", "owner", "name"])
  )
    return undefined;
  return { id: value.id, nodeId: value.nodeId, owner: value.owner, name: value.name };
}

/** The private broker wire accepts ownership assertions, never URLs, headers or a token. */
export function decodeGithubActionsSourceRead(value: unknown): GithubActionsSourceRead | undefined {
  if (
    !object(value) ||
    typeof value.credentialRef !== "string" ||
    !UUID.test(value.credentialRef) ||
    typeof value.secretRef !== "string" ||
    !UUID.test(value.secretRef) ||
    !text(value.clientId, 256) ||
    /[\s/?#]/.test(value.clientId) ||
    typeof value.accountId !== "string" ||
    !/^[1-9]\d{0,15}$/.test(value.accountId) ||
    !ID(Number(value.accountId))
  )
    return undefined;
  const owner = {
    credentialRef: value.credentialRef,
    clientId: value.clientId,
    secretRef: value.secretRef,
    accountId: value.accountId,
  };
  const common = ["credentialRef", "clientId", "secretRef", "accountId", "kind"];
  if (
    value.kind === "repository" &&
    typeof value.owner === "string" &&
    OWNER.test(value.owner) &&
    typeof value.name === "string" &&
    NAME.test(value.name) &&
    keys(value, [...common, "owner", "name"])
  )
    return { ...owner, kind: "repository", owner: value.owner, name: value.name };
  const selected = repository(value.repository);
  if (
    value.kind !== "runs" ||
    selected === undefined ||
    !ID(value.page) ||
    value.page > 5 ||
    (value.workflowId !== undefined && !ID(value.workflowId)) ||
    (value.branch !== undefined && !text(value.branch, 256)) ||
    !keys(value, [...common, "repository", "page", "workflowId", "branch"])
  )
    return undefined;
  return {
    ...owner,
    kind: "runs",
    repository: selected,
    page: value.page,
    ...(value.workflowId === undefined ? {} : { workflowId: value.workflowId }),
    ...(value.branch === undefined ? {} : { branch: value.branch }),
  };
}

function readRepository(body: unknown): GithubActionsRepository | undefined {
  if (!object(body) || !object(body.owner)) return undefined;
  return repository({
    id: body.id,
    nodeId: body.node_id,
    owner: body.owner.login,
    name: body.name,
  });
}

class ReadFailure extends Error {
  constructor(readonly result: Extract<GithubActionsSourceResult, { readonly kind: "refused" }>) {
    super(result.reason);
  }
}
function fail(
  reason: Extract<GithubActionsSourceResult, { readonly kind: "refused" }>["reason"],
): never {
  throw new ReadFailure({ kind: "refused", reason });
}
async function bodyJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (reader === undefined) return undefined;
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 2 * 1024 * 1024) fail("source-unavailable");
      chunks.push(chunk.value);
    }
    const all = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      all.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(all));
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

/** Broker-local metadata read. Token material never leaves this call. */
export async function readGithubActionsSource(input: {
  readonly request: GithubActionsSourceRead;
  readonly accessToken: string;
  readonly fetch: typeof fetch;
  readonly signal: AbortSignal;
  readonly current: () => Promise<boolean>;
  readonly now?: () => number;
}): Promise<GithubActionsSourceResult> {
  const request = input.request;
  const check = async () => {
    if (input.signal.aborted || !(await input.current()) || input.signal.aborted)
      fail("connection-unavailable");
  };
  const get = async (url: URL) => {
    await check();
    const response = await input.fetch(url, {
      method: "GET",
      redirect: "error",
      signal: input.signal,
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        accept: "application/vnd.github+json",
        "user-agent": GITHUB_MCP_OAUTH_APP.userAgent,
        "x-github-api-version": GITHUB_MCP_OAUTH_APP.apiVersion,
      },
    });
    await check();
    const retryAfter = response.headers.get("retry-after");
    const exhausted = response.headers.get("x-ratelimit-remaining")?.trim() === "0";
    if (
      response.status === 429 ||
      (response.status === 403 && (exhausted || retryAfter !== null))
    ) {
      const clock = input.now?.() ?? Date.now();
      const advertised =
        retryAfter === null
          ? Number.NaN
          : /^\d+$/.test(retryAfter)
            ? Number(retryAfter)
            : (Date.parse(retryAfter) - clock) / 1000;
      const resetHeader = response.headers.get("x-ratelimit-reset");
      const reset =
        resetHeader !== null && /^\d+$/.test(resetHeader)
          ? Number(resetHeader) - clock / 1000
          : Number.NaN;
      const seconds = Math.max(1, Math.ceil(Number.isFinite(advertised) ? advertised : reset));
      throw new ReadFailure({
        kind: "refused",
        reason: "rate-limited",
        ...(Number.isSafeInteger(seconds) && seconds <= 86400
          ? { retryAfterSeconds: seconds }
          : {}),
      });
    }
    if (response.status === 401 || response.status === 403 || response.status === 404)
      fail("permission-denied");
    if (response.status !== 200) fail("source-unavailable");
    const body = await bodyJson(response);
    await check();
    return { body, link: response.headers.get("link") };
  };
  try {
    const user = await get(new URL(GITHUB_MCP_OAUTH_APP.identityEndpoint));
    if (!object(user.body) || !ID(user.body.id)) fail("source-unavailable");
    if (String(user.body.id) !== request.accountId) fail("account-changed");
    const selected = request.kind === "repository" ? request : request.repository;
    const path = `/repos/${encodeURIComponent(selected.owner)}/${encodeURIComponent(selected.name)}`;
    const observed = readRepository((await get(new URL(path, "https://api.github.com"))).body);
    if (observed === undefined) fail("source-unavailable");
    if (
      observed.owner.toLowerCase() !== selected.owner.toLowerCase() ||
      observed.name.toLowerCase() !== selected.name.toLowerCase() ||
      (request.kind === "runs" &&
        (observed.id !== request.repository.id || observed.nodeId !== request.repository.nodeId))
    )
      fail("repository-changed");
    if (request.kind === "repository")
      return { kind: "repository", accountId: request.accountId, repository: observed };
    const url = new URL(`${path}/actions/runs`, "https://api.github.com");
    url.searchParams.set("status", "completed");
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(request.page));
    if (request.branch !== undefined) url.searchParams.set("branch", request.branch);
    const response = await get(url);
    if (
      !object(response.body) ||
      !Array.isArray(response.body.workflow_runs) ||
      response.body.workflow_runs.length > 100 ||
      typeof response.body.total_count !== "number" ||
      !Number.isSafeInteger(response.body.total_count) ||
      response.body.total_count < response.body.workflow_runs.length
    )
      fail("source-unavailable");
    const runs: GithubActionsCompletedRun[] = [];
    const seen = new Set<string>();
    for (const row of response.body.workflow_runs) {
      if (
        !object(row) ||
        !ID(row.id) ||
        !ID(row.run_attempt) ||
        !ID(row.workflow_id) ||
        row.status !== "completed" ||
        !text(row.conclusion, 64) ||
        !/^[a-z_]+$/.test(row.conclusion) ||
        typeof row.head_sha !== "string" ||
        !SHA.test(row.head_sha) ||
        (row.head_branch !== null &&
          row.head_branch !== undefined &&
          !text(row.head_branch, 256)) ||
        !timestamp(row.created_at) ||
        !timestamp(row.updated_at) ||
        !object(row.repository) ||
        row.repository.id !== observed.id ||
        row.repository.node_id !== observed.nodeId ||
        typeof row.html_url !== "string" ||
        row.html_url !==
          `https://github.com/${observed.owner}/${observed.name}/actions/runs/${row.id}` ||
        seen.has(`${row.id}:${row.run_attempt}`)
      )
        fail("source-unavailable");
      seen.add(`${row.id}:${row.run_attempt}`);
      if (request.workflowId !== undefined && row.workflow_id !== request.workflowId) continue;
      if (request.branch !== undefined && row.head_branch !== request.branch)
        fail("source-unavailable");
      runs.push({
        id: row.id,
        attempt: row.run_attempt,
        workflowId: row.workflow_id,
        headSha: row.head_sha,
        ...(typeof row.head_branch === "string" ? { branch: row.head_branch } : {}),
        conclusion: row.conclusion,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        url: row.html_url,
      });
    }
    let nextPage: number | undefined;
    if (response.link !== null)
      for (const link of response.link.split(",")) {
        const match = /^\s*<([^>]+)>;\s*rel="([a-z]+)"\s*$/.exec(link);
        if (match === null) fail("source-unavailable");
        if (match[2] !== "next") continue;
        const address = match[1];
        if (address === undefined) fail("source-unavailable");
        const next = new URL(address);
        const expected = new URL(url);
        expected.searchParams.set("page", String(request.page + 1));
        if (
          next.origin !== expected.origin ||
          next.pathname !== expected.pathname ||
          next.username ||
          next.password ||
          next.hash ||
          [...next.searchParams].length !== [...expected.searchParams].length ||
          [...expected.searchParams].some(
            ([key, value]) =>
              next.searchParams.getAll(key).length !== 1 || next.searchParams.get(key) !== value,
          )
        )
          fail("source-unavailable");
        nextPage = request.page + 1;
      }
    if (response.body.total_count > request.page * 100 && nextPage === undefined)
      fail("source-unavailable");
    await check();
    return {
      kind: "page",
      accountId: request.accountId,
      repository: observed,
      runs,
      totalCount: response.body.total_count,
      ...(nextPage === undefined ? {} : { nextPage }),
    };
  } catch (error) {
    return error instanceof ReadFailure
      ? error.result
      : { kind: "refused", reason: "source-unavailable" };
  }
}

/** Strict result decoding prevents a broker/transport response from exposing extra fields. */
export function decodeGithubActionsSourceResult(
  value: unknown,
): GithubActionsSourceResult | undefined {
  if (!object(value)) return undefined;
  if (value.kind === "refused") {
    const reasons = [
      "invalid-request",
      "connection-unavailable",
      "account-changed",
      "repository-changed",
      "permission-denied",
      "rate-limited",
      "source-unavailable",
    ] as const;
    const reason = reasons.find((candidate) => candidate === value.reason);
    if (
      reason === undefined ||
      !keys(value, ["kind", "reason", "retryAfterSeconds"]) ||
      (value.retryAfterSeconds !== undefined &&
        (!ID(value.retryAfterSeconds) || value.retryAfterSeconds > 86400))
    )
      return undefined;
    return {
      kind: "refused",
      reason,
      ...(value.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: value.retryAfterSeconds }),
    };
  }
  const selected = repository(value.repository);
  if (
    selected === undefined ||
    typeof value.accountId !== "string" ||
    !/^[1-9]\d{0,15}$/.test(value.accountId) ||
    !ID(Number(value.accountId))
  )
    return undefined;
  if (value.kind === "repository" && keys(value, ["kind", "accountId", "repository"]))
    return { kind: "repository", accountId: value.accountId, repository: selected };
  if (
    value.kind !== "page" ||
    !keys(value, ["kind", "accountId", "repository", "runs", "totalCount", "nextPage"]) ||
    !Array.isArray(value.runs) ||
    value.runs.length > 100 ||
    typeof value.totalCount !== "number" ||
    !Number.isSafeInteger(value.totalCount) ||
    value.totalCount < value.runs.length ||
    (value.nextPage !== undefined && (!ID(value.nextPage) || value.nextPage > 6))
  )
    return undefined;
  const runs: GithubActionsCompletedRun[] = [];
  for (const row of value.runs) {
    if (
      !object(row) ||
      !keys(row, [
        "id",
        "attempt",
        "workflowId",
        "headSha",
        "branch",
        "conclusion",
        "createdAt",
        "updatedAt",
        "url",
      ]) ||
      !ID(row.id) ||
      !ID(row.attempt) ||
      !ID(row.workflowId) ||
      typeof row.headSha !== "string" ||
      !SHA.test(row.headSha) ||
      (row.branch !== undefined && !text(row.branch, 256)) ||
      !text(row.conclusion, 64) ||
      !/^[a-z_]+$/.test(row.conclusion) ||
      !timestamp(row.createdAt) ||
      !timestamp(row.updatedAt) ||
      typeof row.url !== "string" ||
      row.url !== `https://github.com/${selected.owner}/${selected.name}/actions/runs/${row.id}`
    )
      return undefined;
    runs.push({
      id: row.id,
      attempt: row.attempt,
      workflowId: row.workflowId,
      headSha: row.headSha,
      ...(row.branch === undefined ? {} : { branch: row.branch }),
      conclusion: row.conclusion,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      url: row.url,
    });
  }
  return {
    kind: "page",
    accountId: value.accountId,
    repository: selected,
    runs,
    totalCount: value.totalCount,
    ...(value.nextPage === undefined ? {} : { nextPage: value.nextPage }),
  };
}
