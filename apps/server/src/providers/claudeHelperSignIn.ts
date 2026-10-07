import type { ProviderCredentialStore } from "./credentialBrokerClient";

/**
 * The sign-in a confined Claude launch uses, kept in Octant's credential broker
 * under the Claude Code provider instance.
 *
 * A Plan launch, which is how every Chat subagent runs, may not reach the
 * login keychain: the runtime reads its own sign-in by running
 * `/usr/bin/security`, which would also hand back any other item that trusts
 * the tool. So a confined launch is given a long-lived token instead, minted
 * once by the runtime's own `claude setup-token` and passed as
 * `CLAUDE_CODE_OAUTH_TOKEN`, the variable the runtime documents for it. The
 * runtime never refreshes such a token, so a token that stops working is
 * marked expired rather than retried.
 *
 * The broker keeps one entry per provider instance, which in API-key mode is
 * the raw key. The envelope keeps the two apart: a raw key never reads as a
 * helper token, and a helper token never reads as a key.
 */
export const CLAUDE_HELPER_NOT_CONNECTED_MESSAGE =
  "Connect Claude for helpers in Settings › Claude Code.";
export const CLAUDE_HELPER_EXPIRED_MESSAGE =
  "Claude for helpers expired. Connect Claude for helpers in Settings › Claude Code.";

const ENVELOPE_KIND = "claude-helper-sign-in";
const MAX_TOKEN_CHARACTERS = 4_096;
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]{16,4096}$/;

export type ClaudeHelperSignInState =
  | { readonly kind: "connected"; readonly token: string }
  | { readonly kind: "expired" }
  | { readonly kind: "not-connected" }
  | { readonly kind: "unavailable" };

/** What the Claude driver reads at launch and reports after a refused token. */
export interface ClaudeHelperSignInPort {
  readonly read: (instanceId: string) => Promise<ClaudeHelperSignInState>;
  readonly markExpired: (instanceId: string, token: string) => Promise<void>;
}

/** What Settings drives: store a captured token, or remove it. */
export interface ClaudeHelperSignInStore extends ClaudeHelperSignInPort {
  readonly connect: (instanceId: string, token: string) => Promise<void>;
  readonly disconnect: (instanceId: string) => Promise<void>;
}

export function isClaudeHelperToken(value: string): boolean {
  return value.length <= MAX_TOKEN_CHARACTERS && TOKEN_PATTERN.test(value);
}

export function encodeClaudeHelperSignIn(
  value: { readonly state: "connected"; readonly token: string } | { readonly state: "expired" },
): string {
  if (value.state === "connected" && !isClaudeHelperToken(value.token)) {
    throw new Error("The Claude helper token is malformed.");
  }
  return JSON.stringify({ kind: ENVELOPE_KIND, ...value });
}

/** `undefined` when the stored entry is not a helper sign-in, such as an API key. */
export function readClaudeHelperSignIn(
  raw: string,
):
  | { readonly state: "connected"; readonly token: string }
  | { readonly state: "expired" }
  | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.kind !== ENVELOPE_KIND) return undefined;
  if (record.state === "expired") return { state: "expired" };
  if (
    record.state === "connected" &&
    typeof record.token === "string" &&
    isClaudeHelperToken(record.token)
  ) {
    return { state: "connected", token: record.token };
  }
  return undefined;
}

export function claudeHelperSignInFromBroker(
  broker: ProviderCredentialStore,
): ClaudeHelperSignInStore {
  const current = async (instanceId: string) => {
    if (!(await broker.has(instanceId))) return undefined;
    return readClaudeHelperSignIn(await broker.resolve(instanceId));
  };
  return {
    read: async (instanceId) => {
      try {
        const stored = await current(instanceId);
        if (stored === undefined) return { kind: "not-connected" };
        return stored.state === "connected"
          ? { kind: "connected", token: stored.token }
          : { kind: "expired" };
      } catch {
        return { kind: "unavailable" };
      }
    },
    // Only the token that failed is retired: a reconnect that landed while
    // the refused turn was still settling must not be overwritten.
    markExpired: async (instanceId, token) => {
      const stored = await current(instanceId);
      if (stored?.state !== "connected" || stored.token !== token) return;
      await broker.set(instanceId, encodeClaudeHelperSignIn({ state: "expired" }));
    },
    connect: async (instanceId, token) => {
      await broker.set(instanceId, encodeClaudeHelperSignIn({ state: "connected", token }));
    },
    disconnect: async (instanceId) => {
      if ((await current(instanceId)) === undefined) return;
      await broker.delete(instanceId);
    },
  };
}
