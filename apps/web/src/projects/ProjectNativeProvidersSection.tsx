import type { ProjectSummary } from "@octant/contracts/projects";
import {
  KEY_PROVIDER_DRIVER_KINDS,
  type KeyProviderDriverKind,
  type KeyProviderDriverKinds,
} from "@octant/contracts/providers";
import { useState } from "react";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";

type BoundProjectSummary = Extract<ProjectSummary, { readonly type: "work" | "code" }>;

export interface ProjectNativeProvidersSectionProps {
  readonly project: BoundProjectSummary;
  readonly onChange: (providers: KeyProviderDriverKinds) => Promise<boolean>;
  readonly disabled?: boolean;
}

const PROVIDER_NAMES: Readonly<Record<KeyProviderDriverKind, string>> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  "mistral-vibe": "Mistral Vibe",
};

/**
 * Which key providers this Project trusts to run as themselves here: each
 * one checked loads its own setup in this Project's threads and the
 * Project's own settings, hooks, MCP servers, plugins, and tools, at every
 * level but Plan. Unchecked, a provider loads none of the Project's code,
 * even at Full access. Only a window on this host can change it.
 */
export function ProjectNativeProvidersSection(props: ProjectNativeProvidersSectionProps) {
  const trusted = new Set(props.project.nativeProviders ?? []);
  // Each command asserts the Project version it read, so a second change sent
  // before the first returns would be refused as stale; the boxes wait.
  const [pending, setPending] = useState(false);
  const disabled = props.disabled === true || pending;

  async function toggle(kind: KeyProviderDriverKind): Promise<void> {
    const next = new Set(trusted);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    setPending(true);
    try {
      await props.onChange(KEY_PROVIDER_DRIVER_KINDS.filter((candidate) => next.has(candidate)));
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      aria-labelledby={`native-providers-${props.project.id}`}
      className="project-provider-policy"
    >
      <div className="project-provider-policy__header">
        <div>
          <h2 id={`native-providers-${props.project.id}`}>Trusted providers</h2>
          <p>
            A provider you trust here runs in this {props.project.type} Project as it runs on its
            own: its own subagents, web search, skills, and setup, plus this Project’s own settings,
            hooks, MCP servers, and plugins. That code runs under the provider’s sandbox and the
            thread’s mode, without an Octant review. Plan stays read-only.
          </p>
        </div>
        <span className="project-provider-policy__default">Default: none</span>
      </div>
      <div className="project-provider-policy__providers" aria-label="Trusted providers">
        {KEY_PROVIDER_DRIVER_KINDS.map((kind) => (
          <label className="project-provider-policy__provider" key={kind}>
            <OctantCheckbox
              checked={trusted.has(kind)}
              disabled={disabled}
              onChange={() => void toggle(kind)}
            />
            <span>{PROVIDER_NAMES[kind]}</span>
          </label>
        ))}
      </div>
    </section>
  );
}
