import type { CodeAttachmentReference, CodeThreadId } from "@octant/contracts";
import type { CodeClient } from "@octant/client-runtime";
import { useCallback, useEffect, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { ImagePreviewDialog } from "../composer/ImagePreviewDialog";

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
  const [sources, setSources] = useState<Readonly<Record<string, string>>>({});
  const [previewIndex, setPreviewIndex] = useState<number>();
  const onSource = useCallback((id: string, url: string | undefined) => {
    setSources((previous) => {
      const { [id]: _removed, ...rest } = previous;
      return url === undefined ? rest : { ...rest, [id]: url };
    });
  }, []);
  if (props.attachments.length === 0) return null;
  // Only the pictures that loaded can be previewed; the arrows step through them.
  const loaded = props.attachments.filter(
    (attachment) => sources[attachment.attachmentId] !== undefined,
  );
  return (
    <div aria-label="Attached images" className="code-thread-workspace__attachments">
      <ImagePreviewDialog
        images={loaded.map((attachment) => ({
          id: attachment.attachmentId,
          name: attachment.displayName,
          url: sources[attachment.attachmentId] ?? "",
          bytes: attachment.byteLength,
        }))}
        index={previewIndex}
        onClose={() => setPreviewIndex(undefined)}
        onIndexChange={setPreviewIndex}
      />
      {props.attachments.map((attachment) => (
        <CodeAttachmentImage
          attachment={attachment}
          onOpen={() =>
            setPreviewIndex(
              loaded.findIndex((candidate) => candidate.attachmentId === attachment.attachmentId),
            )
          }
          onSource={onSource}
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
  readonly onOpen: () => void;
  readonly onSource: (id: string, url: string | undefined) => void;
  readonly client?: CodeAttachmentReader;
  readonly threadId: CodeThreadId;
}) {
  const { attachment, client, onSource, threadId } = props;
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
        onSource(attachment.attachmentId, objectUrl);
      })
      .catch(() => {
        if (!cancelled) setUnavailable(true);
      });
    return () => {
      cancelled = true;
      onSource(attachment.attachmentId, undefined);
      if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment, client, onSource, threadId]);

  const name = unavailable ? `${attachment.displayName} (unavailable)` : attachment.displayName;
  const content = (
    <>
      {source === undefined ? (
        <span className="code-thread-workspace__attachment-thumb" role="img" aria-hidden="true" />
      ) : (
        <img
          alt={attachment.displayName}
          className="code-thread-workspace__attachment-thumb"
          src={source}
        />
      )}
      <span className="code-thread-workspace__attachment-name">{name}</span>
    </>
  );
  return (
    <span className="code-thread-workspace__attachment">
      {source === undefined ? (
        content
      ) : (
        <OctantButton
          aria-label={`Preview ${attachment.displayName}`}
          className="image-preview-trigger window-no-drag"
          onClick={props.onOpen}
          type="button"
          variant="bare"
        >
          {content}
        </OctantButton>
      )}
    </span>
  );
}
