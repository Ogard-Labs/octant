import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";

/**
 * The host environment a provider runtime receives outside Strict.
 *
 * Outside Strict a provider launches with the host's environment, as it does
 * when the person runs it in their own shell: proxies, custom certificate
 * authorities, routing such as `ANTHROPIC_BASE_URL` or Bedrock and Vertex,
 * `GH_TOKEN` and the rest. Two kinds of variable never cross: Octant's own
 * (`OCTANT_*`, which name the host's internal bridges, ports and switches),
 * and another model provider's credential, since one provider never receives
 * another's credentials (Architecture: "Octant adds no restrictions of its
 * own unless Strict is on"). Under Strict each runtime keeps its own fixed
 * list instead.
 */

/**
 * Model-provider credentials Octant knows by name. A provider receives only
 * the ones it names as its own; every other one is dropped.
 */
export const MODEL_PROVIDER_CREDENTIAL_VARIABLES: ReadonlySet<string> = new Set([
  "AIROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN",
  "AZURE_OPENAI_API_KEY",
  "CEREBRAS_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CODEX_ACCESS_TOKEN",
  "CODEX_API_KEY",
  "CURSOR_API_KEY",
  "DASHSCOPE_API_KEY",
  "DEEPSEEK_API_KEY",
  "FIREWORKS_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GROQ_API_KEY",
  "KIMI_API_KEY",
  "MISTRAL_API_KEY",
  "MOONSHOT_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "PERPLEXITY_API_KEY",
  "TOGETHER_API_KEY",
  "XAI_API_KEY",
]);

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
    Object.entries(hostEnvironment).filter(
      ([key, value]) =>
        value !== undefined &&
        !key.toUpperCase().startsWith(OCTANT_PREFIX) &&
        (!MODEL_PROVIDER_CREDENTIAL_VARIABLES.has(key.toUpperCase()) ||
          ownCredentials.has(key.toUpperCase())),
    ),
  );
}

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
  const candidates: string[] = [];
  if (hasHome) candidates.push(join(home, ".aws"));
  for (const name of AWS_PROFILE_FILE_VARIABLES) {
    const raw = hostEnvironment[name]?.trim();
    if (raw === undefined || raw.length === 0) continue;
    if (raw.startsWith("~/") && hasHome) {
      candidates.push(join(home, raw.slice(2)));
    } else if (isAbsolute(raw)) {
      candidates.push(raw);
    }
  }
  const seen = new Set<string>();
  const existing: string[] = [];
  const push = (path: string) => {
    if (!seen.has(path)) {
      seen.add(path);
      existing.push(path);
    }
  };
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    // Preserve the literal configured path so Linux Bubblewrap binds the
    // resolved source at the exact path the runtime opens (`~/.aws` or the
    // configured env var path), and also retain the canonical target for
    // macOS Seatbelt read rules.
    push(normalize(candidate));
    try {
      push(realpathSync(candidate));
    } catch {
      // Keep the literal path when realpath fails on a transient entry.
    }
  }
  return existing;
}
