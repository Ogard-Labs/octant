import { Schema } from "effect";
import { CodeRelativePath } from "./code";
import { ExtensionComponentQualifiedId } from "./extensions";

/**
 * Debug configurations for a Code thread: Octant's own record of what a debug
 * session runs. Canonical: docs/design/language-services.md § Debug
 * configurations.
 *
 * A configuration is never another product's launch file and is never written
 * back to the repository. A repository file only proposes one; the person
 * confirms it at a local window, and the host keeps the confirmed record with
 * its approval. Every path is checkout-relative, contained again with symlinks
 * resolved when the configuration is confirmed and at every start.
 */

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const textEncoder = new TextEncoder();

export const MAX_CODE_DEBUG_CONFIGURATION_NAME_LENGTH = 128;
export const MAX_CODE_DEBUG_ARGUMENTS = 64;
export const MAX_CODE_DEBUG_ARGUMENT_BYTES = 1_024;
export const MAX_CODE_DEBUG_ENVIRONMENT_ENTRIES = 32;
export const MAX_CODE_DEBUG_ENVIRONMENT_VALUE_BYTES = 1_024;
export const MAX_CODE_DEBUG_UNUSED_FIELDS = 64;
export const MAX_CODE_DEBUG_UNUSED_FIELD_LENGTH = 128;

/**
 * Credential variables the host keeps from every child it starts: provider
 * keys and tokens, and the GitHub token its own `gh` reads. A configuration
 * may not name one, so a value typed or imported under that name never reads
 * as the host's credential, and Octant never has to decide whether to pass it.
 */
export const HOST_CREDENTIAL_ENVIRONMENT_KEYS = [
  "AI_GATEWAY_API_KEY",
  "AIROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AZURE_OPENAI_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLINE_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "CODEX_API_KEY",
  "DEEPSEEK_API_KEY",
  "GEMINI_API_KEY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "MOONSHOT_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "XAI_API_KEY",
  "Z_AI_API_KEY",
] as const;
const hostCredentialKeys: ReadonlySet<string> = new Set(HOST_CREDENTIAL_ENVIRONMENT_KEYS);

const boundedBytes = (maximumBytes: number) =>
  Schema.String.pipe(
    Schema.filter(
      (value) => !value.includes("\0") && textEncoder.encode(value).byteLength <= maximumBytes,
    ),
  );

/**
 * An environment variable name a configuration may set. `OCTANT_` names, in
 * any case, are Octant's own and never reach a session.
 */
export const CodeDebugEnvironmentKey = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
  Schema.filter(
    (key) => !key.toUpperCase().startsWith("OCTANT_") && !hostCredentialKeys.has(key.toUpperCase()),
  ),
  Schema.brand("CodeDebugEnvironmentKey"),
);
export type CodeDebugEnvironmentKey = typeof CodeDebugEnvironmentKey.Type;

export const CodeDebugEnvironmentEntry = Schema.Struct({
  key: CodeDebugEnvironmentKey,
  value: boundedBytes(MAX_CODE_DEBUG_ENVIRONMENT_VALUE_BYTES),
}).annotations(strict);
export type CodeDebugEnvironmentEntry = typeof CodeDebugEnvironmentEntry.Type;

export const CodeDebugConfigurationName = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(MAX_CODE_DEBUG_CONFIGURATION_NAME_LENGTH),
);
export type CodeDebugConfigurationName = typeof CodeDebugConfigurationName.Type;

/**
 * What a debug session runs. `adapter` names an installed `debug-adapter`
 * component. `program` and `cwd` are checkout-relative; an absent `cwd` is the
 * checkout's root. The `launch` request is the only one Octant sends, so the
 * record has no `request` field.
 */
