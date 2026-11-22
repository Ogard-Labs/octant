import { MAX_PROVIDER_PASS_THROUGH } from "@octant/contracts";

/**
 * Model-provider credentials Octant knows by name. A provider launched outside
 * Strict receives only the ones it names as its own; every other one is
 * dropped, since one provider never receives another's credentials, and no
 * pass-through list can let one through.
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

/**
 * Well-known host credentials that a provider launched outside Strict does not
 * inherit unless they are its own or the person lets them through for that
 * provider in Settings (maintainer decision, 2026-11-22). Outside Strict a
 * provider otherwise gets the person's environment as their shell has it, so a
 * `GH_TOKEN` or an AWS key exported for other work reached every agent's
 * commands with nothing to do with the agent itself.
 *
 * AWS profile names, regions and config-file paths are not on the list: they
 * name where a credential lives, not the credential, and a provider that
 * signs in through Bedrock reads them as its CLI does.
 */
const UNRELATED_HOST_CREDENTIAL_VARIABLES: ReadonlySet<string> = new Set([
  "AWS_ACCESS_KEY_ID",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SECURITY_TOKEN",
  "AWS_SESSION_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GH_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
  "NODE_AUTH_TOKEN",
  "NPM_TOKEN",
]);

const API_KEY_SUFFIX = "_API_KEY";

/** Whether a host variable is a well-known credential a provider gets only when it is its own or let through. */
export function isUnrelatedHostCredential(name: string): boolean {
  const upper = name.toUpperCase();
  return UNRELATED_HOST_CREDENTIAL_VARIABLES.has(upper) || upper.endsWith(API_KEY_SUFFIX);
}

/**
 * Whether one host variable crosses into a provider launched outside Strict.
 * `own` names the credentials the provider itself signs in with, which are
 * never stripped; `passThrough` names what the person lets through for that
 * provider. Both hold upper-cased names, since Windows spells a variable in
 * any case.
 */
export function hostCredentialCrosses(
  name: string,
  lists: { readonly own: ReadonlySet<string>; readonly passThrough: ReadonlySet<string> },
): boolean {
  if (!isUnrelatedHostCredential(name)) return true;
  const upper = name.toUpperCase();
  return lists.own.has(upper) || lists.passThrough.has(upper);
}

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/**
 * Why a name cannot join a provider's pass-through list (`current`, the names
 * already on it), or undefined when it can. A name the launch would still keep
 * out is refused rather than kept as a grant that never applies: Octant's own
 * variables name the host's internal bridges, and a model provider's key is
 * either the provider's own, which it already gets, or another's, which it
 * never gets.
 */
export function hostCredentialPassThroughRefusal(
  name: string,
  current: ReadonlyArray<string> = [],
): string | undefined {
  if (!VARIABLE_NAME.test(name)) {
    return "Use an environment variable name: letters, digits and underscores, not starting with a digit.";
  }
  const upper = name.toUpperCase();
  if (upper.startsWith("OCTANT_")) {
    return "Octant's own variables never reach a provider.";
  }
  if (MODEL_PROVIDER_CREDENTIAL_VARIABLES.has(upper)) {
    return "This is a model provider's key. A provider already gets its own and never gets another provider's.";
  }
  if (!current.includes(name) && current.length >= MAX_PROVIDER_PASS_THROUGH) {
    return `A provider can let at most ${MAX_PROVIDER_PASS_THROUGH} credentials through. Remove one first.`;
  }
  return undefined;
}
