import type { ProviderServerPlacement } from "@octant/provider-sdk/driver";

/**
 * What a provider's own status command said about its sign-in on a server
 * Project's server, run there as the server login: the provider signs in as
 * that login, and no credential of this host goes there.
 */
export type ServerSignIn =
  | { readonly status: "signed-in" }
  | { readonly status: "signed-out" }
  /** The command could not answer: the server was unreachable, or its output said nothing readable. */
  | { readonly status: "refused"; readonly message: string };

/** How long a server's "signed in" is trusted before its status command runs again. */
const SIGNED_IN_HOLD_MS = 5 * 60_000;

/**
 * One provider's sign-in answers per server. A "signed in" is held briefly so
 * the status command does not run before every turn; anything else is never
 * held, so signing in on the server takes effect at the next turn.
 */
export class ServerSignIns {
  readonly #read: (placement: ProviderServerPlacement) => Promise<ServerSignIn>;
  readonly #now: () => number;
  readonly #signedInUntil = new Map<string, number>();

  constructor(
    read: (placement: ProviderServerPlacement) => Promise<ServerSignIn>,
    now: () => number = Date.now,
  ) {
    this.#read = read;
    this.#now = now;
  }

  async read(placement: ProviderServerPlacement): Promise<ServerSignIn> {
    const until = this.#signedInUntil.get(placement.serverName);
    if (until !== undefined && until > this.#now()) return { status: "signed-in" };
    const answer = await this.#read(placement);
    if (answer.status === "signed-in") {
      this.#signedInUntil.set(placement.serverName, this.#now() + SIGNED_IN_HOLD_MS);
    } else {
      this.#signedInUntil.delete(placement.serverName);
    }
    return answer;
  }
}
