import type { ThreadVideoArchiveDownload } from "@octant/contracts/thread-export";
import { formatBytes } from "../environment/threadMove/threadMoveSize";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { OctantDialogPresence } from "../ui/base/OctantDialogPresence";

export function ThreadVideoArchiveConfirmation(props: {
  readonly archive: ThreadVideoArchiveDownload | undefined;
  readonly onClose: () => void;
  readonly onDownload: () => void;
}) {
  const { archive, onClose, onDownload } = props;
  return (
    <OctantDialogPresence>
      {archive === undefined ? null : (
        <OctantConfirmDialog
          title="Export thread"
          confirmLabel="Download archive"
          onCancel={onClose}
          onConfirm={() => {
            const link = document.createElement("a");
            link.href = archive.url;
            link.download = "";
            link.rel = "noreferrer";
            document.body.append(link);
            link.click();
            link.remove();
            onDownload();
          }}
        >
          The {formatBytes(archive.size)} archive includes the transcript and {archive.clipCount}{" "}
          {archive.clipCount === 1 ? "video clip" : "video clips"}.
        </OctantConfirmDialog>
      )}
    </OctantDialogPresence>
  );
}
