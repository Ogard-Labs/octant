import { Ellipsis } from "lucide-react";
import type { ReactNode } from "react";
import { OctantContextMenu } from "../ui/base/OctantContextMenu";
import { OctantMenu, type OctantMenuItem } from "../ui/base/OctantMenu";

export type TurnAction = OctantMenuItem;

export interface TurnActionMenuProps {
  readonly actions: ReadonlyArray<TurnAction>;
  readonly children: ReactNode;
  readonly onAction: (value: string) => void;
}

/**
 * One turn's secondary actions: a More actions control that appears on hover
 * or focus, and the same items on the platform context menu. Right-click is
 * never the only route, and the control stays in the tree so revealing it
 * cannot shift the transcript.
 */
export function TurnActionMenu(props: TurnActionMenuProps) {
  if (props.actions.length === 0) return props.children;
  return (
    <OctantContextMenu
      items={props.actions}
      onValueChange={props.onAction}
      triggerClassName="turn-action-menu"
    >
      {props.children}
      <div className="turn-action-menu__more">
        <OctantMenu
          items={props.actions}
          onValueChange={props.onAction}
          trigger={<Ellipsis aria-hidden="true" className="icon" size={16} strokeWidth={1.5} />}
          triggerClassName="btn-icon window-no-drag"
          triggerLabel="More actions"
          value=""
        />
      </div>
    </OctantContextMenu>
  );
}

/**
 * Writes to the clipboard when the host exposes one. A host without clipboard
 * access is not an error the reader can act on, so it stays silent — the same
 * shape the conversation export already uses.
 */
export async function copyText(value: string): Promise<void> {
  const writeText = globalThis.navigator?.clipboard?.writeText;
  if (typeof writeText !== "function") return;
  try {
    await writeText.call(globalThis.navigator.clipboard, value);
  } catch {
    // The host refused the clipboard; nothing was copied and nothing is claimed.
  }
}