export const CodeDebugConfiguration = Schema.Struct({
  name: CodeDebugConfigurationName,
  adapter: ExtensionComponentQualifiedId,
  program: CodeRelativePath,
  args: Schema.Array(boundedBytes(MAX_CODE_DEBUG_ARGUMENT_BYTES)).pipe(
    Schema.maxItems(MAX_CODE_DEBUG_ARGUMENTS),
  ),
  cwd: Schema.optional(CodeRelativePath),
  env: Schema.Array(CodeDebugEnvironmentEntry).pipe(
    Schema.maxItems(MAX_CODE_DEBUG_ENVIRONMENT_ENTRIES),
    Schema.filter((entries) => new Set(entries.map((entry) => entry.key)).size === entries.length),
  ),
  stopOnEntry: Schema.Boolean,
}).annotations(strict);
export type CodeDebugConfiguration = typeof CodeDebugConfiguration.Type;

/** The SHA-256 digest of one confirmed configuration, which its approval covers. */
export const CodeDebugConfigurationDigest = Schema.String.pipe(
  Schema.pattern(/^sha256:[a-f0-9]{64}$/),
  Schema.brand("CodeDebugConfigurationDigest"),
);
export type CodeDebugConfigurationDigest = typeof CodeDebugConfigurationDigest.Type;

/**
 * Why a debug session does not start, in the order the host checks. The
 * thread and checkout checks a language read makes come first; the launch
 * decision's reasons (`@octant/domain` debug session start policy) follow
 * unchanged; `confinement-unavailable` is last, so nothing launches until all
 * pass.
 */
export const CodeDebugStartRefusalReason = Schema.Literal(
  "no-reach",
  "thread-inactive",
  "checkout-mismatch",
  "checkout-unavailable",
  "unsupported-platform",
  "mode-prohibited",
  "plan-read-only",
  "local-host-required",
  "approval-required",
  "configuration-invalid",
  "confinement-unavailable",
);
export type CodeDebugStartRefusalReason = typeof CodeDebugStartRefusalReason.Type;

/**
 * Why an entry of an imported launch file proposes nothing. `not-launch`:
 * its request is not `launch`. `no-adapter` and `adapter-ambiguous`: its
 * `type` matches no effective adapter, or more than one. `unsupported-variable`:
 * it uses a variable outside the closed set. `needs-open-file`: it uses a
 * current-file variable with no file open. `outside-checkout`: its program or
 * folder resolves outside the checkout. `invalid`: a mapped value is missing,
 * of the wrong type, or out of bounds.
 */
export const CodeDebugImportUnmappableReason = Schema.Literal(
  "not-launch",
  "no-adapter",
  "adapter-ambiguous",
  "unsupported-variable",
  "needs-open-file",
  "outside-checkout",
  "invalid",
);
export type CodeDebugImportUnmappableReason = typeof CodeDebugImportUnmappableReason.Type;

/**
 * One entry of a repository launch file, as Octant would run it. A proposal
 * runs nothing until the person confirms it. `unusedFields` names every field
 * the entry holds that Octant does not use, so the person sees what the file
 * asked for and Octant will not do.
 */
export const CodeDebugConfigurationProposal = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("proposed"),
    configuration: CodeDebugConfiguration,
    unusedFields: Schema.Array(
      Schema.String.pipe(Schema.minLength(1), Schema.maxLength(MAX_CODE_DEBUG_UNUSED_FIELD_LENGTH)),
    ).pipe(Schema.maxItems(MAX_CODE_DEBUG_UNUSED_FIELDS)),
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("unmappable"),
    name: Schema.optional(CodeDebugConfigurationName),
    reason: CodeDebugImportUnmappableReason,
  }).annotations(strict),
);
export type CodeDebugConfigurationProposal = typeof CodeDebugConfigurationProposal.Type;

export const decodeCodeDebugConfiguration = Schema.decodeUnknownSync(CodeDebugConfiguration);
export const decodeCodeDebugConfigurationProposal = Schema.decodeUnknownSync(
  CodeDebugConfigurationProposal,
);
