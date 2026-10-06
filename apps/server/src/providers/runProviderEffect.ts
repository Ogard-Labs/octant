import { Cause, Effect, Exit } from "effect";

/**
 * Runs an Effect to its value and rejects with the typed failure itself.
 *
 * `Effect.runPromise` rejects with a wrapper that carries the failure only as
 * JSON in its message, so a caller that decodes the rejection as a provider
 * failure loses its category: a rate limit, a rejected credential, and an
 * overloaded endpoint all read as the same generic failure. Retry and fallback
 * decisions are made on the category, so the rejection must keep it.
 */
export async function runProviderEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}
