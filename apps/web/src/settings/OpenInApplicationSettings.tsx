import type { OpenInApplicationId } from "@octant/contracts/shell";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { OctantHostBridge, OpenInApplicationDescriptor } from "../shell/hostBridge";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { SettingRow, SettingsState } from "./primitives";

export interface OpenInApplicationSettingsProps {
  readonly applications: ReadonlyArray<OpenInApplicationId>;
  readonly hostBridge?: OctantHostBridge;
  readonly onChange: (applications: ReadonlyArray<OpenInApplicationId>) => void;
}

export function OpenInApplicationSettings(props: OpenInApplicationSettingsProps) {
  const [catalogue, setCatalogue] = useState<ReadonlyArray<OpenInApplicationDescriptor>>([]);
  const [error, setError] = useState<string>();
  const listApplications = props.hostBridge?.listOpenInApplications;

  useEffect(() => {
    if (listApplications === undefined) return;
    let cancelled = false;
    void listApplications().then(
      (next) => {
        if (!cancelled) setCatalogue(next);
      },
      () => {
        if (!cancelled) setError("Installed applications could not be inspected.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [listApplications]);

  const rows = useMemo(() => {
    const byId = new Map(catalogue.map((entry) => [entry.id, entry]));
    const enabled = props.applications.flatMap((id) => {
      const entry = byId.get(id);
      return entry === undefined ? [] : [entry];
    });
    const disabled = catalogue.filter((entry) => !props.applications.includes(entry.id));
    return [...enabled, ...disabled];
  }, [catalogue, props.applications]);

  if (listApplications === undefined) {
    return (
      <div className="settings-card-section settings-card-section--open">
        <h2>Open in applications</h2>
        <p className="settings-section-note">Available in the macOS desktop app.</p>
      </div>
    );
  }

  return (
    <div className="settings-card-section settings-card-section--open open-in-settings">
      <h2>Open in applications</h2>
      <p className="settings-section-note">
        Enabled applications appear in this order. Applications that are not installed stay hidden.
      </p>
      {error !== undefined ? (
        <SettingsState kind="error">{error}</SettingsState>
      ) : rows.length === 0 ? (
        <SettingsState kind="loading">Looking for installed applications…</SettingsState>
      ) : (
        <div className="setgroup">
          {rows.map((entry) => {
            const enabledIndex = props.applications.indexOf(entry.id);
            const enabled = enabledIndex >= 0;
            return (
              <SettingRow
                description={entry.available ? "Installed" : "Not detected"}
                key={entry.id}
                label={entry.label}
                scope="app"
                settingId={`open-in-${entry.id}`}
              >
                <div className="open-in-settings__controls">
                  <OctantButton
                    aria-label={`Move ${entry.label} up`}
                    disabled={!enabled || enabledIndex === 0}
                    onClick={() => props.onChange(move(props.applications, enabledIndex, -1))}
                    size="icon"
                    type="button"
                    variant="ghost"
                  >
                    <ArrowUp aria-hidden="true" size={14} strokeWidth={1.7} />
                  </OctantButton>
                  <OctantButton
                    aria-label={`Move ${entry.label} down`}
                    disabled={!enabled || enabledIndex === props.applications.length - 1}
                    onClick={() => props.onChange(move(props.applications, enabledIndex, 1))}
                    size="icon"
                    type="button"
                    variant="ghost"
                  >
                    <ArrowDown aria-hidden="true" size={14} strokeWidth={1.7} />
                  </OctantButton>
                  <OctantSwitch
                    checked={enabled}
                    disabled={!entry.available}
                    label={entry.label}
                    onCheckedChange={(checked) => {
                      props.onChange(
                        checked
                          ? [...props.applications, entry.id]
                          : props.applications.filter((id) => id !== entry.id),
                      );
                    }}
                  />
                </div>
              </SettingRow>
            );
          })}
        </div>
      )}
    </div>
  );
}

function move(
  values: ReadonlyArray<OpenInApplicationId>,
  index: number,
  offset: -1 | 1,
): ReadonlyArray<OpenInApplicationId> {
  const target = index + offset;
  if (index < 0 || target < 0 || target >= values.length) return values;
  const next = [...values];
  const current = next[index];
  const replacement = next[target];
  if (current === undefined || replacement === undefined) return values;
  next[index] = replacement;
  next[target] = current;
  return next;
}
