import { FolderOpen, MessageSquare } from "lucide-react";
import { createContext, useContext } from "react";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";
import type { WorkKind } from "./workKind";

export interface WorkKindChoice {
  /** The kind the composer on screen starts. */
  readonly kind: WorkKind;
  /** The kinds Settings leaves enabled; one kind leaves nothing to choose. */
  readonly kinds: ReadonlyArray<WorkKind>;
  readonly onSwitch: (kind: WorkKind) => void;
}

export const WorkKindChoiceContext = createContext<WorkKindChoice | undefined>(undefined);

/**
 * The Work composer's one question before the first message: chat, or work in
 * a folder. It only chooses which kind of thread the composer creates, and the
 * two kinds keep their own authority on the host: a Chat never gains a folder,
 * and a thread keeps the kind it started with, so the switch is offered on new
 * thread composers and never inside a thread.
 */
export function WorkKindSwitch() {
  const choice = useContext(WorkKindChoiceContext);
  if (choice === undefined || choice.kinds.length < 2) return null;
  return (
    <OctantToggleGroup<WorkKind>
      aria-label="Thread kind"
      className="work-kind-switch"
      onValueChange={(value) => {
        const selected = value[0];
        if (selected !== undefined && selected !== choice.kind) choice.onSwitch(selected);
      }}
      value={[choice.kind]}
    >
      <OctantToggleGroupItem title="Chat answers without touching your files" value="chat">
        <MessageSquare aria-hidden="true" size={14} strokeWidth={1.8} />
        Chat
      </OctantToggleGroupItem>
      <OctantToggleGroupItem
        title="Reads and edits files in one folder you choose, and nowhere else"
        value="work"
      >
        <FolderOpen aria-hidden="true" size={14} strokeWidth={1.8} />
        In a folder
      </OctantToggleGroupItem>
    </OctantToggleGroup>
  );
}
