import type { CodeAttachmentReference, CodeThreadId } from "@octant/contracts";
import type { CodeClient } from "@octant/client-runtime";
import { useEffect, useState } from "react";

export type CodeAttachmentReader = Pick<CodeClient, "attachment">;

/**
 * The images a message carried.
 *
 * Bytes are fetched from the host by the reference the journal recorded, so a
 * transcript read long after the send shows the picture the turn was actually
 * given — or says plainly that it can no longer be read, rather than showing a
 * broken frame.
 */
export function CodeAttachmentGallery(props: {
  readonly attachments: ReadonlyArray<CodeAttachmentReference>;
  readonly client?: CodeAttachmentReader;
  readonly threadId: CodeThreadId;
}) {
  if (props.attachments.length === 0) return null;
  return (
    <div aria-label="Attached images" className="code-thread-workspace__attachments">
      {props.attachments.map((attachment) => (
        <CodeAttachmentImage
          attachment={attachment}
          {...(props.client === undefined ? {} : { client: props.client })}
          key={attachment.attachmentId}
          threadId={props.threadId}
        />
      ))}
    </div>
  );
}

function CodeAttachmentImage(props: {
  readonly attachment: CodeAttachmentReference;
  readonly client?: CodeAttachmentReader;
  readonly threadId: CodeThreadId;
}) {
  const { attachment, client, threadId } = props;
  const [source, setSource] = useState<string>();
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    if (client === undefined) {
      setUnavailable(true);
      return;
    }
    let objectUrl: string | undefined;
    let cancelled = false;
    void client
      .attachment(threadId, attachment)
      .then(({ bytes, mediaType }) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mediaType }));
        setSource(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setUnavailable(true);
      });
    return () => {
      cancelled = true;
      if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment, client, threadId]);

  return (
    <span className="code-thread-workspace__attachment">
      {source === undefined ? (
        <span className="code-thread-workspace__attachment-thumb" role="img" aria-hidden="true" />
      ) : (
        <img
          alt={attachment.displayName}
          className="code-thread-workspace__attachment-thumb"
          src={source}
        />
      )}
      <span className="code-thread-workspace__attachment-name">
        {unavailable ? `${attachment.displayName} (unavailable)` : attachment.displayName}
      </span>
    </span>
  );
}
