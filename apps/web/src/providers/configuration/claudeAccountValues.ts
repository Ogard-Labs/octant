import type {
  ClaudeAccountAccent,
  ClaudeAuthentication,
  ClaudeProviderConfiguration,
} from "@octant/contracts";
import { CLAUDE_ACCOUNT_ACCENT_VALUES } from "@octant/domain";

export const CLAUDE_ACCOUNT_ACCENT_LABELS: Readonly<Record<ClaudeAccountAccent, string>> = {
  rust: "Rust",
  gold: "Gold",
  green: "Green",
  teal: "Teal",
  blue: "Blue",
  violet: "Violet",
  rose: "Rose",
};

export function parseClaudeAccountAccent(value: string): ClaudeAccountAccent | undefined {
  return CLAUDE_ACCOUNT_ACCENT_VALUES.find((accent) => accent === value);
}

export function claudeConfigurationFromFields(input: {
  readonly binaryPath: string;
  readonly authentication: ClaudeAuthentication;
  readonly configDirectory: string;
  readonly accent: string;
}): ClaudeProviderConfiguration {
  const configDirectory = input.configDirectory.trim();
  const accent = parseClaudeAccountAccent(input.accent.trim());
  return {
    kind: "claude-agent-sdk",
    binaryPath: input.binaryPath,
    authentication: input.authentication,
    ...(configDirectory.length === 0 ? {} : { configDirectory }),
    ...(accent === undefined ? {} : { accent }),
  };
}
