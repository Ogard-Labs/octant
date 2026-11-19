import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_HOST_RESOURCE_POLICY,
  type AgentRunPolicySettings,
  type HostResourceBudgetSnapshot,
  type HostResourcePolicy,
  type KeepAwakePolicy,
} from "@octant/contracts";
import { effectiveKeepAwakePolicy } from "@octant/domain/host-resource-policy";
import {
  AgentRunSettingsClientFailure,
  type AgentRunSettingsClient,
} from "@octant/client-runtime/agent-run-settings-client";
import type { KeepAwakeStatus, OctantHostBridge } from "../shell/hostBridge";
import { SettingRow, SettingsSection } from "./primitives";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantNumberStepper } from "../ui/base/OctantNumberStepper";
import { OctantSelectField } from "../ui/base/OctantSelect";
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

const KEEP_AWAKE_OPTIONS: ReadonlyArray<{
  readonly id: KeepAwakePolicy;
  readonly label: string;
}> = [
  { id: "on-power", label: "While on power" },
  { id: "always", label: "Always" },
  { id: "never", label: "Never" },
];

function keepAwakeStatusLine(status: KeepAwakeStatus | undefined): string {
  if (status === undefined) return "Checking sleep-prevention status…";
  if (status.state === "active") return status.summary;
  if (status.state === "unavailable") {
    return "Unavailable — this computer did not allow preventing sleep.";
  }
  if (status.reason === "disabled") {
    return "Off — this computer may sleep while agents work.";
  }
  if (status.reason === "on-battery") {
    return "Idle — on battery power.";
  }
  return "Idle — no agent work running.";
}

