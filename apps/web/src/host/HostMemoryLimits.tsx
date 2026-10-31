import { useEffect, useId, useState } from "react";
import type { HostControlClient } from "@octant/client-runtime/host-control-client";
import {
  HOST_MEMORY_LIMIT_MAX_GB,
  HOST_MEMORY_LIMIT_MIN_GB,
  type HostMemoryLimits as HostMemoryLimitsValue,
  type HostMemoryStatus,
} from "@octant/contracts/host-control";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { SettingRow, SettingsState } from "../settings/primitives";

/**
 * Settings > Host > Memory limits. Automatic keeps the host's built-in limits,
 * which shrink on a small Mac; Custom sets the two sizes at which the host
 * counts its own memory as low and very low. The host checks the numbers and
 * answers a bad pair with a plain message, shown as it arrived.
 */

export interface HostMemoryLimitsProps {
  readonly client: Pick<HostControlClient, "setMemoryLimits">;
  readonly memory: HostMemoryStatus;
  /** Called after the host saved the limits, so the card can read them back. */
  readonly onSaved: () => void;
}

type Mode = HostMemoryLimitsValue["kind"];

type Feedback =
  | { readonly kind: "success"; readonly text: string }
  | { readonly kind: "error"; readonly text: string };

const MEGABYTES_PER_GB = 1024;

function formatGb(gb: number): string {
  return String(Math.round(gb * 100) / 100);
}

function megabytesToGb(megabytes: number): string {
  return formatGb(megabytes / MEGABYTES_PER_GB);
}

function describeLimits(memory: HostMemoryStatus): string {
  const { limits, effectiveLimits } = memory;
  if (limits.kind === "custom") {
    return `Custom. Octant treats ${formatGb(limits.pressuredGb)} GB as low and ${formatGb(limits.criticalGb)} GB as very low.`;
  }
  return `Automatic. On this Mac Octant treats ${megabytesToGb(effectiveLimits.pressuredMegabytes)} GB as low and ${megabytesToGb(effectiveLimits.criticalMegabytes)} GB as very low.`;
}

export function HostMemoryLimits({ client, memory, onSaved }: HostMemoryLimitsProps) {
  const fieldId = useId();
  const { limits } = memory;
  const savedPressured =
    limits.kind === "custom"
      ? formatGb(limits.pressuredGb)
      : megabytesToGb(memory.effectiveLimits.pressuredMegabytes);
  const savedCritical =
    limits.kind === "custom"
      ? formatGb(limits.criticalGb)
      : megabytesToGb(memory.effectiveLimits.criticalMegabytes);
  const [mode, setMode] = useState<Mode>(limits.kind);
  const [pressured, setPressured] = useState(savedPressured);
  const [critical, setCritical] = useState(savedCritical);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>();

  // The saved limits are the host's word; a reading that changed them, here or
  // from another window, replaces the draft.
  useEffect(() => {
    setMode(limits.kind);
    setPressured(savedPressured);
    setCritical(savedCritical);
  }, [limits.kind, savedPressured, savedCritical]);

  const unchanged =
    mode === limits.kind &&
    (mode === "automatic" || (pressured === savedPressured && critical === savedCritical));

  const save = async () => {
    setFeedback(undefined);
    let request: Parameters<HostControlClient["setMemoryLimits"]>[0];
    if (mode === "automatic") {
      request = { limits: { kind: "automatic" } };
    } else {
      const pressuredGb = pressured.trim() === "" ? Number.NaN : Number(pressured);
      const criticalGb = critical.trim() === "" ? Number.NaN : Number(critical);
      if (!Number.isFinite(pressuredGb) || !Number.isFinite(criticalGb)) {
        setFeedback({ kind: "error", text: "Enter both limits as a number of GB." });
        return;
      }
      request = { limits: { kind: "custom", pressuredGb, criticalGb } };
    }
    setBusy(true);
    try {
      const outcome = await client.setMemoryLimits(request);
      if (outcome.kind === "refused") {
        setFeedback({ kind: "error", text: outcome.message });
        return;
      }
      setFeedback({ kind: "success", text: "Memory limits saved." });
      onSaved();
    } catch {
      setFeedback({ kind: "error", text: "The memory limits could not be saved." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="setgroup">
        <SettingRow
          description={describeLimits(memory)}
          htmlFor={`${fieldId}-mode`}
          label="Memory limits"
          scope="host"
          settingId="host-memory-limits"
        >
          <div className="host-settings__controls">
            <OctantSelectField
              aria-label="Memory limits"
              id={`${fieldId}-mode`}
              onValueChange={(value) => {
                if (value === "automatic" || value === "custom") setMode(value);
              }}
              options={[
                { id: "automatic", label: "Automatic" },
                { id: "custom", label: "Custom" },
              ]}
              value={mode}
            />
            {mode === "custom" ? (
              <>
                <div className="host-settings__field">
                  <label htmlFor={`${fieldId}-pressured`}>Low at (GB)</label>
                  <OctantInput
                    id={`${fieldId}-pressured`}
                    inputMode="decimal"
                    max={HOST_MEMORY_LIMIT_MAX_GB}
                    min={HOST_MEMORY_LIMIT_MIN_GB}
                    onChange={(event) => setPressured(event.currentTarget.value)}
                    step="0.5"
                    type="number"
                    value={pressured}
                  />
                </div>
                <div className="host-settings__field">
                  <label htmlFor={`${fieldId}-critical`}>Very low at (GB)</label>
                  <OctantInput
                    id={`${fieldId}-critical`}
                    inputMode="decimal"
                    max={HOST_MEMORY_LIMIT_MAX_GB}
                    min={HOST_MEMORY_LIMIT_MIN_GB}
                    onChange={(event) => setCritical(event.currentTarget.value)}
                    step="0.5"
                    type="number"
                    value={critical}
                  />
                </div>
              </>
            ) : null}
            <OctantButton
              disabled={busy || unchanged}
              onClick={() => void save()}
              size="sm"
              type="button"
              variant="secondary"
            >
              Save memory limits
            </OctantButton>
          </div>
        </SettingRow>
      </div>
      {mode === "custom" ? (
        <p className="settings-section-line">
          Each limit is the size of the Octant host process, from {HOST_MEMORY_LIMIT_MIN_GB} to{" "}
          {HOST_MEMORY_LIMIT_MAX_GB} GB, and very low must be above low. Custom limits apply as
          entered on any Mac. They change when Octant frees idle work, never what a running turn
          does.
        </p>
      ) : null}
      {feedback === undefined ? null : (
        <SettingsState kind={feedback.kind}>{feedback.text}</SettingsState>
      )}
    </>
  );
}
