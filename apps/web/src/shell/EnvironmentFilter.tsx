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
import {
  OctantMenuRoot,
  OctantMenuTrigger,
  OctantMenuPortal,
  OctantMenuPositioner,
  OctantMenuPopup,
  OctantMenuCheckboxItem,
  OctantMenuGroupLabel,
  OctantMenuGroup,
} from "../ui/base/OctantMenu";

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
  const rows = environmentRows({
    hostStates: props.hostStates,
    selection: props.selection,
    ...(props.localHostId === undefined ? {} : { localHostId: props.localHostId }),
  });
  const knownHostIds = rows.map((row) => row.hostId);
  const allChecked = allEnvironmentsSelected(props.selection, knownHostIds);

  return (
    <div className="environment-filter">
      <OctantMenuRoot>
        <OctantMenuTrigger className="environment-filter__toggle">
          <span>{environmentSelectionSummary(rows, props.selection)}</span>
          <ChevronDown aria-hidden="true" size={12} strokeWidth={1.8} />
        </OctantMenuTrigger>

        <OctantMenuPortal>
          <OctantMenuPositioner>
            <OctantMenuPopup aria-label="Environment">
              <OctantMenuGroup>
                <OctantMenuGroupLabel>Environment</OctantMenuGroupLabel>
                <OctantMenuCheckboxItem
                  checked={allChecked}
                  onCheckedChange={() =>
                    props.onSelectionChange(toggleAllEnvironments(props.selection))
                  }
                  closeOnClick={false}
                >
                  All environments
                </OctantMenuCheckboxItem>
                {rows.map((row) => (
                  <OctantMenuCheckboxItem
                    label={`${row.label} (${String(row.itemCount)})${row.reach === "ready" ? "" : ` · ${REACH_NOTE[row.reach]}`}`}
                    checked={row.checked}
                    key={row.hostId}
                    onCheckedChange={() =>
                      props.onSelectionChange(
                        toggleEnvironment(props.selection, row.hostId, knownHostIds),
                      )
                    }
                    closeOnClick={false}
                  >
                    <span className="environment-filter__label">{row.label}</span>
                    <span className="environment-filter__count">{String(row.itemCount)}</span>
                    {row.reach === "ready" ? null : (
                      <span className="environment-filter__reach" data-reach={row.reach}>
                        {REACH_NOTE[row.reach]}
                      </span>
                    )}
                    {row.isLocal ? <Check aria-hidden="true" size={12} strokeWidth={2} /> : null}
                  </OctantMenuCheckboxItem>
                ))}
              </OctantMenuGroup>
            </OctantMenuPopup>
          </OctantMenuPositioner>
        </OctantMenuPortal>
      </OctantMenuRoot>
    </div>
  );
}
