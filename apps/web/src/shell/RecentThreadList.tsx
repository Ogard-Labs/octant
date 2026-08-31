import { OctantButton } from "../ui/base/OctantButton";

/** One lifecycle-openable thread shown on a mode's start surface. */
export interface RecentThreadListItem {
  readonly id: string;
  readonly title: string;
  readonly detail?: string;
  readonly onOpen: () => void;
}

export function RecentThreadList(props: { readonly threads: ReadonlyArray<RecentThreadListItem> }) {
  if (props.threads.length === 0) return null;
  return (
    <div className="draft-thread__recent">
      <p className="draft-thread__recent-title">Continue</p>
      <ul className="draft-thread__recent-list">
        {props.threads.map((thread) => (
          <li key={thread.id}>
            <OctantButton
              className="draft-thread__recent-item"
              onClick={thread.onOpen}
              type="button"
              variant="ghost"
            >
              <span className="draft-thread__recent-name">{thread.title}</span>
              {thread.detail === undefined ? null : (
                <span className="draft-thread__recent-detail">{thread.detail}</span>
              )}
            </OctantButton>
          </li>
        ))}
      </ul>
    </div>
  );
}
