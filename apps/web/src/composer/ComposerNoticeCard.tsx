import type { ReactNode } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { bySeverity, noticeRole, type ComposerNoticeItem } from "./ComposerNotice";

/**
 * Everything a composer has to say about its thread or about sending, as one
 * group directly above the box: a card for each notice, the most severe
 * first, so the box itself holds only attach, the prompt, the microphone and
 * send. Drawn inside the box, a tinted bar fought its corner and read as part
 * of the message. The group is empty, and takes no room, when nothing applies.
 *
 * `children` are notices that own their own state (the Project offer, the
 * outside-content mark); they follow the surface's own, which are the ones
 * that refuse or fail.
 */
export function ComposerNoticeCard(props: {
  readonly notices: ReadonlyArray<ComposerNoticeItem>;
  /** Makes the id of an alert card, so the prompt can name it in its description. */
  readonly idPrefix: string;
  readonly children?: ReactNode;
}) {
  return (
    <div className="composer-notices">
      {bySeverity(props.notices).map((notice) => (
        <OctantAlert
          {...(notice.action === undefined ? {} : { action: notice.action })}
          className="composer-notice"
          id={noticeCardId(props.idPrefix, notice)}
          {...(notice.label === undefined ? {} : { label: notice.label })}
          key={notice.key}
          role={noticeRole(notice)}
          tone={notice.tone}
        >
          {notice.text}
        </OctantAlert>
      ))}
      {props.children}
    </div>
  );
}

/** A card's element id: its own, or one derived from the composer and its key. */
export function noticeCardId(prefix: string, notice: ComposerNoticeItem): string {
  return notice.id ?? `${prefix}-${notice.key}`;
}
