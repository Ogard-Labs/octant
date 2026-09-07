import { useId, useRef } from "react";
import { Paperclip } from "lucide-react";
import { OctantButton } from "../ui/base/OctantButton";

export interface ComposerAttachButtonProps {
  readonly accept?: string | undefined;
  readonly busy?: boolean | undefined;
  readonly refusedReason?: string | undefined;
  readonly onRefused: (reason: string) => void;
  readonly onFileSelected: (file: File) => void;
}

/** The visible control owns the only tab stop; refusals use the caller's status line. */
export function ComposerAttachButton(props: ComposerAttachButtonProps) {
  const input = useRef<HTMLInputElement>(null);
  const inputId = useId();
  function canChoose(): boolean {
    if (props.busy === true) return false;
    if (props.refusedReason === undefined) return true;
    props.onRefused(props.refusedReason);
    return false;
  }
  return (
    <>
      <label className="composer-attachment-input" htmlFor={inputId}>
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
    </>
  );
}
