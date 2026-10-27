import type { CloudIamSigningScope, CloudIamSourceIdentity } from "@octant/contracts";
import type { CloudIamHost, CloudIamRequest, CloudIamSignInAgainReason } from "./cloudIam";

/**
 * A cloud's single sign-on and the host broker's signer in front of it, in
 * memory, for proving a driver's cloud-IAM signing without a real account.
 *
 * It keeps the broker's rules a driver relies on: a request outside the
 * grant's scope is refused before anything is signed, a session that ended
 * or was withdrawn drops the grant, a role the portal no longer gives keeps
 * it, and renewing mints new credentials. Its signature is not the cloud's
 * algorithm but is bound the same way, to the method, host, path, query, the
 * signed headers, and the payload hash, with a secret only the fake holds;
 * the paired endpoint check rebuilds it from the request it received.
 */
export type FakeCloudSignAnswer =
  | "signed"
  | CloudIamSignInAgainReason
  | "not-authorized"
  | "unreachable";

interface FakeCloudGrant {
  readonly source: CloudIamSourceIdentity;
  readonly scope: CloudIamSigningScope;
  /** The credentials the grant signs with now; renewing replaces them. */
  credentials: { readonly keyId: string; readonly secret: string; readonly token: string };
}

export class FakeCloudSigner {
  readonly #grants = new Map<string, FakeCloudGrant>();
  readonly #secrets: string[] = [];
  readonly #refused = new Set<string>();
  readonly #minted = new Map<string, { readonly secret: string; readonly token: string }>();
  #answer: FakeCloudSignAnswer = "signed";
  #signCalls = 0;
  #renewals = 0;

  /** A completed sign-in; returns the grant's credential reference. */
  signIn(source: CloudIamSourceIdentity, scope: CloudIamSigningScope): string {
    const credentialRef = crypto.randomUUID();
    this.#grants.set(credentialRef, { source, scope, credentials: this.#mint() });
    return credentialRef;
  }

  /** How the broker answers every later signature. */
  answerSignWith(answer: FakeCloudSignAnswer): void {
    this.#answer = answer;
  }

  /** The endpoint stops accepting the credentials minted so far, as when they expire. */
  expireCredentials(): void {
    for (const grant of this.#grants.values()) this.#refused.add(grant.credentials.keyId);
  }

  hasGrant(credentialRef: string): boolean {
    return this.#grants.has(credentialRef);
  }

  signCalls(): number {
    return this.#signCalls;
  }

  renewals(): number {
    return this.#renewals;
  }

  /** Every secret and token the fake minted: none may appear in a report. */
  secrets(): ReadonlyArray<string> {
    return [...this.#secrets];
  }

  host(): CloudIamHost {
    return {
      sign: async (credentialRef, request, options) => {
        this.#signCalls += 1;
        if (this.#answer === "unreachable") throw new Error("broker unreachable");
        const grant = this.#grants.get(credentialRef);
        if (grant === undefined) return { kind: "sign-in-again", reason: "expired" };
        if (
          request.method !== grant.scope.method ||
          request.host !== grant.scope.host ||
          !request.path.startsWith(grant.scope.pathPrefix) ||
          !/^[0-9a-f]{64}$/.test(request.payloadHash) ||
          Object.keys(request.headers).some(
            (name) => !["content-type", "accept"].includes(name.toLowerCase()),
          )
        ) {
          return { kind: "outside-scope" };
        }
        if (this.#answer === "expired" || this.#answer === "revoked") {
          this.#grants.delete(credentialRef);
          return { kind: "sign-in-again", reason: this.#answer };
        }
        if (this.#answer === "not-authorized") return { kind: "not-authorized" };
        if (options.renewCredentials) {
          this.#renewals += 1;
          grant.credentials = this.#mint();
        }
        const { keyId, secret, token } = grant.credentials;
        return {
          kind: "signed",
          headers: {
            authorization: `FAKE-CLOUD-SIGNATURE ${keyId} ${await digest(secret, canonical(request))}`,
            "x-amz-date": "20261027T090000Z",
            "x-amz-security-token": token,
          },
        };
      },
    };
  }

  /**
   * Whether a request the endpoint received carries a current signature over
   * exactly what it sends: rebuilt from the received method, URL, signed
   * headers, and body, never from what was asked to be signed.
   */
  async verify(url: URL, init: RequestInit): Promise<"valid" | "invalid" | "expired"> {
    const headers = new Headers(init.headers);
    const match = /^FAKE-CLOUD-SIGNATURE (\S+) ([0-9a-f]{64})$/.exec(
      headers.get("authorization") ?? "",
    );
    if (match === null) return "invalid";
    const [, keyId = "", signature] = match;
    const minted = this.#minted.get(keyId);
    if (minted === undefined || headers.get("x-amz-security-token") !== minted.token) {
      return "invalid";
    }
    const body = typeof init.body === "string" ? init.body : "";
    const signed: Record<string, string> = {};
    for (const name of ["content-type", "accept"]) {
      const value = headers.get(name);
      if (value !== null) signed[name] = value;
    }
    const rebuilt = await digest(
      minted.secret,
      canonical({
        method: init.method ?? "GET",
        host: url.host,
        path: url.pathname,
        query: [...url.searchParams.entries()],
        headers: signed,
        payloadHash: await sha256Hex(body),
      }),
    );
    if (rebuilt !== signature) return "invalid";
    return this.#refused.has(keyId) ? "expired" : "valid";
  }

  #mint(): FakeCloudGrant["credentials"] {
    const keyId = `FAKEKEY${crypto.randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase()}`;
    const secret = `fake-cloud-secret-${crypto.randomUUID()}`;
    const token = `fake-cloud-session-${crypto.randomUUID()}`;
    this.#secrets.push(secret, token);
    this.#minted.set(keyId, { secret, token });
    return { keyId, secret, token };
  }
}

function canonical(request: CloudIamRequest): string {
  const headers = Object.entries(request.headers)
    .map(([name, value]) => `${name.toLowerCase()}:${value.trim()}`)
    .sort()
    .join("\n");
  const query = [...request.query]
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join("&");
  return [request.method, request.host, request.path, query, headers, request.payloadHash].join(
    "\n",
  );
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function digest(secret: string, value: string): Promise<string> {
  return sha256Hex(`${secret}\n${value}`);
}
