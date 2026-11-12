import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_HOST_RESOURCE_POLICY,
  type AgentRunPolicySettings,
  type HostResourceBudgetSnapshot,
  type HostResourcePolicy,
} from "@octant/contracts";
import {
  AgentRunSettingsClientFailure,
  type AgentRunSettingsClient,
} from "@octant/client-runtime/agent-run-settings-client";
import { SettingRow, SettingsSection } from "./primitives";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantNumberStepper } from "../ui/base/OctantNumberStepper";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { OctantAlert } from "../ui/base/OctantAlert";

const REASONS: Readonly<Record<HostResourceBudgetSnapshot["reason"], string>> = {
  ready: "Capacity is available.",
  "cpu-pressure": "Waiting for CPU capacity. Other apps count toward this limit.",
  "memory-pressure": "Waiting for memory capacity. Other apps count toward this limit.",
  paused: "New managed work is paused. Running work can finish.",
  unavailable: "Load readings are incomplete. Using conservative limits.",
  recovering: "Waiting for load to stay low before starting more work.",
};

export function HostResourceSettings({
  client,
  focusedSetting,
}: {
  readonly client: AgentRunSettingsClient;
  readonly focusedSetting?: string;
}) {
  const [settings, setSettings] = useState<AgentRunPolicySettings>();
  const [draft, setDraft] = useState<HostResourcePolicy>(DEFAULT_HOST_RESOURCE_POLICY);
  const [snapshot, setSnapshot] = useState<HostResourceBudgetSnapshot>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const refresh = useCallback(async () => {
    try {
      const result = await client.resources?.();
      if (mounted.current) setSnapshot(result);
    } catch {
      if (mounted.current) setSnapshot(undefined);
    }
  }, [client]);
  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const current = await client.current();
      if (!mounted.current) return;
      setSettings(current);
      setDraft(current.resourcePolicy ?? DEFAULT_HOST_RESOURCE_POLICY);
      await refresh();
    } catch {
      if (mounted.current) setError("Computer resource settings are unavailable.");
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [client, refresh]);
  useEffect(() => {
    void load();
  }, [load]);
  const save = async (policy: HostResourcePolicy) => {
    if (settings === undefined || saving) return;
    setSaving(true);
    setError(undefined);
    try {
      const current = await client.update({
        creationPosture: settings.creationPosture === "automatic" ? "automatic" : "off",
        resourcePolicy: policy,
        expectedVersion: settings.version,
      });
      if (!mounted.current) return;
      setSettings(current);
      setDraft(current.resourcePolicy ?? DEFAULT_HOST_RESOURCE_POLICY);
      await refresh();
    } catch (failure) {
      if (!mounted.current) return;
      if (failure instanceof AgentRunSettingsClientFailure && failure.code === "conflict") {
        await load();
        setError("Settings changed elsewhere. Review the current limits and try again.");
      } else setError("Could not save the limits. Your change has not been applied.");
    } finally {
      if (mounted.current) setSaving(false);
    }
  };
  if (loading) return <p role="status">Loading computer resource settings…</p>;
  if (settings === undefined)
    return (
      <OctantAlert tone="danger">
        {error}
        <OctantButton onClick={() => void load()}>Retry</OctantButton>
      </OctantAlert>
    );
  const paused = (settings.resourcePolicy ?? DEFAULT_HOST_RESOURCE_POLICY).mode === "paused";
  const limits: ReadonlyArray<{
    readonly key:
      | "maxCommands"
      | "maxWorkers"
      | "maxAgents"
      | "cpuTargetPercent"
      | "memoryReservePercent";
    readonly label: string;
    readonly description: string;
    readonly min: number;
    readonly max: number;
  }> = [
    {
      key: "maxCommands",
      label: "Concurrent commands",
      description:
        "Maximum managed command groups across all Projects. The shared worker budget may allow fewer.",
      min: 1,
      max: 16,
    },
    {
      key: "maxWorkers",
      label: "Total test workers",
      description:
        "Shared worker budget for managed commands. Supported Vitest versions inherit their allocation.",
      min: 1,
      max: 16,
    },
    {
      key: "maxAgents",
      label: "Helper agents",
      description: "Maximum Octant-managed helpers across the host. Per-thread limits still apply.",
      min: 1,
      max: 16,
    },
    {
      key: "cpuTargetPercent",
      label: "CPU target (%)",
      description:
        "Automatic mode leaves the remaining CPU capacity for other local work. This is an admission target, not a CPU cap.",
      min: 20,
      max: 90,
    },
    {
      key: "memoryReservePercent",
      label: "Memory reserve (%)",
      description:
        "Automatic mode leaves this share of RAM available, with at least 1 GiB reserved.",
      min: 10,
      max: 50,
    },
  ];
  return (
    <SettingsSection
      title="Computer resources"
      description="Limit new work on this host using its hardware and current load. Running work is allowed to finish; use its Stop control to end it."
    >
      <fieldset disabled={saving} className="setgroup" aria-label="Computer resource limits">
        <SettingRow
          label="Automatic limits"
          description="Adjust concurrency to CPU load and available RAM, including other apps. Turn off to use your ceilings without load-based adjustment."
          scope="host"
          settingId="resource-limits"
          focused={focusedSetting === "resource-limits"}
        >
          <OctantSwitch
            label="Automatic limits"
            checked={draft.mode === "automatic"}
            onCheckedChange={(checked) =>
              setDraft({ ...draft, mode: checked ? "automatic" : "manual" })
            }
          />
        </SettingRow>
        {limits.map(({ key, label, description, min, max }) => (
          <SettingRow
            key={key}
            label={label}
            description={description}
            scope="host"
            settingId={`resource-${key}`}
            focused={focusedSetting === `resource-${key}`}
          >
            <OctantNumberStepper
              label={label}
              min={min}
              max={max}
              value={draft[key]}
              onChange={(value) => setDraft({ ...draft, [key]: value })}
            />
          </SettingRow>
        ))}
        <SettingRow
          label="Apply limits"
          description="Settings are kept on this host and apply to the next managed launch."
          scope="host"
          settingId="resource-save"
          focused={focusedSetting === "resource-save"}
        >
          <OctantButton disabled={saving} onClick={() => void save(draft)}>
            Save limits
          </OctantButton>
        </SettingRow>
        <SettingRow
          label="New work"
          description="Pause stops admission of new managed commands and helpers. It does not suspend running processes."
          scope="host"
          settingId="resource-pause"
          focused={focusedSetting === "resource-pause"}
        >
          <OctantButton
            variant="secondary"
            disabled={saving}
            onClick={() =>
              void save({
                ...(settings.resourcePolicy ?? DEFAULT_HOST_RESOURCE_POLICY),
                mode: paused ? "automatic" : "paused",
              })
            }
          >
            {paused ? "Resume automatic limits" : "Pause new work"}
          </OctantButton>
        </SettingRow>
      </fieldset>
      {snapshot === undefined ? (
        <p role="status">Current load readings are unavailable.</p>
      ) : (
        <div role="status">
          <p>
            {snapshot.cores} cores · {Math.round(snapshot.totalMemoryBytes / 2 ** 30)} GiB RAM ·{" "}
            {snapshot.cpuPercent}% CPU · {Math.round(snapshot.availableMemoryBytes / 2 ** 30)} GiB
            available
          </p>
          <p>
            Last reading: up to {snapshot.commands} command groups, {snapshot.workers} total test
            workers and {snapshot.agents} helper agents. {snapshot.activeCommands} commands running;{" "}
            {snapshot.queuedCommands} waiting.
          </p>
          <p>{REASONS[snapshot.reason]}</p>
        </div>
      )}
      <SettingRow
        label="Load readings"
        description="Refresh to see the host's current capacity."
        scope="host"
        settingId="resource-refresh"
        focused={focusedSetting === "resource-refresh"}
      >
        <OctantButton variant="secondary" onClick={() => void refresh()}>
          Refresh load
        </OctantButton>
      </SettingRow>
      <p className="setgroup-note">
        Claude and Codex inherit conservative test-worker defaults at launch. Native CLI delegation,
        arbitrary child processes and tools launched outside Octant are not hard-limited by these
        controls. Test-worker settings only apply to supported runners that preserve the launch
        environment.
      </p>
      {error === undefined ? null : <OctantAlert tone="danger">{error}</OctantAlert>}
    </SettingsSection>
  );
}
