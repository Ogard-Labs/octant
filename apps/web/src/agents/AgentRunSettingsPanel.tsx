import { useCallback, useEffect, useState } from "react";
import type { AgentRunPolicySettings, AgentRunSelectableCreationPosture } from "@octant/contracts";
import {
  AgentRunSettingsClientFailure,
  type AgentRunSettingsClient,
} from "@octant/client-runtime/agent-run-settings-client";
import { SettingRow, SettingsSection } from "../settings/primitives";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import "./agent-hierarchy.css";

// The description says what the choice does, not what it was meant to do.
// Subagents start only when the thread's agent delegates part of its work, so
// Off is the only way to hold them back; there is no manual start to fall
// back on.
const DESCRIPTION: Readonly<Record<AgentRunSelectableCreationPosture, string>> = {
  automatic:
    "The agent can hand part of its work to a subagent and gets the result back, within the thread's access and capacity limits.",
  off: "The agent does all of its work itself. Subagents it already started stay viewable.",
};

/**
 * Settings → Octant Harness › Helper agents: whether the thread's agent may
 * start subagents, as the server-authoritative Off / Automatic posture. Reads
 * and writes go straight through `AgentRunSettingsClient`; there is no local
 * override or cache that could drift from the server's own event-sourced
 * state.
 */
export function AgentRunSettingsPanel(props: {
  readonly client: AgentRunSettingsClient;
  /** A search result or link named this setting: land on its control. */
  readonly focused?: boolean;
}) {
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
    async (posture: AgentRunSelectableCreationPosture) => {
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

  // The host reads a stored Ask as Off, so anything but Automatic is Off.
  const on = settings?.creationPosture === "automatic";

  return (
    <section aria-label="Agents" className="agent-run-settings-panel">
      <SettingsSection title="Helper agents">
        <div className="setgroup">
          <SettingRow
            description={DESCRIPTION[on ? "automatic" : "off"]}
            label="Let the agent start subagents"
            focused={props.focused === true}
            scope="app"
            settingId="subagent-creation-posture"
          >
            <OctantSwitch
              checked={on}
              disabled={saving}
              label="Let the agent start subagents"
              onCheckedChange={(checked) => void choose(checked ? "automatic" : "off")}
            />
          </SettingRow>
        </div>
        {message === undefined ? null : (
          <p className="agent-run-settings-panel__message" role="status">
            {message}
          </p>
        )}
      </SettingsSection>
    </section>
  );
}
