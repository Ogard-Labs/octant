import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";
import { MODEL_PROVIDER_CREDENTIAL_VARIABLES } from "@octant/domain";

/**
 * The host environment a provider runtime receives outside Strict.
 *
 * Outside Strict a provider launches with the host's environment, as it does
 * when the person runs it in their own shell: proxies, custom certificate
 * authorities, routing such as `ANTHROPIC_BASE_URL` or Bedrock and Vertex,
 * and the credentials their own tools sign in with (`GH_TOKEN`, an npm token,
 * AWS keys, their own services' keys), which the agent's commands need as
 * the person's do (maintainer decision, 2026-11-25). Two kinds of variable
 * never cross: Octant's own (`OCTANT_*`, which name the host's internal
 * bridges, ports and switches), and another model provider's credential,
 * since one provider never receives another's credentials (Architecture:
 * "Octant adds no restrictions of its own unless Strict is on"). Under Strict
 * each runtime keeps its own fixed list instead.
 */

const OCTANT_PREFIX = "OCTANT_";

/**
 * The host environment less Octant's own variables and every model-provider
 * credential the provider does not name in `ownCredentials`.
 */
export function providerHostEnvironment(
  hostEnvironment: NodeJS.ProcessEnv,
  ownCredentials: ReadonlySet<string> = new Set(),
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(hostEnvironment).filter(([key, value]) => {
      const name = key.toUpperCase();
      if (value === undefined || name.startsWith(OCTANT_PREFIX)) return false;
      return !MODEL_PROVIDER_CREDENTIAL_VARIABLES.has(name) || ownCredentials.has(name);
    }),
  );
}

/**
 * The Bedrock API key a provider that signs in to Amazon Bedrock reads from
 * the host, as its own CLI does: that provider's own, so never stripped for
 * it. The AWS access keys are not listed: they are the person's general
 * credentials and cross outside Strict for every provider.
 */
export const BEDROCK_MODEL_CREDENTIALS: ReadonlyArray<string> = ["AWS_BEARER_TOKEN_BEDROCK"];

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
