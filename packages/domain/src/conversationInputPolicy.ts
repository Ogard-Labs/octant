import type {
  ConversationInputPurpose,
  ConversationInputReference,
} from "@octant/contracts/conversation-inputs";

type Mode = ConversationInputReference["source"]["mode"];
const MODES: Readonly<Record<ConversationInputPurpose, ReadonlyArray<Mode>>> = {
  "child-delegation": ["chat", "work", "code"],
  "provider-switch": ["chat", "work", "code"],
  rewind: ["chat", "work", "code"],
  fork: ["work", "code"],
  branch: ["chat"],
  "fork-merge-back": ["code"],
};

/** The modes with an existing continuation path; inputs do not invent a new path. */
export function permitsConversationInputs(purpose: ConversationInputPurpose, mode: Mode): boolean {
  return MODES[purpose].includes(mode);
}
