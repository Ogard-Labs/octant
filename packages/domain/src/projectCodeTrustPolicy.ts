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
 * the Project's trust. Mistral Vibe's `.vibe` entries stay unreadable until
 * the Project is trusted. Codex and OpenCode list nothing: Octant's trust
 * loads none of their Project configuration (Codex's own folder trust decides
 * it, and OpenCode's launch keeps Project configuration off at every level),
 * so a prompt to trust for them would promise something that does not
 * happen.
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
  codex: [],
  opencode: [],
  "mistral-vibe": [
    { path: ".vibe/config.toml", kind: "settings" },
    { path: ".vibe/hooks.toml", kind: "hooks" },
    { path: ".vibe/plugins", kind: "plugins" },
    { path: ".vibe/tools", kind: "tools" },
    { path: ".vibe/agents", kind: "agents" },
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
