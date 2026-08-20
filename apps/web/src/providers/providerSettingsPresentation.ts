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
  | "OpenAI-compatible"
  | "Anthropic-compatible"
  | "Azure AI Foundry" {
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
  if (driverKind === "anthropic-compatible") return "Anthropic-compatible";
  if (driverKind === "azure-foundry") return "Azure AI Foundry";
  return "OpenAI-compatible";
}

export function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).replaceAll("-", " ");
}

export function formatProbeTimestamp(value: string): string {
  return probeTimestampFormatter.format(new Date(value));
}
