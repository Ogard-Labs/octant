import {
  LIST_GROUPING_LABELS,
  LIST_SORT_LABELS,
  LIST_STATUS_LABELS,
  type ListArrangement,
  type ListGrouping,
  type ListSort,
  type ListStatusFilter,
} from "@octant/client-runtime/list-arrangement";
import { OctantSelectField } from "../ui/base/OctantSelect";

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
        <OctantSelectField
          aria-label="Status"
          onValueChange={(value) =>
            props.onChange({ ...props.arrangement, status: value as ListStatusFilter })
          }
          options={STATUSES.map((status) => ({
            id: status,
            label: LIST_STATUS_LABELS[status],
          }))}
          value={props.arrangement.status}
        />
      </label>

      <label className="list-arrangement__field">
        <span className="sr-only">Group</span>
        <OctantSelectField
          aria-label="Group"
          onValueChange={(value) =>
            props.onChange({ ...props.arrangement, grouping: value as ListGrouping })
          }
          options={GROUPINGS.map((grouping) => ({
            id: grouping,
            label: LIST_GROUPING_LABELS[grouping],
          }))}
          value={props.arrangement.grouping}
        />
      </label>

      <label className="list-arrangement__field">
        <span className="sr-only">Sort</span>
        <OctantSelectField
          aria-label="Sort"
          onValueChange={(value) =>
            props.onChange({ ...props.arrangement, sort: value as ListSort })
          }
          options={SORTS.map((sort) => ({
            id: sort,
            label: LIST_SORT_LABELS[sort],
          }))}
          value={props.arrangement.sort}
        />
      </label>
    </div>
  );
}
