import type {
  CodeThread,
  GithubAuthenticationSnapshot,
  GithubCatalogueReadRequest,
  GithubCatalogueReadResponse,
  WindowId,
} from "@octant/contracts";
import {
  decideGithubAgentRead,
  decideProfileToolConstraint,
  isToolAllowedByAllowlist,
  type GithubAgentReadOperation,
} from "@octant/domain";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";

const MAX_TOOL_INPUT_BYTES = 4 * 1024;
/** Agent pages stay small; providers iterate with cursors instead. */
const MAX_AGENT_PAGE_SIZE = 30;
const DEFAULT_AGENT_PAGE_SIZE = 20;
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const NAME_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/;

export const GITHUB_READ_TOOL_NAME = "octant_github";

const githubReadDefinition = {
  name: GITHUB_READ_TOOL_NAME,
  inputSchema: {
    type: "object",
    properties: {
      operation: { type: "string", enum: ["issues", "pull-requests", "projects"] },
      pageSize: { type: "number" },
      cursor: { type: "string" },
      state: { type: "string", enum: ["open", "closed", "all"] },
    },
    required: ["operation"],
  },
} as const;

interface CatalogueReadPort {
  read(
    request: GithubCatalogueReadRequest,
    signal: AbortSignal,
  ): Promise<GithubCatalogueReadResponse>;
}

export interface GithubReadToolContext {
  readonly windowId: WindowId;
  readonly thread: CodeThread;
  readonly readThread: (windowId: WindowId, threadId: CodeThread["id"]) => CodeThread | undefined;
}

/**
 * App-managed, read-only GitHub tools for Code agents. The server fixes the
 * repository to the current Code Project's confirmed delivery repository and
 * reauthorizes host, thread, and capability state on every call. Agents can
 * never enumerate repositories, change hosts, pick endpoints, or mutate.
 */
export class GithubReadToolService {
  readonly #catalogue: CatalogueReadPort;
  readonly #snapshot: (signal: AbortSignal) => Promise<GithubAuthenticationSnapshot>;

  constructor(options: {
    readonly catalogue: CatalogueReadPort;
    readonly snapshot: (signal: AbortSignal) => Promise<GithubAuthenticationSnapshot>;
  }) {
    this.#catalogue = options.catalogue;
    this.#snapshot = options.snapshot;
  }

  createToolSet(context: GithubReadToolContext): AppManagedToolSet {
    const allowlist = context.thread.toolConstraints ?? [];
    return {
      definitions: isToolAllowedByAllowlist(allowlist, GITHUB_READ_TOOL_NAME)
        ? [githubReadDefinition]
        : [],
      execute: async ({ name, inputJson, signal }) => {
        if (signal?.aborted) return failure("tool-interrupted");
        if (name !== GITHUB_READ_TOOL_NAME) return failure("tool-unavailable");
        // Identity first: a stale binding must not surface as a profile
        // refusal, and malformed input must not beat either check.
        const current = context.readThread(context.windowId, context.thread.id);
        if (threadAuthority(context.thread, current) === "stale") {
          return failure("thread-stale");
        }
        const profileConstraint = decideProfileToolConstraint({
          toolId: GITHUB_READ_TOOL_NAME,
          toolConstraints: context.thread.toolConstraints ?? [],
          profileDisplayName: context.thread.profileDisplayName ?? "the bound profile",
        });
        if (profileConstraint.status === "refused") {
          return failure("profile-tool-refused", profileConstraint.reason);
        }
        const input = parseGithubReadInput(inputJson);
        if (input === undefined) return failure("invalid-github-input");
        const snapshot = await this.#snapshot(signal ?? new AbortController().signal);
        const decision = decideGithubAgentRead({
          operation: operationCapability(input.operation),
          mode: "code",
          threadLifecycle: current?.lifecycle ?? "missing",
          threadAuthority: threadAuthority(context.thread, current),
          projectRepository: boundRepository(current ?? context.thread),
          snapshot,
          snapshotFreshness: "fresh",
          providerToolPolicy: "allowed",
        });
        if (decision.decision === "deny") {
          return failure(decision.code, decision.remediation);
        }
        const request: GithubCatalogueReadRequest = {
          kind: input.operation,
          owner: decision.repository.owner,
          name: decision.repository.name,
          pageSize: clampPageSize(input.pageSize),
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(input.operation === "projects" || input.state === undefined
            ? {}
            : { state: input.state }),
        } as GithubCatalogueReadRequest;
        const response = await this.#catalogue.read(
          request,
          signal ?? new AbortController().signal,
        );
        if (response.kind === "unavailable") {
          return {
            result: {
              error: response.reason,
              ...(response.remediation === undefined ? {} : { message: response.remediation }),
              ...(response.retryAfterSeconds === undefined
                ? {}
                : { retryAfterSeconds: response.retryAfterSeconds }),
            },
            isError: true,
          };
        }
        if (
          response.kind === "recent-repositories" ||
          response.kind === "repositories" ||
          response.kind === "issue"
        ) {
          return failure("tool-unavailable");
        }
        return {
          result: {
            operation: input.operation,
            repository: `${decision.repository.owner}/${decision.repository.name}`,
            page: response.page,
          },
          isError: false,
        };
      },
    };
  }
}

