import type { ProviderInstanceId } from "@octant/contracts/providers";
import { useId, useState } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";

export interface MoveToAccountChoice {
  readonly id: ProviderInstanceId;
  readonly name: string;
}

export interface MoveToAccountDialogProps {
  /** Other ready accounts of the thread's provider that offer its model. */
  readonly accounts: ReadonlyArray<MoveToAccountChoice>;
  /** Moves the thread; resolves to the host's refusal, or undefined when it moved. */
  readonly onMove: (providerInstanceId: ProviderInstanceId) => Promise<string | undefined>;
  readonly onClose: () => void;
}

/**
 * Moves a thread to another account of the same provider. The move is the
 * person's: the next message starts a new session on that account with the
 * conversation handed over as text, and the copy says what stays behind.
 */
export function MoveToAccountDialog(props: MoveToAccountDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | undefined>(undefined);

  async function move(providerInstanceId: ProviderInstanceId): Promise<void> {
    if (busy) return;
    setBusy(true);
    setRefusal(undefined);
    try {
      const refused = await props.onMove(providerInstanceId);
      if (refused === undefined) props.onClose();
      else setRefusal(refused);
    } catch {
      setRefusal("The conversation could not be moved. Nothing changed; try again.");
    } finally {
      setBusy(false);
    }
  }

  function requestClose() {
    if (!busy) props.onClose();
  }

  return (
    <OctantDialog
      className="project-dialog"
      describedBy={descriptionId}
      label="Move to account"
      labelledBy={titleId}
      onClose={requestClose}
      open
      popupId="move-to-account-dialog"
    >
      <div className="project-dialog__header">
        <h1 id={titleId}>Move to account</h1>
      </div>
      <p id={descriptionId}>
        Your next message starts a new session on the account you pick, with this conversation
        handed over as text. Hidden reasoning, tool activity and the current session stay behind,
        and the transcript marks the handoff.
      </p>
      <ul aria-label="Accounts" className="move-to-project__list">
        {props.accounts.map((account) => (
          <li key={String(account.id)}>
            <OctantButton
              disabled={busy}
              onClick={() => void move(account.id)}
              type="button"
              variant="ghost"
            >
              {account.name}
            </OctantButton>
          </li>
        ))}
      </ul>
      <div className="project-dialog__actions">
        <OctantButton disabled={busy} onClick={requestClose} type="button" variant="outline">
          Cancel
        </OctantButton>
      </div>
      {refusal === undefined ? null : <OctantAlert tone="danger">{refusal}</OctantAlert>}
    </OctantDialog>
  );
}
