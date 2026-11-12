import { useId, useRef, useState, type ReactNode } from "react";
import { Camera, FolderOpen, Plus } from "lucide-react";
import { OctantButton, octantButtonClassName } from "../ui/base/OctantButton";
import { OctantMenu } from "../ui/base/OctantMenu";
import { OctantDialogPresence } from "../ui/base/OctantDialogPresence";
import { WindowCaptureDialog, windowCaptureBridge } from "./WindowCaptureDialog";

export interface ComposerAttachButtonProps {
  readonly accept?: string | undefined;
  readonly busy?: boolean | undefined;
  readonly refusedReason?: string | undefined;
  readonly onRefused: (reason: string) => void;
  readonly onFileSelected: (file: File) => void;
  /**
   * What the thread offers besides attachments (marking it done, how it
   * delivers documents), as its own group in the same menu. The plus is then
   * always a menu, since the thread's actions are not an attachment.
   */
  readonly threadActions?: ReadonlyArray<ComposerThreadAction>;
}

export interface ComposerThreadAction {
  readonly disabled?: boolean;
  readonly icon?: ReactNode;
  readonly label: string;
  readonly onSelect: () => void;
}

/**
 * The visible control owns the only tab stop; refusals use the caller's status
 * line. In the macOS desktop app the plus opens a menu of two ways to attach,
 * a file or a capture of an open window; everywhere else it opens the file
 * chooser directly. It is a plus on a quiet round fill: it adds to the
 * message, by more than one route, and it mirrors send at the pill's other
 * end.
 */
export function ComposerAttachButton(props: ComposerAttachButtonProps) {
  const input = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const [capturing, setCapturing] = useState(false);
  const capture = windowCaptureBridge(window.octantHost);
  const threadActions = props.threadActions ?? [];
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
      {capture === undefined && threadActions.length === 0 ? (
        <OctantButton
          aria-label="Add attachment"
          disabled={props.busy === true}
          onClick={() => {
            if (canChoose()) input.current?.click();
          }}
          size="icon"
          title={props.refusedReason ?? "Add attachment"}
          type="button"
          variant="secondary"
        >
          <Plus aria-hidden="true" size={16} />
        </OctantButton>
      ) : (
        <>
          <OctantMenu
            actions={threadActions}
            items={[
              {
                icon: <FolderOpen aria-hidden="true" size={14} />,
                label: "Choose file…",
                value: "file",
              },
              ...(capture === undefined
                ? []
                : [
                    {
                      icon: <Camera aria-hidden="true" size={14} />,
                      label: "Capture window…",
                      value: "capture-window",
                    },
                  ]),
            ]}
            onValueChange={(value) => {
              if (!canChoose()) return;
              if (value === "file") input.current?.click();
              else if (value === "capture-window") setCapturing(true);
            }}
            selectionMode="action"
            trigger={<Plus aria-hidden="true" size={16} />}
            triggerClassName={octantButtonClassName({ variant: "secondary", size: "icon" })}
            triggerDisabled={props.busy === true}
            triggerLabel={
              threadActions.length === 0 ? "Add attachment" : "Add attachment or task action"
            }
            triggerTitle={threadActions.length === 0 ? "Add attachment" : "Add"}
            value=""
          />
          <OctantDialogPresence>
            {capturing && capture !== undefined ? (
              <WindowCaptureDialog
                bridge={capture}
                onCaptured={(file) => {
                  if (canChoose()) props.onFileSelected(file);
                }}
                onClose={() => setCapturing(false)}
                onNotice={props.onRefused}
              />
            ) : null}
          </OctantDialogPresence>
        </>
      )}
    </>
  );
}
