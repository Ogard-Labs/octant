import type { GhAuthenticationPortLike } from "./ghAuthenticationPort";

/**
 * Wraps the real {@link GhAuthenticationPort} so it never spawns the `gh`
 * subprocess once the GitHub plugin is disabled. This is the single choke
 * point for ADR 0001's GitHub gate: `GithubCapabilityService`,
 * `GithubCatalogueService`, `ManagedCloneService`, and `GithubReadToolService`
 * all resolve their own graceful "unavailable" path from the authentication
 * snapshot this port produces, so gating here reaches every consumer with no
 * changes to any of them. `close()` always delegates, since releasing a
 * resource the real port may have already acquired is not gated behavior.
 */
export function createGatedGithubAuthenticationPort(options: {
  readonly port: GhAuthenticationPortLike;
  readonly effective: () => boolean;
}): GhAuthenticationPortLike {
  const { port, effective } = options;
  return {
    async observe(signal) {
      if (!effective()) return { kind: "unavailable" };
      return port.observe(signal);
    },
    async execute(command, signal) {
      if (!effective()) throw new Error("GitHub is unavailable.");
      return port.execute(command, signal);
    },
    close() {
      port.close();
    },
  };
}
