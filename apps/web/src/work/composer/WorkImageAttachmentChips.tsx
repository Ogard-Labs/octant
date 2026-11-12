import { X } from "lucide-react";
import type { WorkComposerImages } from "./useWorkComposerImages";
import { OctantButton } from "../../ui/base/OctantButton";

/**
 * Staged image chips for a Work composer. The new-thread adapter and the Work
 * overview quick start stage images through the same hook and rendered the
 * same chip row twice; one definition keeps the thumbnails, removal, and the
 * refusal notice identical wherever Work accepts images.
 */
export function WorkImageAttachmentChips(props: {
  readonly images: WorkComposerImages;
  /**
   * A thread composer says the refusal in its notice card above the box and
   * passes false; the overview's quick start has no card and keeps it here.
   */
  readonly withMessage?: boolean;
}) {
  const images = props.images;
  const message = props.withMessage === false ? undefined : images.message;
  if (images.staged.length === 0 && message === undefined) return null;
  return (
    <div className="composer-chips work-composer-adapter__attachments" aria-label="Attached images">
      {images.staged.map((attachment) => (
        <span className="chip work-composer-adapter__attachment" key={attachment.id}>
          <img
            alt={attachment.displayName}
            className="work-composer-adapter__attachment-thumb"
            src={attachment.previewUrl}
          />
          <span className="work-composer-adapter__attachment-name">{attachment.displayName}</span>
          <OctantButton
            aria-label={`Remove ${attachment.displayName}`}
            className="chip-x window-no-drag"
            onClick={() => images.remove(attachment.id)}
            type="button"
            variant="bare"
          >
            <X aria-hidden="true" size={12} strokeWidth={1.8} />
          </OctantButton>
        </span>
      ))}
      {message === undefined ? null : (
        <span className="work-composer-adapter__hint" role="status">
          {message}
        </span>
      )}
    </div>
  );
}