type GithubReadToolInput = {
  readonly operation: "issues" | "pull-requests" | "projects";
  readonly pageSize?: number;
  readonly cursor?: string;
  readonly state?: "open" | "closed" | "all";
};

function parseGithubReadInput(value: string): GithubReadToolInput | undefined {
  if (Buffer.byteLength(value, "utf8") > MAX_TOOL_INPUT_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const allowed = new Set(["operation", "pageSize", "cursor", "state"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) return undefined;
  const operation = record.operation;
  if (operation !== "issues" && operation !== "pull-requests" && operation !== "projects") {
    return undefined;
  }
  if (
    record.pageSize !== undefined &&
    (typeof record.pageSize !== "number" ||
      !Number.isSafeInteger(record.pageSize) ||
      record.pageSize <= 0)
  ) {
    return undefined;
  }
  if (
    record.cursor !== undefined &&
    (typeof record.cursor !== "string" || !/^[A-Za-z0-9_-]{1,600}$/.test(record.cursor))
  ) {
    return undefined;
  }
  if (
    record.state !== undefined &&
    record.state !== "open" &&
    record.state !== "closed" &&
    record.state !== "all"
  ) {
    return undefined;
  }
  return {
    operation,
    ...(record.pageSize === undefined ? {} : { pageSize: record.pageSize }),
    ...(record.cursor === undefined ? {} : { cursor: record.cursor as string }),
    ...(record.state === undefined ? {} : { state: record.state }),
  };
}

function operationCapability(
  operation: "issues" | "pull-requests" | "projects",
): GithubAgentReadOperation {
  switch (operation) {
    case "issues":
      return "issues-read";
    case "pull-requests":
      return "pull-requests-read";
    case "projects":
      return "projects-read";
  }
}

function threadAuthority(
  started: CodeThread,
  current: CodeThread | undefined,
): "current" | "stale" {
  if (
    current === undefined ||
    current.id !== started.id ||
    current.checkoutId !== started.checkoutId ||
    current.projectId !== started.projectId ||
    current.repositoryId !== started.repositoryId ||
    current.providerInstanceId !== started.providerInstanceId ||
    current.modelId !== started.modelId ||
    current.bindingRevisionId !== started.bindingRevisionId
  ) {
    return "stale";
  }
  return "current";
}

function boundRepository(
  thread: CodeThread,
): { readonly owner: string; readonly name: string } | undefined {
  const parts = thread.deliveryTarget.proposedBaseRepository.split("/");
  if (parts.length !== 2) return undefined;
  const [owner, name] = parts as [string, string];
  if (!OWNER_PATTERN.test(owner) || !NAME_PATTERN.test(name)) return undefined;
  return { owner, name };
}

function clampPageSize(pageSize: number | undefined): number {
  if (pageSize === undefined) return DEFAULT_AGENT_PAGE_SIZE;
  return Math.min(Math.max(pageSize, 1), MAX_AGENT_PAGE_SIZE);
}

function failure(error: string, message?: string) {
  return { result: { error, ...(message === undefined ? {} : { message }) }, isError: true };
}
