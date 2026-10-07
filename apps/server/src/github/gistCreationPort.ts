import { sanitizedEnvironment } from "./ghAuthenticationPort";
import {
  createGhCatalogueCommandPort,
  type GhCatalogueCommandPort,
} from "./ghRepositoryCataloguePort";

/**
 * Creating a GitHub Gist through the connection Octant already has.
 *
 * Every call is one fixed, non-mutating-except-the-gist POST to
 * `api.github.com/gists`: the request body is the only variable, and it is
 * written on stdin so the rendered document never reaches a process listing.
 * The credential is the host-managed one `gh` already resolved — this module
 * never reads a token — and a host with no usable `gh` answers `unavailable`
 * rather than failing the export loudly.
 */

/** GitHub gist ids are short hex-ish tokens; anything else is not a gist id. */
const GIST_ID_PATTERN = /^[A-Za-z0-9]{1,64}$/;
const GIST_URL_PATTERN = /^https:\/\/gist\.github\.com\/[A-Za-z0-9][A-Za-z0-9_.\-/]*$/;

export interface GistCreationRequest {
  /** The file name inside the gist, already made safe by export policy. */
  readonly fileName: string;
  readonly content: string;
  readonly description: string;
  readonly visibility: "secret" | "public";
}

export type GistCreationResult =
  | {
      readonly kind: "created";
      readonly gist: { readonly id: string; readonly url: string };
    }
  | { readonly kind: "unauthorized" }
  /** GitHub answered and declined the request, e.g. a connection without the gist scope. */
  | { readonly kind: "rejected" }
  | { readonly kind: "unavailable" };

export interface GistCreationPort {
  create(input: GistCreationRequest): Promise<GistCreationResult>;
}

/**
 * The one door to the gist API, over a `gh api` command port. A test passes a
 * fake command port; a host passes the real one.
 */
export function createGistCreationPort(
  command: GhCatalogueCommandPort,
  options?: { readonly environment?: NodeJS.ProcessEnv },
): GistCreationPort {
  const environment = options?.environment ?? process.env;
  return {
    async create(input) {
      const body = JSON.stringify({
        description: input.description,
        public: input.visibility === "public",
        files: { [input.fileName]: { content: input.content } },
      });
      let result: {
        readonly exitCode: number;
        readonly stdout: string;
        readonly stderr?: string;
      };
      try {
        result = await command.run(
          ["api", "gists", "--method", "POST", "--hostname", "github.com", "--input", "-"],
          { environment: sanitizedEnvironment(environment), stdin: body },
          new AbortController().signal,
        );
      } catch {
        return { kind: "unavailable" };
      }
      if (result.exitCode !== 0) {
        return classifyGistFailure(`${result.stdout}\n${result.stderr ?? ""}`);
      }
      return decodeCreatedGist(result.stdout);
    },
  };
}

/** The real port, or an unavailable one when `gh` cannot be used. */
export function createGhGistCreationPort(ghExecutable: string | undefined): GistCreationPort {
  return createGistCreationPort(createGhCatalogueCommandPort(ghExecutable));
}

function decodeCreatedGist(stdout: string): GistCreationResult {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return { kind: "unavailable" };
  }
  if (!isRecord(value)) return { kind: "unavailable" };
  const id = value.id;
  const url = value.html_url;
  if (
    typeof id !== "string" ||
    !GIST_ID_PATTERN.test(id) ||
    typeof url !== "string" ||
    !GIST_URL_PATTERN.test(url)
  ) {
    return { kind: "unavailable" };
  }
  return { kind: "created", gist: { id, url } };
}

function classifyGistFailure(diagnostic: string): GistCreationResult {
  if (
    /HTTP 401|bad credentials|authentication required|not logged in|token has expired/i.test(
      diagnostic,
    )
  ) {
    return { kind: "unauthorized" };
  }
  // Any other 4xx is GitHub declining the request (a token without the gist
  // scope answers 404 or 403), not GitHub being unreachable. A rate limit is
  // transient, so it stays unavailable.
  if (/HTTP 4\d\d/.test(diagnostic) && !/rate limit|HTTP 429/i.test(diagnostic)) {
    return { kind: "rejected" };
  }
  return { kind: "unavailable" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
