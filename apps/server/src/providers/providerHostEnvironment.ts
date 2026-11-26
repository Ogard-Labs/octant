import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";
/**
 * The host environment a provider runtime receives outside Strict.
 *
 * Outside Strict a provider launches with the host's environment, as it does
 * when the person runs it in their own shell: proxies, custom certificate
 * authorities, routing such as `ANTHROPIC_BASE_URL` or Bedrock and Vertex,
 * and every credential their own tools sign in with (`GH_TOKEN`, an npm
 * token, AWS keys, their own services' keys, and the keys of other model
 * providers, which a script or a test the agent runs may call). Two kinds of
 * variable never cross. Octant's own (`OCTANT_*`) name the host's internal
 * bridges, ports and switches. And where the person chose an account for the
 * provider in Octant, the variables that would sign the provider itself in
 * as a different account stay out (`accountCredentials`): a host
 * `ANTHROPIC_API_KEY` would move a Claude Code thread from the chosen
 * subscription to metered API billing without a word in the thread. That
 * protects the hard line that the host, not the environment a launch happens
 * to inherit, decides which account a turn spends from (maintainer decision,
 * 2026-11-26; Architecture: "Octant adds no restrictions of its own unless
 * Strict is on"). Under Strict each runtime keeps its own fixed list instead.
 */

const OCTANT_PREFIX = "OCTANT_";

/**
 * The host environment less Octant's own variables and the provider's
 * `accountCredentials`: the names that would replace the sign-in of the
 * account chosen for it in Octant. A provider that takes its sign-in from the
 * host environment names none.
 */
export function providerHostEnvironment(
  hostEnvironment: NodeJS.ProcessEnv,
  accountCredentials: ReadonlySet<string> = new Set(),
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(hostEnvironment).filter(([key, value]) => {
      const name = key.toUpperCase();
      return (
        value !== undefined && !name.startsWith(OCTANT_PREFIX) && !accountCredentials.has(name)
      );
    }),
  );
}

/**
 * The variables Claude Code signs itself in with. No launch takes them from
 * the host: the account chosen in Octant decides which account a turn runs
 * as and is billed to, and a host `ANTHROPIC_API_KEY` would move a
 * subscription thread to metered API billing without a word in the thread.
 */
export const CLAUDE_ACCOUNT_CREDENTIALS: ReadonlySet<string> = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
]);

const AWS_PROFILE_FILE_VARIABLES = [
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
] as const;

/**
 * Existing AWS profile and credential-file paths a provider runtime outside
 * Strict may read directly (as it does in its own CLI). Octant never opens,
 * reads, copies, or replaces these files; it only passes their paths to a
 * confined Plan/Chat launch outside Strict so the runtime can read its own
 * Bedrock profile and refresh settings.
 */
export function awsProfileReadPaths(
  hostEnvironment: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  const home = hostEnvironment.HOME?.trim();
  const hasHome = home !== undefined && home.length > 0 && isAbsolute(home);
  const seen = new Set<string>();
  const existing: string[] = [];
  const exposedDirectories: string[] = [];
  const push = (path: string) => {
    if (!seen.has(path)) {
      seen.add(path);
      existing.push(path);
    }
  };
  const isInsideExposedDirectory = (path: string) =>
    exposedDirectories.some(
      (directory) => path === directory || path.startsWith(`${directory}${sep}`),
    );

  if (hasHome) {
    const awsDir = normalize(join(home, ".aws"));
    if (existsSync(awsDir)) {
      push(awsDir);
      let isDir = false;
      try {
        isDir = statSync(awsDir).isDirectory();
      } catch {
        // Ignore transient stat failures.
      }
      if (isDir) exposedDirectories.push(awsDir);
      try {
        const canonicalAwsDir = realpathSync(awsDir);
        push(canonicalAwsDir);
        if (isDir) exposedDirectories.push(canonicalAwsDir);
      } catch {
        // Keep the literal path when realpath fails on a transient entry.
      }
    }
  }

  for (const name of AWS_PROFILE_FILE_VARIABLES) {
    const raw = hostEnvironment[name]?.trim();
    if (raw === undefined || raw.length === 0) continue;
    let candidate: string | undefined;
    if (raw.startsWith("~/") && hasHome) {
      candidate = join(home, raw.slice(2));
    } else if (isAbsolute(raw)) {
      candidate = raw;
    }
    if (candidate === undefined || !existsSync(candidate)) continue;
    const literal = normalize(candidate);
    let canonical: string | undefined;
    try {
      canonical = realpathSync(literal);
    } catch {
      // Keep the literal path when realpath fails on a transient entry.
    }
    // If an already-exposed `~/.aws` directory already contains the literal
    // path, omit the redundant child literal so Linux Bubblewrap never tries to
    // bind-mount over a symlink inside a read-only parent mount. Retain the
    // canonical target when it lives outside `~/.aws` so symlink resolution
    // succeeds on both Linux and macOS.
    if (!isInsideExposedDirectory(literal)) {
      push(literal);
    }
    if (canonical !== undefined && !isInsideExposedDirectory(canonical)) {
      push(canonical);
    }
  }
  return existing;
}
