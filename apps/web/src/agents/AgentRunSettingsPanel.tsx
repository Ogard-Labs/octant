import { useCallback, useEffect, useState } from "react";
import type { AgentRunCreationPosture } from "@octant/contracts/agent-run";
import type { AgentRunPolicySettings } from "@octant/contracts";
import {
  AgentRunSettingsClientFailure,
  type AgentRunSettingsClient,
} from "@octant/client-runtime/agent-run-settings-client";
import { SettingRow } from "../settings/primitives";
import { OctantSelectField } from "../ui/base/OctantSelect";
import "./agent-hierarchy.css";

const POSTURES: ReadonlyArray<{
  readonly value: AgentRunCreationPosture;
  readonly label: string;
  readonly description: string;
}> = [
  // The descriptions say what each choice does, not what it was meant to
  // do: under Ask a person starting a helper from the Agents dock is the
  // confirmation (there is no separate prompt), and only the Harness model's
  // delegate tool is refused.
  {
    value: "off",
    label: "Off",
    description:
      "Nobody can start a helper agent, including Add agent in the Agents dock. Existing ones stay viewable.",
  },
  {
    value: "ask",
    label: "Only when I start them",
    description:
      "You start helpers from the Agents dock. The model can suggest one but cannot start it.",
  },
  {
    value: "automatic",
    label: "Automatically",
    description:
      "The model can start helpers on its own, within the thread's access and capacity limits.",
  },
];

/**
 * Settings → Octant Harness › Helper agents: server-authoritative Off / Ask /
 * Automatic creation posture. Reads and writes go straight through
 * `AgentRunSettingsClient`; there is no local override or cache that could
 * drift from the server's own event-sourced state.
 */
export function AgentRunSettingsPanel(props: { readonly client: AgentRunSettingsClient }) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [settings, setSettings] = useState<AgentRunPolicySettings>();
  const [message, setMessage] = useState<string>();
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setStatus((current) => (current === "ready" ? current : "loading"));
    try {
      const current = await props.client.current();
      setSettings(current);
      setStatus("ready");
    } catch (error) {
      setMessage(
        error instanceof AgentRunSettingsClientFailure
          ? error.message
          : "Agents settings are unavailable.",
      );
      setStatus("error");
    }
  }, [props.client]);

  useEffect(() => {
    void load();
  }, [load]);

  const choose = useCallback(
    async (posture: AgentRunCreationPosture) => {
      if (settings === undefined || saving) return;
      setSaving(true);
      setMessage(undefined);
      try {
        const updated = await props.client.update({
          creationPosture: posture,
          expectedVersion: settings.version,
        });
        setSettings(updated);
      } catch (error) {
        if (error instanceof AgentRunSettingsClientFailure && error.code === "conflict") {
          setMessage("Agents settings changed elsewhere. Reloading the current policy.");
          await load();
        } else {
          setMessage(
            error instanceof AgentRunSettingsClientFailure
              ? error.message
              : "The Agents policy update failed.",
          );
        }
      } finally {
        setSaving(false);
      }
    },
    [props.client, settings, saving, load],
  );

  if (status === "loading") {
    return <p role="status">Loading the Agents policy…</p>;
  }
  if (status === "error") {
    return (
      <p className="agent-run-settings-panel__error" role="alert">
        {message ?? "Agents settings are unavailable."}
      </p>
    );
  }

  const current =
    POSTURES.find((posture) => posture.value === settings?.creationPosture) ?? POSTURES[1];

  return (
    <section aria-label="Agents" className="agent-run-settings-panel">
      <div className="settings-card-section settings-card-section--open">
        <h2>Helper agents</h2>
        <div className="setgroup">
          <SettingRow
            description={current?.description}
            label="Let the model start helper agents"
            scope="app"
            settingId="subagent-creation-posture"
          >
            <OctantSelectField
              aria-label="Let the model start helper agents"
              disabled={saving}
              onValueChange={(value) => {
                const posture = POSTURES.find((entry) => entry.value === value);
                if (posture !== undefined && posture.value !== settings?.creationPosture) {
                  void choose(posture.value);
                }
              }}
              options={POSTURES.map((posture) => ({ id: posture.value, label: posture.label }))}
              value={current?.value ?? "ask"}
            />
          </SettingRow>
        </div>
        {message === undefined ? null : (
          <p className="agent-run-settings-panel__message" role="status">
            {message}
          </p>
        )}
      </div>
    </section>
  );
}
