import type {
  AnthropicCompatibleProtocol,
  OpenAiCompatibleProtocol,
  ProviderInstance,
  ProviderObservedState,
} from "@octant/contracts";

export const capabilityLabels: ReadonlyArray<
  readonly [keyof ProviderObservedState["capabilities"], string]
> = [
  ["streaming", "Streaming"],
  ["resume", "Resume"],
  ["interruption", "Interruption"],
  ["approvals", "Approvals"],
  ["userQuestions", "User questions"],
  ["reasoning", "Reasoning"],
  ["usage", "Usage"],
  ["toolActivity", "Tool activity"],
  ["fileChanges", "File changes"],
  ["diffs", "Diffs"],
  ["taskProgress", "Task progress"],
  ["nativeChildAgents", "Native child agents"],
];
export const probeTimestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function readinessLabel(value: ProviderObservedState["readiness"]): string {
  return value === "unauthenticated" ? "Authentication required" : titleCase(value);
}

export function providerRowReadinessLabel(
  value: ProviderObservedState["readiness"],
  modelCount: number,
): string {
  if (value === "unauthenticated") return "Sign in required";
  if (value === "incompatible") return "Update required";
  if (value === "degraded" && modelCount === 0) return "Needs setup";
  if (value === "degraded") return "Limited";
  return titleCase(value);
}

export function protocolLabel(
  value: OpenAiCompatibleProtocol | AnthropicCompatibleProtocol,
): string {
  if (value === "auto") return "Automatic";
  if (value === "responses") return "Responses";
  if (value === "chat-completions") return "Chat Completions";
  return "Messages";
}

export function driverLabel(
  driverKind: ProviderInstance["driverKind"] | "oh-my-pi",
):
  | "OpenCode"
  | "Codex"
  | "Claude"
  | "Kimi Code"
  | "Devin"
  | "Kilo"
  | "Pi"
  | "Oh My Pi"
  | "Ollama"
  | "Mistral Vibe"
  | "Grok Build"
  | "Goose"
  | "GLM Agent ACP"
  | "Gemini CLI"
  | "GitHub Copilot"
  | "Cline"
  | "Qwen Code"
  | "OpenAI-compatible"
  | "Anthropic-compatible"
  | "Azure AI Foundry"
  | "OpenAI Image"
  | "Gemini Image" {
  if (driverKind === "opencode") return "OpenCode";
  if (driverKind === "codex") return "Codex";
  if (driverKind === "claude") return "Claude";
  if (driverKind === "kimi-code") return "Kimi Code";
  if (driverKind === "devin") return "Devin";
  if (driverKind === "kilo") return "Kilo";
  if (driverKind === "pi") return "Pi";
  if (driverKind === "oh-my-pi") return "Oh My Pi";
  if (driverKind === "ollama") return "Ollama";
  if (driverKind === "mistral-vibe") return "Mistral Vibe";
  if (driverKind === "grok") return "Grok Build";
  if (driverKind === "goose") return "Goose";
  if (driverKind === "glm") return "GLM Agent ACP";
  if (driverKind === "gemini") return "Gemini CLI";
  if (driverKind === "copilot") return "GitHub Copilot";
  if (driverKind === "cline") return "Cline";
  if (driverKind === "qwen") return "Qwen Code";
  if (driverKind === "anthropic-compatible") return "Anthropic-compatible";
  if (driverKind === "azure-foundry") return "Azure AI Foundry";
  if (driverKind === "openai-image") return "OpenAI Image";
  if (driverKind === "gemini-native-image") return "Gemini Image";
  return "OpenAI-compatible";
}

export function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).replaceAll("-", " ");
}

export function providerConfiguredBinaryPath(instance: ProviderInstance): string | undefined {
  return "binaryPath" in instance.configuration ? instance.configuration.binaryPath : undefined;
}

export function providerAuthenticationFact(instance: ProviderInstance): string | undefined {
  const { configuration, driverKind } = instance;
  if (!("authentication" in configuration)) return undefined;
  if (driverKind === "claude") {
    return configuration.authentication === "api-key" ? "Anthropic API key" : "Claude subscription";
  }
  return titleCase(configuration.authentication);
}

/** Authoritative probe message, binary, version, auth, and capability confirmation. */
export function incompatibleReadinessFacts(
  instance: ProviderInstance,
  observed: ProviderObservedState | undefined,
): ReadonlyArray<{ readonly label: string; readonly value: string }> {
  const binaryPath = providerConfiguredBinaryPath(instance);
  const authentication = providerAuthenticationFact(instance);
  const capabilities = observed?.capabilities;
  const confirmed =
    capabilities === undefined
      ? []
      : capabilityLabels.filter(([key]) => capabilities[key] === "supported");
  const refused =
    capabilities === undefined
      ? []
      : capabilityLabels.filter(([key]) => capabilities[key] === "unsupported");
  const capabilityMismatch =
    confirmed.length === 0
      ? "Not confirmed"
      : refused.length === 0
        ? "None reported"
        : refused.map(([, label]) => label).join(", ");
  return [
    {
      label: "Host check",
      value: observed?.message ?? "No host incompatibility detail was recorded.",
    },
    ...(binaryPath === undefined ? [] : [{ label: "Binary", value: binaryPath }]),
    { label: "Version", value: observed?.detectedVersion ?? "Unavailable" },
    ...(authentication === undefined ? [] : [{ label: "Authentication", value: authentication }]),
    { label: "Capabilities", value: capabilityMismatch },
  ];
}

export function formatProbeTimestamp(value: string): string {
  return probeTimestampFormatter.format(new Date(value));
}
