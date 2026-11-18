import type { ProjectCodeKind, ThreadProjectCode } from "@octant/contracts/thread-native-setup";
import type { KeyProviderDriverKind, ProviderDriverKind } from "@octant/contracts/providers";
import { isKeyProviderDriverKind } from "./providerNativeSetupPolicy";

export interface ProjectCodeEntry {
  /** Relative to the Project root, with `/` separators. */
  readonly path: string;
  readonly kind: ProjectCodeKind;
}

/**
 * The entries at a Project root that each key provider loads as the
 * Project's own code only once the person trusts the Project for it: the same
 * entries its driver keeps out until then.
 *
 * Claude Code reads a Project's settings and skills only through its
 * `project` and `local` setting sources, and starts a Project's `.mcp.json`
 * servers only without `strictMcpConfig`; Octant turns both on only with
 * the Project's trust. OpenCode loads its Project `opencode.json(c)` files and
 * the `.opencode` agents, commands, plugins, and tools only once
 * `OPENCODE_DISABLE_PROJECT_CONFIG` is lifted, which happens only with the
 * Project's trust and outside Plan (maintainer decision, 2026-11-14). Codex
 * lists nothing: Octant's trust loads none of its Project configuration
 * (Codex's own folder trust decides it), so a prompt to trust for it would
 * promise something that does not happen.
 *
 * Each ACP agent lists the Project entries its launch keeps unreadable, or
 * refuses the Project over, until the Project is trusted for it
 * (`forbiddenRootEntries` and `refusesProject` in its server profile), so the
 * one trust prompt names everything the trust then loads (maintainer
 * decision, 2026-11-14). Grok Build's own folder trust list stays hidden until
 * then; `.grok` and `.claude/plugins` are what that list would admit.
 */
export const PROJECT_CODE_ENTRIES: Readonly<
  Record<KeyProviderDriverKind, ReadonlyArray<ProjectCodeEntry>>
