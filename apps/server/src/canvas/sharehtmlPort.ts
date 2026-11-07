import { Schema } from "effect";

/**
 * The sharehtml.org API port: one POST that turns a rendered HTML page into
 * an unlisted link. Anonymous uploads need no token. The response's manage
 * URL is shown once and is the only way to delete the page later, so the
 * export receipt surfaces it; Octant stores nothing.
 *
 * API: POST {SHAREHTML_API_BASE_URL}/pages with `Content-Type: text/html`.
 * 201 answers {id, url, manageUrl?}; errors answer {error: {code, message}}
 * with stable codes — match on the code, not the message.
 */

export const SHAREHTML_API_BASE_URL = "https://sharehtml.org/api/v1";

const REQUEST_TIMEOUT_MS = 30_000;

const SharehtmlPage = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  manageUrl: Schema.optional(Schema.String),
}).annotations({ strict: true });

const SharehtmlFailure = Schema.Struct({
  error: Schema.Struct({ code: Schema.String, message: Schema.String }).annotations({
    strict: true,
  }),
}).annotations({ strict: true });

/** Codes that mean the page itself was not accepted — never worth retrying. */
const REFUSED_CODES = new Set([
  "too_large",
  "not_html",
  "invalid_utf8",
  "rejected",
  "slug_invalid",
  "slug_taken",
]);

/** Codes that mean "not now" — rate limit, quota, or a verification challenge. */
const RETRYABLE_CODES = new Set(["rate_limited", "quota_exceeded", "turnstile_failed"]);

export type SharehtmlCreateOutcome =
  | {
      readonly kind: "created";
      readonly id: string;
      readonly url: string;
      readonly manageUrl: string | undefined;
    }
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "unavailable"; readonly message: string };

export interface SharehtmlPort {
  readonly createPage: (html: string) => Promise<SharehtmlCreateOutcome>;
}

type FetchLike = (
  input: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body: string;
    readonly signal: AbortSignal;
  },
) => Promise<Response>;

export function createSharehtmlPort(
  fetchPage: FetchLike = (input, init) => fetch(input, init),
): SharehtmlPort {
  return {
    createPage: async (html) => {
      let response: Response;
      try {
        response = await fetchPage(`${SHAREHTML_API_BASE_URL}/pages`, {
          method: "POST",
          headers: { "content-type": "text/html" },
          body: html,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        return { kind: "unavailable", message: "sharehtml.org could not be reached." };
      }
      let json: unknown;
      try {
        json = await response.json();
      } catch {
        return {
          kind: "unavailable",
          message: `sharehtml.org answered ${String(response.status)} without JSON.`,
        };
      }
      if (response.status === 201) {
        try {
          const page = Schema.decodeUnknownSync(SharehtmlPage)(json);
          return { kind: "created", id: page.id, url: page.url, manageUrl: page.manageUrl };
        } catch {
          return {
            kind: "unavailable",
            message: "sharehtml.org answered 201 with an unreadable page.",
          };
        }
      }
      try {
        const failure = Schema.decodeUnknownSync(SharehtmlFailure)(json);
        const { code, message } = failure.error;
        if (REFUSED_CODES.has(code)) return { kind: "refused", message };
        if (RETRYABLE_CODES.has(code)) {
          return { kind: "unavailable", message: `${message} Try again later.` };
        }
        return { kind: "unavailable", message };
      } catch {
        return {
          kind: "unavailable",
          message: `sharehtml.org answered ${String(response.status)}.`,
        };
      }
    },
  };
}
