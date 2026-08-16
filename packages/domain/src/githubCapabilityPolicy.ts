import type { GithubAuthenticationSnapshot } from "@octant/contracts";

export interface GithubAccountObservation {
  readonly login: string;
  readonly source: string;
  readonly scopes?: readonly string[];
  /** Reported by `gh auth status`; only HTTPS is safe for managed clone flows. */
  readonly gitProtocol?: string;
  /** Operation-level evidence collected by a host adapter, never inferred from scopes. */
  readonly operationProbes?: Partial<
    Record<"repository-catalogue" | "issues-read" | "pull-requests-read" | "projects-read", boolean>
  >;
}

export interface GithubAuthenticationInput {
  readonly externalToken?: boolean;
  readonly rateLimited?: boolean;
  readonly unavailable?: boolean;
  readonly accounts?: readonly GithubAccountObservation[];
}

const SECURE_SOURCES = new Set(["keyring", "keychain", "credential-store"]);
const INSECURE_SOURCES = new Set(["plaintext", "file", "config-file"]);

function isInsecureSource(source: string): boolean {
  return INSECURE_SOURCES.has(source) || /(?:^|[\\/])hosts\.ya?ml$/i.test(source);
}

/** Convert a narrow, token-free gh observation into honest capability state. */
export function classifyGithubAuthentication(
  input: GithubAuthenticationInput,
): GithubAuthenticationSnapshot {
  if (input.externalToken) return { state: "external-token", capabilities: [] };
  if (input.rateLimited) return { state: "rate-limited", capabilities: [] };
  if (input.unavailable) return { state: "unavailable", capabilities: [] };
  const accounts = input.accounts ?? [];
  if (accounts.length === 0) return { state: "unauthorized", capabilities: [] };
  if (accounts.length !== 1) return { state: "unavailable", capabilities: [] };
  const account = accounts[0]!;
  if (isInsecureSource(account.source)) return { state: "insecure-storage", capabilities: [] };
  if (!SECURE_SOURCES.has(account.source)) return { state: "unavailable", capabilities: [] };
  if (account.gitProtocol !== "https") return { state: "unavailable", capabilities: [] };
  const scopes = [...new Set(account.scopes ?? [])].sort();
  // OAuth scopes are only a maximum permission envelope. SSO, repository
  // policy, and disabled GitHub features can still reject the individual
  // operations, so no capability is advertised until its normalized probe
  // succeeds.
  const proven = account.operationProbes ?? {};
  const repositoryReadable = proven["repository-catalogue"] === true;
  const issuesReadable = proven["issues-read"] === true;
  const pullRequestsReadable = proven["pull-requests-read"] === true;
  const projectsReadable = proven["projects-read"] === true;
  const capabilities = [
    {
      kind: "repository-catalogue" as const,
      available: repositoryReadable,
      ...(repositoryReadable ? {} : { remediation: "operation-probe-required" }),
    },
    {
      kind: "issues-read" as const,
      available: issuesReadable,
      ...(issuesReadable ? {} : { remediation: "operation-probe-required" }),
    },
    {
      kind: "pull-requests-read" as const,
      available: pullRequestsReadable,
      ...(pullRequestsReadable ? {} : { remediation: "operation-probe-required" }),
    },
    {
      kind: "projects-read" as const,
      available: projectsReadable,
      ...(projectsReadable ? {} : { remediation: "operation-probe-required" }),
    },
  ];
  return {
    state: capabilities.some((capability) => !capability.available) ? "scope-limited" : "ready",
    account: { login: account.login, gitProtocol: "https", scopes },
    capabilities,
  };
}
