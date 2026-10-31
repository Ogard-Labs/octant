import { useId, useRef, useState } from "react";
import { Camera, FolderOpen, Paperclip } from "lucide-react";
import { OctantButton, octantButtonClassName } from "../ui/base/OctantButton";
import { OctantMenu } from "../ui/base/OctantMenu";
import { WindowCaptureDialog, windowCaptureBridge } from "./WindowCaptureDialog";

export interface ComposerAttachButtonProps {
  readonly accept?: string | undefined;
  readonly busy?: boolean | undefined;
  readonly refusedReason?: string | undefined;
  readonly onRefused: (reason: string) => void;
  readonly onFileSelected: (file: File) => void;
}

/**
 * The visible control owns the only tab stop; refusals use the caller's status
 * line. In the macOS desktop app the paperclip opens a menu of two ways to
 * attach, a file or a capture of an open window; everywhere else it opens the
 * file chooser directly.
 */
export function ComposerAttachButton(props: ComposerAttachButtonProps) {
  const input = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const [capturing, setCapturing] = useState(false);
  const capture = windowCaptureBridge(window.octantHost);
  function canChoose(): boolean {
    if (props.busy === true) return false;
    if (props.refusedReason === undefined) return true;
    props.onRefused(props.refusedReason);
    return false;
  }
  return (
    <>
      <label className="composer-attachment-input" hidden htmlFor={inputId}>
        Choose attachment file
        {/* ui-boundary-exception: native-file-input */}
        <input
          accept={props.accept}
          disabled={props.busy === true}
          id={inputId}
          onChange={(event) => {
            const file = event.currentTarget.files?.item(0);
            event.currentTarget.value = "";
            if (file !== null && file !== undefined && canChoose()) props.onFileSelected(file);
          }}
          ref={input}
          tabIndex={-1}
          type="file"
        />
      </label>
      {capture === undefined ? (
        <OctantButton
          aria-label="Add attachment"
          disabled={props.busy === true}
          onClick={() => {
            if (canChoose()) input.current?.click();
          }}
          size="icon"
          title={props.refusedReason ?? "Add attachment"}
          type="button"
          variant="ghost"
        >
          <Paperclip aria-hidden="true" size={16} strokeWidth={1.8} />
        </OctantButton>
      ) : (
        <>
          <OctantMenu
            items={[
              {
                icon: <FolderOpen aria-hidden="true" size={14} strokeWidth={1.7} />,
                label: "Choose file…",
                value: "file",
              },
              {
                icon: <Camera aria-hidden="true" size={14} strokeWidth={1.7} />,
                label: "Capture window…",
                value: "capture-window",
              },
            ]}
            onValueChange={(value) => {
              if (!canChoose()) return;
              if (value === "file") input.current?.click();
              else if (value === "capture-window") setCapturing(true);
            }}
            selectionMode="action"
            trigger={<Paperclip aria-hidden="true" size={16} strokeWidth={1.8} />}
            triggerClassName={octantButtonClassName({ variant: "ghost", size: "icon" })}
            triggerDisabled={props.busy === true}
            triggerLabel="Add attachment"
            value=""
          />
          {capturing ? (
            <WindowCaptureDialog
              bridge={capture}
              onCaptured={(file) => {
                if (canChoose()) props.onFileSelected(file);
              }}
              onClose={() => setCapturing(false)}
              onNotice={props.onRefused}
            />
          ) : null}
        </>
      )}
    </>
  );
}
