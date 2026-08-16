import { sanitizedEnvironment } from "./ghAuthenticationPort";
import {
  createGhCatalogueCommandPort,
  type GhCatalogueCommandPort,
} from "./ghRepositoryCataloguePort";
import type {
  ManagedCloneObservationPort,
  ManagedCloneRepositoryObservation,
} from "./managedCloneService";

const MAX_OUTPUT_BYTES = 256 * 1024;
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const NAME_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/;
const NODE_ID_PATTERN = /^[A-Za-z0-9+/=_-]{1,128}$/;
const BRANCH_PATTERN = /^(?!.*\.\.)[^\s\0~^:?*[\\]{1,255}$/;

/**
 * The only surface through which the managed-clone workflow reads one
 * repository's live identity. Every read is a fixed, non-mutating
 * `gh api repos/<owner>/<name>` against github.com with a sanitized
 * environment; results are strictly normalized and never cached, so a
 * successful observation is fresh by construction.
 */
export class GhRepositoryObservationPort implements ManagedCloneObservationPort {
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

  async observeRepository(
    identity: { readonly owner: string; readonly name: string },
    signal: AbortSignal,
  ): Promise<ManagedCloneRepositoryObservation> {
    if (!OWNER_PATTERN.test(identity.owner) || !NAME_PATTERN.test(identity.name)) {
      return { kind: "unavailable" };
    }
    let result: { readonly exitCode: number; readonly stdout: string; readonly stderr?: string };
    try {
      result = await this.#command.run(
        ["api", `repos/${identity.owner}/${identity.name}`],
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
    if (result.exitCode !== 0) {
      return { kind: classifyObservationFailure(`${result.stdout}\n${result.stderr ?? ""}`) };
    }
    return decodeRepository(result.stdout);
  }
}

function classifyObservationFailure(
  diagnostic: string,
): "not-found" | "unauthorized" | "unavailable" {
  if (/http 404|not found|could not resolve to a repository/i.test(diagnostic)) {
    return "not-found";
  }
  if (
    /http 401|http 403|bad credentials|authentication|not logged in|push access|sso|token/i.test(
      diagnostic,
    )
  ) {
    return "unauthorized";
  }
  return "unavailable";
}

function decodeRepository(stdout: string): ManagedCloneRepositoryObservation {
  let root: unknown;
  try {
    root = JSON.parse(stdout);
  } catch {
    return { kind: "unavailable" };
  }
  if (!isRecord(root) || !isRecord(root.owner)) return { kind: "unavailable" };
  const nodeId = root.node_id;
  const name = root.name;
  const login = root.owner.login;
  const visibility = root.visibility;
  const defaultBranch = root.default_branch;
  if (
    typeof nodeId !== "string" ||
    !NODE_ID_PATTERN.test(nodeId) ||
    typeof name !== "string" ||
    !NAME_PATTERN.test(name) ||
    typeof login !== "string" ||
    !OWNER_PATTERN.test(login) ||
    (visibility !== "public" && visibility !== "private" && visibility !== "internal") ||
    (defaultBranch !== undefined &&
      (typeof defaultBranch !== "string" || !BRANCH_PATTERN.test(defaultBranch)))
  ) {
    return { kind: "unavailable" };
  }
  return {
    kind: "observed",
    repository: {
      nodeId,
      owner: login,
      name,
      visibility,
      ...(defaultBranch === undefined ? {} : { defaultBranch }),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
