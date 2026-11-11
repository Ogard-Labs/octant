import type { ReactNode } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { bySeverity, type ComposerNoticeItem } from "./ComposerNotice";

/**
 * Everything a composer has to say about its thread or about sending, as one
 * group directly above the pill: a card for each notice, the most severe
 * first, so the pill itself holds only attach, the prompt, the microphone and
 * send. Drawn inside the pill, a tinted bar fought its corner and read as part
 * of the message. The group is empty, and takes no room, when nothing applies.
 *
 * `children` are notices that own their own state (the Project offer, the
 * outside-content mark); they follow the surface's own, which are the ones
 * that refuse or fail.
 */
export function ComposerNoticeCard(props: {
  readonly notices: ReadonlyArray<ComposerNoticeItem>;
  readonly children?: ReactNode;
}) {
  return (
    <div className="composer-notices">
      {bySeverity(props.notices).map((notice) => (
        <OctantAlert
          {...(notice.action === undefined ? {} : { action: notice.action })}
          className="composer-notice"
          {...(notice.id === undefined ? {} : { id: notice.id })}
          key={notice.key}
          {...(notice.role === undefined ? {} : { role: notice.role })}
          tone={notice.tone}
        >
          {notice.text}
        </OctantAlert>
      ))}
      {props.children}
    </div>
  );
}
