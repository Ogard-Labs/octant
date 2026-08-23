import type { OpenInApplicationId } from "@octant/contracts/shell";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { OctantHostBridge, OpenInApplicationDescriptor } from "../shell/hostBridge";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";

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
    return <p className="open-in-settings__state">Available in the macOS desktop app.</p>;
  }
  if (error !== undefined) {
    return (
      <p className="open-in-settings__state" role="alert">
        {error}
      </p>
    );
  }
  if (rows.length === 0) {
    return (
      <p className="open-in-settings__state" role="status">
        Looking for installed applications…
      </p>
    );
  }

  return (
    <fieldset className="open-in-settings">
      <legend>Open in applications</legend>
      <p>
        Enabled applications appear in this order. Applications that are not installed stay hidden.
      </p>
      <div className="open-in-settings__list">
        {rows.map((entry) => {
          const enabledIndex = props.applications.indexOf(entry.id);
          const enabled = enabledIndex >= 0;
          return (
            <div className="open-in-settings__row" key={entry.id}>
              <label>
                <OctantCheckbox
                  checked={enabled}
                  disabled={!entry.available}
                  onChange={(event) => {
                    props.onChange(
                      event.currentTarget.checked
                        ? [...props.applications, entry.id]
                        : props.applications.filter((id) => id !== entry.id),
                    );
                  }}
                />
                <span>{entry.label}</span>
              </label>
              <span className="open-in-settings__availability">
                {entry.available ? "Installed" : "Not detected"}
              </span>
              <div className="open-in-settings__order-actions">
                <OctantButton
                  aria-label={`Move ${entry.label} up`}
                  disabled={!enabled || enabledIndex === 0}
                  onClick={() => props.onChange(move(props.applications, enabledIndex, -1))}
                  type="button"
                  variant="ghost"
                >
                  <ArrowUp aria-hidden="true" size={14} strokeWidth={1.7} />
                </OctantButton>
                <OctantButton
                  aria-label={`Move ${entry.label} down`}
                  disabled={!enabled || enabledIndex === props.applications.length - 1}
                  onClick={() => props.onChange(move(props.applications, enabledIndex, 1))}
                  type="button"
                  variant="ghost"
                >
                  <ArrowDown aria-hidden="true" size={14} strokeWidth={1.7} />
                </OctantButton>
              </div>
            </div>
          );
        })}
      </div>
    </fieldset>
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
