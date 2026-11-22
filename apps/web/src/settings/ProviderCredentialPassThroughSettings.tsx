import { ACP_AGENT_KINDS, acpAgentProfile } from "@octant/contracts/acp-agent-profiles";
import { hostCredentialPassThroughRefusal } from "@octant/domain";
import { useId, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantFieldError } from "../ui/base/OctantField";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { SettingRow, SettingsCompactRow, SettingsSection, SettingsState } from "./primitives";

export type ProviderCredentialPassThrough = Readonly<Record<string, ReadonlyArray<string>>>;

export interface ProviderCredentialPassThroughSettingsProps {
  readonly value: ProviderCredentialPassThrough;
  readonly onChange: (next: ProviderCredentialPassThrough) => void;
  readonly focusedSetting?: string | undefined;
}

/**
 * The providers whose launch outside Strict keeps unrelated host credentials
 * out, by driver kind: the runtimes whose environment Octant builds from the
 * host's. OpenCode is not offered: its launch does not strip them yet.
 */
const PROVIDERS: ReadonlyArray<{ readonly id: string; readonly label: string }> = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "pi", label: "Pi" },
  ...ACP_AGENT_KINDS.map((kind) => ({ id: kind, label: acpAgentProfile(kind).name })),
  { id: "acp-agent", label: "Added ACP agents" },
];

const LABEL: ReadonlyMap<string, string> = new Map(PROVIDERS.map(({ id, label }) => [id, label]));

/** What the section says the list does, in the person's words. */
export const PROVIDER_CREDENTIAL_PASS_THROUGH_FACT =
  "Outside Strict, a provider does not get credentials from your environment that are not its own, such as GH_TOKEN, GITHUB_TOKEN, NPM_TOKEN, AWS keys and other services' API keys. Name one here to let it through to one provider. Strict ignores this list. Applies from the next turn.";

/**
 * Settings › Providers & Models › Credentials let through. Empty until the
 * person adds a name; only names are kept, never values.
 */
export function ProviderCredentialPassThroughSettings(
  props: ProviderCredentialPassThroughSettingsProps,
) {
  const ids = useId();
  const [provider, setProvider] = useState("claude");
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string>();

  const entries = Object.entries(props.value).flatMap(([id, names]) =>
    names.map((name) => ({ id, name })),
  );

  function change(id: string, names: ReadonlyArray<string>) {
    const next: Record<string, ReadonlyArray<string>> = { ...props.value };
    if (names.length === 0) delete next[id];
    else next[id] = names;
    props.onChange(next);
  }

  function add() {
    const name = draft.trim();
    if (name === "") return;
    const refusal = hostCredentialPassThroughRefusal(name);
    if (refusal !== undefined) {
      setProblem(refusal);
      return;
    }
    setProblem(undefined);
    const current = props.value[provider] ?? [];
    if (!current.includes(name)) change(provider, [...current, name]);
    setDraft("");
  }

  return (
    <SettingsSection
      description={PROVIDER_CREDENTIAL_PASS_THROUGH_FACT}
      title="Credentials let through"
    >
      <div className="setgroup">
        {entries.length === 0 ? (
          <SettingsState kind="empty">
            Nothing is let through. Each provider keeps only its own credentials.
          </SettingsState>
        ) : (
          entries.map((entry, index) => {
            const label = LABEL.get(entry.id) ?? entry.id;
            return (
              <SettingsCompactRow
                focused={props.focusedSetting === "provider-credential-pass-through" && index === 0}
                key={`${entry.id}:${entry.name}`}
                label={entry.name}
                labelWraps
                meta={`${label} · Let through`}
                settingId="provider-credential-pass-through"
              >
                <OctantButton
                  aria-label={`Stop letting ${entry.name} through to ${label}`}
                  onClick={() =>
                    change(
                      entry.id,
                      (props.value[entry.id] ?? []).filter((name) => name !== entry.name),
                    )
                  }
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  Remove
                </OctantButton>
              </SettingsCompactRow>
            );
          })
        )}
        <SettingRow
          description="The variable's name as your environment has it, such as GH_TOKEN for an agent that runs gh."
          htmlFor={`${ids}-name`}
          label="Let a credential through"
          scope="host"
          settingId="provider-credential-pass-through-add"
        >
          <form
            className="protected-files__add"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              add();
            }}
          >
            <OctantSelectField
              aria-label="Provider"
              id={`${ids}-provider`}
              onValueChange={(value) => {
                if (LABEL.has(value)) setProvider(value);
              }}
              options={PROVIDERS}
              value={provider}
            />
            <OctantInput
              aria-label="Variable to let through"
              className="settings-view__text-input"
              id={`${ids}-name`}
              onChange={(event) => setDraft(event.currentTarget.value)}
              placeholder="GH_TOKEN"
              type="text"
              value={draft}
            />
            <OctantButton disabled={draft.trim() === ""} size="sm" type="submit">
              Let through
            </OctantButton>
          </form>
        </SettingRow>
      </div>
      <div className="settings-feedback-slot" aria-live="polite">
        {problem === undefined ? null : (
          <OctantFieldError className="settings-section-line">{problem}</OctantFieldError>
        )}
      </div>
    </SettingsSection>
  );
}
