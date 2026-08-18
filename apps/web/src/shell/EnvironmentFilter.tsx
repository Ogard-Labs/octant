import {
  allEnvironmentsSelected,
  environmentRows,
  environmentSelectionSummary,
  toggleAllEnvironments,
  toggleEnvironment,
  type EnvironmentSelection,
} from "@octant/client-runtime/environment-selection";
import type { FederatedHostState } from "@octant/client-runtime";
import { Check, ChevronDown } from "lucide-react";
import { useState } from "react";

export interface EnvironmentFilterProps {
  readonly hostStates: ReadonlyArray<FederatedHostState>;
  readonly selection: EnvironmentSelection;
  readonly localHostId?: string;
  readonly onSelectionChange: (next: EnvironmentSelection) => void;
}

const REACH_NOTE = {
  ready: "",
  connecting: "connecting",
  stale: "stale",
  unreachable: "unreachable",
} as const;

/**
 * Choosing which environments a list gathers from.
 *
 * An environment is a connected host under the name a person uses for it, and
 * choosing here changes only what is shown. Ownership does not move: an item is
 * still run by its own host, and reaching one still goes through that host's
 * transport under remote authority.
 *
 * An unreachable environment keeps its row and its count. A host that dropped
 * out is a thing to see rather than a thing to hide, and its items stay in the
 * list marked stale — which is the same promise reconnect-replay already makes
 * everywhere else.
 */
export function EnvironmentFilter(props: EnvironmentFilterProps) {
  const [open, setOpen] = useState(false);
  const rows = environmentRows({
    hostStates: props.hostStates,
    selection: props.selection,
    ...(props.localHostId === undefined ? {} : { localHostId: props.localHostId }),
  });
  const knownHostIds = rows.map((row) => row.hostId);
  const allChecked = allEnvironmentsSelected(props.selection, knownHostIds);

  return (
    <div className="environment-filter">
      <button
        aria-expanded={open}
        aria-haspopup="true"
        className="environment-filter__toggle"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span>{environmentSelectionSummary(rows, props.selection)}</span>
        <ChevronDown aria-hidden="true" size={12} strokeWidth={1.8} />
      </button>

      {open ? (
        <fieldset className="environment-filter__menu">
          <legend className="sr-only">Environment</legend>
          <label className="environment-filter__row">
            <input
              checked={allChecked}
              onChange={() => props.onSelectionChange(toggleAllEnvironments(props.selection))}
              type="checkbox"
            />
            <span className="environment-filter__label">All environments</span>
          </label>

          {rows.map((row) => (
            <label className="environment-filter__row" key={row.hostId}>
              <input
                checked={row.checked}
                onChange={() =>
                  props.onSelectionChange(
                    toggleEnvironment(props.selection, row.hostId, knownHostIds),
                  )
                }
                type="checkbox"
              />
              <span className="environment-filter__label">{row.label}</span>
              <span className="environment-filter__count">{String(row.itemCount)}</span>
              {row.reach === "ready" ? null : (
                <span className="environment-filter__reach" data-reach={row.reach}>
                  {REACH_NOTE[row.reach]}
                </span>
              )}
              {row.isLocal ? <Check aria-hidden="true" size={10} strokeWidth={2} /> : null}
            </label>
          ))}
        </fieldset>
      ) : null}
    </div>
  );
}
