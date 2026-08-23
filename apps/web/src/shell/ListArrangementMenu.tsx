import {
  LIST_GROUPING_LABELS,
  LIST_SORT_LABELS,
  LIST_STATUS_LABELS,
  type ListArrangement,
  type ListGrouping,
  type ListSort,
  type ListStatusFilter,
} from "@octant/client-runtime/list-arrangement";
import { OctantNativeSelect } from "../ui/base/OctantSelect";

const STATUSES: ReadonlyArray<ListStatusFilter> = ["any", "active", "needs-attention", "finished"];
const GROUPINGS: ReadonlyArray<ListGrouping> = ["none", "environment", "project"];
const SORTS: ReadonlyArray<ListSort> = ["recent", "name"];

/**
 * Status, grouping, and order for a list that gathers from several
 * environments.
 *
 * It sits beside the environment filter and speaks the same vocabulary, so a
 * person who learned it in one list already knows it in the next. Like that
 * filter, everything here is view state: narrowing a list never changes what
 * anything may do, and grouping by environment never moves ownership.
 */
export function ListArrangementMenu(props: {
  readonly arrangement: ListArrangement;
  readonly onChange: (next: ListArrangement) => void;
}) {
  return (
    <div aria-label="Arrange" className="list-arrangement" role="group">
      <label className="list-arrangement__field">
        <span className="sr-only">Status</span>
        <OctantNativeSelect
          onChange={(event) =>
            props.onChange({ ...props.arrangement, status: event.target.value as ListStatusFilter })
          }
          value={props.arrangement.status}
        >
          {STATUSES.map((status) => (
            <option key={status} value={status}>
              {LIST_STATUS_LABELS[status]}
            </option>
          ))}
        </OctantNativeSelect>
      </label>

      <label className="list-arrangement__field">
        <span className="sr-only">Group</span>
        <OctantNativeSelect
          onChange={(event) =>
            props.onChange({ ...props.arrangement, grouping: event.target.value as ListGrouping })
          }
          value={props.arrangement.grouping}
        >
          {GROUPINGS.map((grouping) => (
            <option key={grouping} value={grouping}>
              {LIST_GROUPING_LABELS[grouping]}
            </option>
          ))}
        </OctantNativeSelect>
      </label>

      <label className="list-arrangement__field">
        <span className="sr-only">Sort</span>
        <OctantNativeSelect
          onChange={(event) =>
            props.onChange({ ...props.arrangement, sort: event.target.value as ListSort })
          }
          value={props.arrangement.sort}
        >
          {SORTS.map((sort) => (
            <option key={sort} value={sort}>
              {LIST_SORT_LABELS[sort]}
            </option>
          ))}
        </OctantNativeSelect>
      </label>
    </div>
  );
}