export function HostResourceSettings({
  client,
  focusedSetting,
  hostBridge,
}: {
  readonly client: AgentRunSettingsClient;
  readonly focusedSetting?: string;
  readonly hostBridge?: Pick<
    OctantHostBridge,
    "subscribeKeepAwakeStatus" | "refreshKeepAwakeStatus"
  >;
}) {
  const [settings, setSettings] = useState<AgentRunPolicySettings>();
  const [draft, setDraft] = useState<HostResourcePolicy>(DEFAULT_HOST_RESOURCE_POLICY);
  const [snapshot, setSnapshot] = useState<HostResourceBudgetSnapshot>();
  const [keepAwakeStatus, setKeepAwakeStatus] = useState<KeepAwakeStatus>();
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
  const subscribeKeepAwake = hostBridge?.subscribeKeepAwakeStatus;
  useEffect(() => {
    if (subscribeKeepAwake === undefined) {
      setKeepAwakeStatus(undefined);
      return;
    }
    return subscribeKeepAwake((next) => {
      if (mounted.current) setKeepAwakeStatus(next);
    });
  }, [subscribeKeepAwake]);
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
  const save = async (
    policy: HostResourcePolicy,
    options?: { readonly preserveDraft?: boolean; readonly refreshKeepAwake?: boolean },
  ) => {
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
      if (options?.preserveDraft !== true) {
        setDraft(current.resourcePolicy ?? DEFAULT_HOST_RESOURCE_POLICY);
      }
      await refresh();
      if (options?.refreshKeepAwake === true && hostBridge?.refreshKeepAwakeStatus !== undefined) {
        try {
          const nextStatus = await hostBridge.refreshKeepAwakeStatus();
          if (mounted.current) setKeepAwakeStatus(nextStatus);
        } catch {
          // Live subscription keeps updating on the desktop poll cadence.
        }
      }
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
  if (settings === undefined && !loading)
    return (
      <OctantAlert tone="danger">
        {error}
        <OctantButton onClick={() => void load()}>Retry</OctantButton>
      </OctantAlert>
    );
  // While the limits load the section is drawn whole, its rows in place with
  // their controls out of sight and out of reach: nothing unsaved is shown as
  // a value. As one "Loading…" line it grew by about 930px a quarter of a
  // second after Settings opened and pushed the page's first section, and
  // every section under it, down the page.
  const paused = (settings?.resourcePolicy ?? DEFAULT_HOST_RESOURCE_POLICY).mode === "paused";
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
        "Reserves this share of available RAM where measured, with at least 1 GiB reserved. On macOS, kernel memory pressure controls admission and this share bounds the hardware estimate.",
      min: 10,
      max: 50,
    },
  ];
  return (
    <SettingsSection
      title="Computer resources"
      description="Limit new work using this host's hardware and load. Running work finishes; use Stop to end it."
    >
      <fieldset
        aria-busy={loading || undefined}
        aria-label="Computer resource limits"
        className="setgroup"
        data-loading={loading ? "true" : undefined}
        disabled={saving || loading}
      >
        <SettingRow
          label="Automatic limits"
          description="Adjust to CPU load and free RAM, including other apps. Turn off to use your limits as set."
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
              field
              label={label}
              min={min}
              max={max}
              suffix={
                key === "cpuTargetPercent" || key === "memoryReservePercent" ? "%" : undefined
              }
              value={draft[key]}
              onChange={(value) => setDraft({ ...draft, [key]: value })}
            />
          </SettingRow>
        ))}
        <SettingRow
          label="Apply limits"
          description="Saved on this host. Applies to the next launch."
          scope="host"
          settingId="resource-save"
          focused={focusedSetting === "resource-save"}
        >
          <OctantButton
            disabled={saving}
            onClick={() =>
              void save({
                ...draft,
                ...(settings?.resourcePolicy?.keepAwake === undefined
                  ? {}
                  : { keepAwake: settings.resourcePolicy.keepAwake }),
              })
            }
          >
            Save limits
          </OctantButton>
        </SettingRow>
        <SettingRow
          label="New work"
          description="Pause blocks new commands and helpers. Running ones keep going."
          scope="host"
          settingId="resource-pause"
          focused={focusedSetting === "resource-pause"}
        >
          <OctantButton
            variant="secondary"
            disabled={saving}
            onClick={() =>
              void save({
                ...(settings?.resourcePolicy ?? DEFAULT_HOST_RESOURCE_POLICY),
                mode: paused ? "automatic" : "paused",
              })
            }
          >
            {paused ? "Resume automatic limits" : "Pause new work"}
          </OctantButton>
        </SettingRow>
        <SettingRow
          label="Keep the computer awake while agents work"
          description="Prevents idle system sleep while turns, child runs, workers, or a routine due within 5 minutes are active. Display sleep is not prevented."
          scope="host"
          settingId="resource-keepAwake"
          focused={focusedSetting === "resource-keepAwake"}
        >
          <OctantSelectField
            aria-label="Keep the computer awake while agents work"
            disabled={saving || loading}
            onValueChange={(value) => {
              if (value === "on-power" || value === "always" || value === "never") {
                void save(
                  {
                    ...(settings?.resourcePolicy ?? DEFAULT_HOST_RESOURCE_POLICY),
                    keepAwake: value,
                  },
                  { preserveDraft: true, refreshKeepAwake: true },
                );
              }
            }}
            options={KEEP_AWAKE_OPTIONS}
            value={effectiveKeepAwakePolicy(settings?.resourcePolicy)}
          />
        </SettingRow>
      </fieldset>
      {subscribeKeepAwake === undefined ? null : (
        <p className="setgroup-note host-resources__keep-awake-status" role="status">
          {keepAwakeStatusLine(keepAwakeStatus)}
        </p>
      )}
      {loading ? (
        <p aria-busy="true" className="host-resources__readings" role="status">
          Reading the host's load…
        </p>
      ) : snapshot === undefined ? (
        <p className="host-resources__readings" role="status">
          Current load readings are unavailable.
        </p>
      ) : (
        <div className="host-resources__readings" role="status">
          <p>
            {snapshot.cores} cores · {Math.round(snapshot.totalMemoryBytes / 2 ** 30)} GiB RAM ·{" "}
            {snapshot.cpuPercent}% CPU ·{" "}
            {snapshot.availableMemoryBytes === undefined
              ? `Memory pressure: ${snapshot.memoryPressure ?? "unknown"}`
              : `${Math.round(snapshot.availableMemoryBytes / 2 ** 30)} GiB available`}
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
