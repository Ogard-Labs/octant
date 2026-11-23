import type { ThreadVideoArchiveDownload } from "@octant/contracts/thread-export";
import { useState } from "react";
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
        <ArchiveDialog
          key={archive.url}
          archive={archive}
          onClose={onClose}
          onDownload={onDownload}
        />
      )}
    </OctantDialogPresence>
  );
}

function ArchiveDialog({
  archive,
  onClose,
  onDownload,
}: {
  readonly archive: ThreadVideoArchiveDownload;
  readonly onClose: () => void;
  readonly onDownload: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  async function confirm() {
    setPending(true);
    setFailed(false);
    try {
      await downloadArchive(archive.url);
      onDownload();
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }
  return (
    <OctantConfirmDialog
      title="Export thread"
      confirmLabel="Download archive"
      onCancel={onClose}
      onConfirm={() => void confirm()}
      pending={pending}
      details={failed ? "Could not start the archive download." : undefined}
    >
      The {formatBytes(archive.size)} archive includes the transcript and {archive.clipCount}{" "}
      {archive.clipCount === 1 ? "video clip" : "video clips"}.
      {archive.size >= 1024 ? ` Exact size ${archive.size.toLocaleString("en-US")} bytes.` : ""}
    </OctantConfirmDialog>
  );
}

async function downloadArchive(url: string): Promise<void> {
  const desktop = window.octantHost?.downloadThreadVideoArchive;
  if (desktop !== undefined || window.location.protocol === "file:") {
    const ticket = new URL(url).searchParams.get("ticket");
    if (ticket === null || desktop === undefined || !(await desktop(ticket)))
      throw new Error("The desktop could not start the archive download.");
    return;
  }
  const link = document.createElement("a");
  link.href = url;
  link.download = "";
  link.rel = "noreferrer";
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
  }
}
