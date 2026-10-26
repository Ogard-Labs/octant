import type {
  DirectoryOAuthBinding,
  DirectoryOAuthHost,
  DirectoryOAuthSignInAgainReason,
} from "./directoryOAuth";

/**
 * An organization's directory and the host broker in front of it, in memory,
 * for proving a driver's directory sign-in without a real tenant.
 *
 * It keeps the broker's rules a driver relies on: the binding is checked
 * before a token is released, refresh is single-flight per grant, a refresh
 * the directory refuses for good drops the grant, and a refresh that needs
 * the person present, a network failure, or a 5xx keeps it. Every token it
 * issues is recorded so a test can prove none escapes.
 */
export type FakeDirectoryRefreshAnswer =
  | "refreshed"
  | DirectoryOAuthSignInAgainReason
  | "unreachable"
  | "server-error";

const TOKEN_LIFETIME_MS = 3_600_000;

interface FakeGrant {
  readonly binding: DirectoryOAuthBinding;
  accessToken: string;
  expiresAt: number;
  refreshToken: string;
}

export class FakeDirectory {
  readonly #now: () => number;
  readonly #grants = new Map<string, FakeGrant>();
  readonly #refreshing = new Map<string, Promise<RefreshAnswer>>();
  readonly #issued: string[] = [];
  readonly #refusedAtEndpoint = new Set<string>();
  #refreshAnswer: FakeDirectoryRefreshAnswer = "refreshed";
  #brokerReachable = true;
  #brokerCalls = 0;
  #refreshExchanges = 0;

  constructor(now: () => number) {
    this.#now = now;
  }

  /** A completed sign-in; returns the grant's credential reference. */
  signIn(binding: DirectoryOAuthBinding, options: { readonly expiresInMs: number }): string {
    const credentialRef = crypto.randomUUID();
    this.#grants.set(credentialRef, {
      binding,
      accessToken: this.#issue("access"),
      expiresAt: this.#now() + options.expiresInMs,
      refreshToken: this.#issue("refresh"),
    });
    return credentialRef;
  }

  /** How the directory answers every later refresh. */
  answerRefreshWith(answer: FakeDirectoryRefreshAnswer): void {
    this.#refreshAnswer = answer;
  }

  setBrokerReachable(reachable: boolean): void {
    this.#brokerReachable = reachable;
  }

  /**
   * The endpoint stops accepting every token issued so far, as it does when
   * the directory revokes a session before an issued token expires.
   */
  refuseIssuedTokensAtEndpoint(): void {
    for (const token of this.#issued) this.#refusedAtEndpoint.add(token);
  }

  /** Whether the endpoint would accept this token: current for a grant and not refused. */
  accepts(token: string): boolean {
    if (this.#refusedAtEndpoint.has(token)) return false;
    for (const grant of this.#grants.values()) {
      if (grant.accessToken === token && grant.expiresAt > this.#now()) return true;
    }
    return false;
  }

  hasGrant(credentialRef: string): boolean {
    return this.#grants.has(credentialRef);
  }

  /** Calls the driver made to the broker, of either kind. */
  brokerCalls(): number {
    return this.#brokerCalls;
  }

  /** Refresh-token exchanges the directory answered. */
  refreshExchanges(): number {
    return this.#refreshExchanges;
  }

  /** Every access and refresh token issued, for proving none was reported. */
  issuedTokens(): ReadonlyArray<string> {
    return [...this.#issued];
  }

  host(): DirectoryOAuthHost {
    return {
      access: async (credentialRef, binding) => {
        this.#brokerCalls += 1;
        if (!this.#brokerReachable) throw new Error("The broker is unreachable.");
        const grant = this.#grants.get(credentialRef);
        if (grant === undefined) return { kind: "sign-in-again", reason: "expired" };
        if (!sameBinding(grant.binding, binding)) return { kind: "binding-mismatch" };
        return {
          kind: "granted",
          accessToken: grant.accessToken,
          expiresAt: new Date(grant.expiresAt).toISOString(),
        };
      },
      refresh: async (credentialRef) => {
        this.#brokerCalls += 1;
        if (!this.#brokerReachable) throw new Error("The broker is unreachable.");
        const running = this.#refreshing.get(credentialRef);
        if (running !== undefined) return running;
        const exchange = this.#exchange(credentialRef).finally(() =>
          this.#refreshing.delete(credentialRef),
        );
        this.#refreshing.set(credentialRef, exchange);
        return exchange;
      },
    };
  }

  async #exchange(credentialRef: string): Promise<RefreshAnswer> {
    // Let concurrent callers join this exchange, as they would while a real
    // token request is on the wire.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const grant = this.#grants.get(credentialRef);
    if (grant === undefined) return { kind: "sign-in-again", reason: "expired" };
    const answer = this.#refreshAnswer;
    if (answer === "unreachable") return { kind: "transient" };
    this.#refreshExchanges += 1;
    if (answer === "server-error") return { kind: "unavailable" };
    if (answer === "interaction-required") {
      return { kind: "sign-in-again", reason: "interaction-required" };
    }
    if (answer !== "refreshed") {
      this.#grants.delete(credentialRef);
      return { kind: "sign-in-again", reason: answer };
    }
    grant.accessToken = this.#issue("access");
    grant.refreshToken = this.#issue("refresh");
    grant.expiresAt = this.#now() + TOKEN_LIFETIME_MS;
    return { kind: "refreshed" };
  }

  #issue(kind: "access" | "refresh"): string {
    const token = `fake-directory-${kind}-${crypto.randomUUID()}`;
    this.#issued.push(token);
    return token;
  }
}

type RefreshAnswer = Awaited<ReturnType<DirectoryOAuthHost["refresh"]>>;

function sameBinding(left: DirectoryOAuthBinding, right: DirectoryOAuthBinding): boolean {
  return (
    String(left.tenantId) === String(right.tenantId) &&
    String(left.clientId) === String(right.clientId) &&
    left.audience === right.audience &&
    left.endpointOrigin === right.endpointOrigin
  );
}
