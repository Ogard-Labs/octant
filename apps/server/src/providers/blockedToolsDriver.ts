import type { ProviderDriver } from "@octant/provider-sdk/driver";
import { Effect } from "effect";

/**
 * A driver whose every session start and resume carries the tools the person
 * blocked for its provider, read from Settings at that moment, so a change
 * applies at the next launch and never to a session already running. Every
 * caller that starts a session goes through this, whatever mode or run it
 * serves; a start that already names its own list keeps it.
 */
export function withBlockedTools(
  driver: ProviderDriver,
  blocked: () => ReadonlyArray<string>,
): ProviderDriver {
  const listFor = (own: ReadonlyArray<string> | undefined) => {
    if (own !== undefined) return {};
    const names = blocked();
    return names.length === 0 ? {} : { blockedTools: names };
  };
  return {
    ...driver,
    acquire: (input) =>
      driver.acquire(input).pipe(
        Effect.map((connection) => ({
          ...connection,
          start: (start) => connection.start({ ...start, ...listFor(start.blockedTools) }),
          resume: (resume) => connection.resume({ ...resume, ...listFor(resume.blockedTools) }),
        })),
      ),
  };
}
