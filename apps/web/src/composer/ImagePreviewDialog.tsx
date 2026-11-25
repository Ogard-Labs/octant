import { lazy, Suspense } from "react";
import { OctantDialog } from "../ui/base/OctantDialog";
import type { ImagePreviewDialogProps } from "./ImagePreviewLightbox";
import "./image-preview-trigger.css";

const ImagePreviewLightbox = lazy(() =>
  import("./ImagePreviewLightbox").catch(() => ({ default: ImagePreviewUnavailable })),
);

function ImagePreviewUnavailable(props: ImagePreviewDialogProps) {
  return (
    <OctantDialog
      label="Image preview unavailable"
      onClose={props.onClose}
      open={props.index !== undefined}
      {...(props.restoreFocus === undefined ? {} : { restoreFocus: props.restoreFocus })}
    >
      <p>Reload Octant to try opening the image again.</p>
    </OctantDialog>
  );
}

export function ImagePreviewDialog(props: ImagePreviewDialogProps) {
  if (props.images.length === 0) return null;
  return (
    <Suspense fallback={null}>
      <ImagePreviewLightbox {...props} />
    </Suspense>
  );
}
