import { useCallback, useEffect, useState } from "react";
import {
  MAX_AGENT_RUN_CONCURRENCY,
  effectiveAgentRunConcurrency,
  type AgentRunConcurrency,
  type AgentRunPolicySettings,
  type AgentRunSelectableCreationPosture,
} from "@octant/contracts";
import {
  AgentRunSettingsClientFailure,
  type AgentRunSettingsClient,
} from "@octant/client-runtime/agent-run-settings-client";
import { SettingRow, SettingsSection } from "../settings/primitives";
import { OctantNumberStepper } from "../ui/base/OctantNumberStepper";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import "./agent-hierarchy.css";
import { OctantAlert } from "../ui/base/OctantAlert";

// The description says what the choice does, not what it was meant to do.
// Helper agents start only when the thread's agent delegates part of its work,
// so Off is the only way to hold them back; there is no manual start to fall
// back on.
const DESCRIPTION: Readonly<Record<AgentRunSelectableCreationPosture, string>> = {
  automatic:
    "The agent can hand part of its work to a helper and get the result back. Helpers never have more access than their thread.",
  off: "When off, the agent does all the work itself. Helpers it already started stay viewable.",
};

/**
 * Settings → Octant Harness › Helper agents: whether the thread's agent may
 * start helper agents, as the server-authoritative Off / Automatic posture. Reads
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
          : "Helper agent settings are unavailable.",
      );
      setStatus("error");
    }
  }, [props.client]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (change: {
      readonly creationPosture: AgentRunSelectableCreationPosture;
      readonly concurrency?: AgentRunConcurrency;
    }) => {
      if (settings === undefined || saving) return;
      setSaving(true);
      setMessage(undefined);
      try {
        const updated = await props.client.update({
          ...change,
          expectedVersion: settings.version,
        });
        setSettings(updated);
      } catch (error) {
        if (error instanceof AgentRunSettingsClientFailure && error.code === "conflict") {
          setMessage("Helper agent settings changed elsewhere. Reloaded the current settings.");
          await load();
        } else {
          setMessage(
            error instanceof AgentRunSettingsClientFailure
              ? error.message
              : "Saving helper agent settings failed.",
          );
        }
      } finally {
        setSaving(false);
      }
    },
    [props.client, settings, saving, load],
  );
  // The host reads a stored Ask as Off, so anything but Automatic is Off.
  const posture: AgentRunSelectableCreationPosture =
    settings?.creationPosture === "automatic" ? "automatic" : "off";
  const choose = useCallback(
    (next: AgentRunSelectableCreationPosture) => save({ creationPosture: next }),
    [save],
  );
  const setLimit = useCallback(
    (key: keyof AgentRunConcurrency, value: number) => {
      if (settings === undefined) return;
      const current = effectiveAgentRunConcurrency(settings);
      if (current[key] === value) return;
      void save({ creationPosture: posture, concurrency: { ...current, [key]: value } });
    },
    [posture, save, settings],
  );

  if (status === "loading") {
    return <p role="status">Loading helper agent settings…</p>;
  }
  if (status === "error") {
    return (
      <OctantAlert className="agent-run-settings-panel__error" tone="danger">
        {message ?? "Helper agent settings are unavailable."}
      </OctantAlert>
    );
  }

  const on = posture === "automatic";
  const limits = effectiveAgentRunConcurrency(settings ?? {});

  return (
    <section aria-label="Helper agents" className="agent-run-settings-panel">
      <SettingsSection title="Helper agents">
        <div className="setgroup">
          <SettingRow
            description={DESCRIPTION[on ? "automatic" : "off"]}
            label="Let the agent start helper agents"
            focused={props.focused === true}
            scope="app"
            settingId="subagent-creation-posture"
          >
            <OctantSwitch
              checked={on}
              disabled={saving}
              label="Let the agent start helper agents"
              onCheckedChange={(checked) => void choose(checked ? "automatic" : "off")}
            />
          </SettingRow>
          <SettingRow
            description="How many helper agents of one thread run at the same time. Helpers that are only waiting don't count."
            label="At once in one thread"
            scope="app"
            settingId="subagent-concurrency-per-thread"
          >
            <OctantNumberStepper
              label="At once in one thread"
              max={MAX_AGENT_RUN_CONCURRENCY}
              min={1}
              onChange={(value) => setLimit("perThread", value)}
              value={limits.perThread}
            />
          </SettingRow>
          <SettingRow
            description="How many helper agents run at the same time, every thread together."
            label="At once across Octant"
            scope="app"
            settingId="subagent-concurrency-on-host"
          >
            <OctantNumberStepper
              label="At once across Octant"
              max={MAX_AGENT_RUN_CONCURRENCY}
              min={1}
              onChange={(value) => setLimit("onHost", value)}
              value={limits.onHost}
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
