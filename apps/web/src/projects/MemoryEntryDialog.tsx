import type { MemoryEntryId, MemoryKind } from "@octant/contracts/projects";
import { useId, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
import { OctantNativeSelect } from "../ui/base/OctantSelect";
import { OctantTextarea } from "../ui/base/OctantTextarea";

type MemoryEntryDialogMode =
  | { readonly kind: "create" }
  | { readonly kind: "supersede"; readonly entryId: MemoryEntryId; readonly content: string }
  | { readonly kind: "retract"; readonly entryId: MemoryEntryId; readonly content: string };

export interface MemoryEntryDialogProps {
  readonly busy: boolean;
  readonly mode: MemoryEntryDialogMode;
  readonly onClose: () => void;
  readonly onCreate: (kind: MemoryKind, content: string) => Promise<boolean>;
  readonly onRetract: (entryId: MemoryEntryId, reason: string) => Promise<boolean>;
  readonly onSupersede: (entryId: MemoryEntryId, content: string) => Promise<boolean>;
}

export function MemoryEntryDialog(props: MemoryEntryDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const [kind, setKind] = useState<MemoryKind>("decision");
  const [value, setValue] = useState("");
  const title =
    props.mode.kind === "create"
      ? "Add Project memory"
      : props.mode.kind === "supersede"
        ? "Replace Project memory"
        : "Retract Project memory";

  function requestClose() {
    if (props.busy) return;
    props.onClose();
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const normalized = value.trim();
    if (normalized === "" || props.busy) return;
    const succeeded =
      props.mode.kind === "create"
        ? await props.onCreate(kind, normalized)
        : props.mode.kind === "supersede"
          ? await props.onSupersede(props.mode.entryId, normalized)
          : await props.onRetract(props.mode.entryId, normalized);
    if (succeeded) props.onClose();
  }

  return (
    <OctantDialog
      className="project-dialog memory-entry-dialog"
      label={title}
      onClose={requestClose}
      open
      popupId="memory-entry-dialog"
    >
      <div className="project-dialog__header">
        <div>
          <span>Approved context</span>
          <h1 id={titleId}>{title}</h1>
        </div>
        <OctantButton
          aria-label={`Close ${title}`}
          disabled={props.busy}
          onClick={requestClose}
          size="icon"
          type="button"
          variant="ghost"
        >
          ×
        </OctantButton>
      </div>
      <p id={descriptionId}>
        {props.mode.kind === "create"
          ? "Choose exactly what this Project may remember. Nothing is inferred from conversations."
          : props.mode.kind === "supersede"
            ? "The original entry stays in audited history and the replacement receives a new identity."
            : "Retraction keeps the original content and records your reason in audited history."}
      </p>
      {props.mode.kind === "create" ? (
        <label>
          Memory kind
          <OctantNativeSelect
            onChange={(event) => setKind(event.target.value as MemoryKind)}
            value={kind}
          >
            <option value="decision">Decision</option>
            <option value="fact">Fact</option>
            <option value="preference">Preference</option>
            <option value="summary">Summary</option>
            <option value="outcome">Outcome</option>
          </OctantNativeSelect>
        </label>
      ) : (
        <blockquote className="memory-entry-dialog__original">{props.mode.content}</blockquote>
      )}
      <form onSubmit={(event) => void submit(event)}>
        <label>
          {props.mode.kind === "create"
            ? "Memory content"
            : props.mode.kind === "supersede"
              ? "Replacement content"
              : "Retraction reason"}
          <OctantTextarea
            autoFocus
            onChange={(event) => setValue(event.target.value)}
            required
            rows={5}
            value={value}
          />
        </label>
        <div className="project-dialog__actions">
          <OctantButton
            disabled={props.busy}
            onClick={requestClose}
            type="button"
            variant="outline"
          >
            Cancel
          </OctantButton>
          <OctantButton
            disabled={props.busy || value.trim() === ""}
            type="submit"
            variant="default"
          >
            {props.mode.kind === "create"
              ? "Add memory"
              : props.mode.kind === "supersede"
                ? "Replace memory"
                : "Confirm retraction"}
          </OctantButton>
        </div>
      </form>
    </OctantDialog>
  );
}
