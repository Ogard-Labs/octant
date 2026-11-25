import { MAX_PROVIDER_PASS_THROUGH } from "@octant/contracts";

/**
 * Model-provider credentials Octant knows by name. A provider launched outside
 * Strict receives only the ones it names as its own; every other one is
 * dropped, since one provider never receives another's credentials. Every
 * other host variable, the person's `GH_TOKEN`, npm token, AWS keys and their
 * own services' keys among them, reaches a launch outside Strict as their
 * shell has it (maintainer decision, 2026-11-25): stripping them left `gh`,
 * `npm publish` and `aws` without a sign-in inside an agent's commands. Only
 * Strict keeps a fixed list.
 *
 * `AWS_BEARER_TOKEN_BEDROCK` is on the list although it is an AWS variable:
 * it is a Bedrock API key, which buys model calls and signs no other tool in,
 * so it reaches only a provider that itself signs in to Amazon Bedrock.
 */
export const MODEL_PROVIDER_CREDENTIAL_VARIABLES: ReadonlySet<string> = new Set([
  "AIROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
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
