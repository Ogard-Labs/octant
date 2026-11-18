import { useEffect, useRef } from "react";
import { OctantDialog } from "../ui/base/OctantDialog";
import "./image-preview.css";

export interface PreviewImage {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  /** Absent when the source does not know the size, as for a staged file read lazily. */
  readonly bytes?: number | undefined;
}

export function formatImageSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * One image shown large over the window. Arrow keys move between the images of
 * the same message or composer; Escape and a press outside close it. The frame
 * keeps one size from image to image, so stepping never moves the caption.
 */
export function ImagePreviewDialog(props: {
  readonly images: ReadonlyArray<PreviewImage>;
  readonly index: number | undefined;
  readonly onIndexChange: (index: number) => void;
  readonly onClose: () => void;
  readonly restoreFocus?: React.RefObject<HTMLElement | null>;
}) {
  const { images, index, onIndexChange, onClose } = props;
  const current = index === undefined ? undefined : images[index];
  const open = current !== undefined;
  const frame = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (index === undefined) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (images.length < 2) return;
      if (event.key === "ArrowRight") {
        event.preventDefault();
        onIndexChange((index + 1) % images.length);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        onIndexChange((index - 1 + images.length) % images.length);
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [images.length, index, onIndexChange]);

  return (
    <OctantDialog
      className="image-preview-dialog"
      initialFocus={frame}
      label={current === undefined ? "Image preview" : `Preview ${current.name}`}
      onClose={onClose}
      open={open}
      {...(props.restoreFocus === undefined ? {} : { restoreFocus: props.restoreFocus })}
    >
      <div className="image-preview" ref={frame} tabIndex={-1}>
        <div className="image-preview__stage">
          {current === undefined ? null : (
            <img alt={current.name} className="image-preview__image" src={current.url} />
          )}
        </div>
        <p className="image-preview__caption">
          <span className="image-preview__name">{current?.name}</span>
          <span className="image-preview__meta">
            {[
              current?.bytes === undefined ? undefined : formatImageSize(current.bytes),
              images.length > 1 && index !== undefined
                ? `${index + 1} of ${images.length}`
                : undefined,
            ]
              .filter((part) => part !== undefined)
              .join(" · ")}
          </span>
        </p>
      </div>
    </OctantDialog>
  );
}