> = {
  claude: [
    { path: ".claude/settings.json", kind: "settings" },
    { path: ".claude/settings.local.json", kind: "settings" },
    { path: ".mcp.json", kind: "mcp-servers" },
    { path: ".claude/skills", kind: "skills" },
  ],
  codex: [{ path: ".codex/config.toml", kind: "settings" }],
  opencode: [
    { path: "opencode.jsonc", kind: "settings" },
    { path: "opencode.json", kind: "settings" },
    { path: ".opencode/opencode.jsonc", kind: "settings" },
    { path: ".opencode/opencode.json", kind: "settings" },
    { path: ".opencode/agent", kind: "agents" },
    { path: ".opencode/agents", kind: "agents" },
    { path: ".opencode/command", kind: "commands" },
    { path: ".opencode/commands", kind: "commands" },
    { path: ".opencode/plugin", kind: "plugins" },
    { path: ".opencode/plugins", kind: "plugins" },
    { path: ".opencode/tool", kind: "tools" },
    { path: ".opencode/tools", kind: "tools" },
  ],
  "mistral-vibe": [
    { path: ".vibe/config.toml", kind: "settings" },
    { path: ".vibe/hooks.toml", kind: "hooks" },
    { path: ".vibe/plugins", kind: "plugins" },
    { path: ".vibe/tools", kind: "tools" },
    { path: ".vibe/agents", kind: "agents" },
  ],
  kilo: [
    { path: ".kilo/mcp.json", kind: "mcp-servers" },
    { path: ".kilocode/mcp.json", kind: "mcp-servers" },
  ],
  devin: [
    { path: ".agents/skills", kind: "skills" },
    { path: ".cognition/skills", kind: "skills" },
    { path: ".devin/config.json", kind: "settings" },
    { path: ".devin/config.local.json", kind: "settings" },
    { path: ".devin/hooks.json", kind: "hooks" },
    { path: ".devin/hooks.v1.json", kind: "hooks" },
    { path: ".devin/mcp_config.json", kind: "mcp-servers" },
    { path: ".devin/mcp_config.local.json", kind: "mcp-servers" },
    { path: ".devin/skills", kind: "skills" },
  ],
  "kimi-code": [
    { path: ".kimi-code", kind: "settings" },
    { path: ".agents", kind: "skills" },
    { path: ".mcp.json", kind: "mcp-servers" },
  ],
  grok: [
    { path: ".grok", kind: "settings" },
    { path: ".claude/plugins", kind: "plugins" },
  ],
  goose: [
    { path: ".agents/plugins", kind: "plugins" },
    { path: ".agents/skills", kind: "skills" },
    { path: ".claude/skills", kind: "skills" },
    { path: ".goose/skills", kind: "skills" },
  ],
  glm: [{ path: ".claude/skills", kind: "skills" }],
  gemini: [
    { path: ".gemini/settings.json", kind: "settings" },
    { path: ".gemini/agents", kind: "agents" },
    { path: ".gemini/extensions", kind: "plugins" },
    { path: ".agents/skills", kind: "skills" },
    { path: ".gemini/skills", kind: "skills" },
  ],
  copilot: [
    { path: ".agents/skills", kind: "skills" },
    { path: ".claude/settings.json", kind: "settings" },
    { path: ".claude/settings.local.json", kind: "settings" },
    { path: ".claude/skills", kind: "skills" },
    { path: ".github/agents", kind: "agents" },
    { path: ".github/copilot/settings.json", kind: "settings" },
    { path: ".github/copilot/settings.local.json", kind: "settings" },
    { path: ".github/extensions", kind: "plugins" },
    { path: ".github/hooks", kind: "hooks" },
    { path: ".github/lsp.json", kind: "tools" },
    { path: ".github/mcp.json", kind: "mcp-servers" },
    { path: ".github/skills", kind: "skills" },
    { path: ".mcp.json", kind: "mcp-servers" },
  ],
  cline: [
    { path: ".agents/skills", kind: "skills" },
    { path: ".claude/skills", kind: "skills" },
    { path: ".cline/hooks", kind: "hooks" },
    { path: ".cline/plugins", kind: "plugins" },
    { path: ".cline/skills", kind: "skills" },
    { path: ".clinerules/hooks", kind: "hooks" },
    { path: ".clinerules/skills", kind: "skills" },
  ],
  qwen: [
    { path: ".qwen/settings.json", kind: "settings" },
    { path: ".qwen/agents", kind: "agents" },
    { path: ".qwen/extensions", kind: "plugins" },
    { path: ".mcp.json", kind: "mcp-servers" },
    { path: ".agents/skills", kind: "skills" },
    { path: ".qwen/skills", kind: "skills" },
  ],
  fx: [
    { path: ".fx.json", kind: "settings" },
    { path: ".mcp.json", kind: "mcp-servers" },
    { path: ".agents", kind: "skills" },
    { path: ".claude/skills", kind: "skills" },
  ],
};

/** The entries to look for at the Project root; none for a provider that is not a key provider. */
export function projectCodeEntries(
  driverKind: ProviderDriverKind,
): ReadonlyArray<ProjectCodeEntry> {
  return isKeyProviderDriverKind(driverKind) ? PROJECT_CODE_ENTRIES[driverKind] : [];
}

export interface ProjectCodeTrustInput {
  readonly driverKind: ProviderDriverKind;
  readonly projectType: "chat" | "work" | "code";
  /** The Project lists this provider in `nativeProviders`. */
  readonly trusted: boolean;
  /** Which of `projectCodeEntries(driverKind)` paths exist at the Project root. */
  readonly present: ReadonlyArray<string>;
}

/**
 * Whether a thread's Project holds its provider's own Project code, and
 * whether the Project trusts that provider to load it. Untrusted is the one
 * answer that asks the person: the person's own setup loads everywhere, and a
 * Project's own code loads after one trust per Project and provider
 * (maintainer decision, 2026-11-14), as the providers' own folder-trust
 * prompts ask.
 */
export function projectCodeTrust(input: ProjectCodeTrustInput): ThreadProjectCode {
  if (input.projectType === "chat" || !isKeyProviderDriverKind(input.driverKind)) {
    return { status: "none" };
  }
  const present = new Set(input.present);
  const found: ProjectCodeKind[] = [];
  for (const entry of PROJECT_CODE_ENTRIES[input.driverKind]) {
    if (present.has(entry.path) && !found.includes(entry.kind)) found.push(entry.kind);
  }
  const [first, ...rest] = found;
  if (first === undefined) return { status: "none" };
  return {
    status: input.trusted ? "trusted" : "untrusted",
    provider: input.driverKind,
    found: [first, ...rest],
  };
}
