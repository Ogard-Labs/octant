import { useCallback, useEffect, useState } from "react";
import type { AgentRunCreationPosture } from "@octant/contracts/agent-run";
import type { AgentRunPolicySettings } from "@octant/contracts";
import {
  AgentRunSettingsClientFailure,
  type AgentRunSettingsClient,
} from "@octant/client-runtime/agent-run-settings-client";
import { OctantButton } from "../ui/base/OctantButton";
import "./agent-hierarchy.css";

const POSTURES: ReadonlyArray<{
  readonly value: AgentRunCreationPosture;
  readonly label: string;
  readonly description: string;
}> = [
  {
    value: "off",
    label: "Off",
    description: "No child runs can be created. Existing hierarchy stays viewable.",
  },
  {
    value: "ask",
    label: "Ask",
    description: "Every child creation requires an explicit, human-initiated request.",
  },
  {
    value: "automatic",
    label: "Automatic",
    description:
      "Child creation requests are admitted without a separate confirmation step, still bounded by authority ceilings and capacity limits.",
  },
];

/**
 * Settings → Agents panel: server-authoritative Off / Ask /
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

  return (
    <section aria-label="Agents" className="agent-run-settings-panel">
      <fieldset>
        <legend>Subagent creation posture</legend>
        {message === undefined ? null : (
          <p className="agent-run-settings-panel__message" role="status">
            {message}
          </p>
        )}
        <div aria-label="Subagent creation posture" role="radiogroup">
          {POSTURES.map((posture) => (
            <OctantButton
              aria-checked={settings?.creationPosture === posture.value}
              className="agent-run-settings-panel__option"
              disabled={saving}
              key={posture.value}
              onClick={() => void choose(posture.value)}
              role="radio"
              type="button"
              variant="ghost"
            >
              <span>
                <strong>{posture.label}</strong>
                <span className="agent-run-settings-panel__option-description">
                  {posture.description}
                </span>
              </span>
            </OctantButton>
          ))}
        </div>
      </fieldset>
    </section>
  );
}
