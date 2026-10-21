import type { NativeHarnessSteeringNote } from "@octant/contracts";
import type { HostRefusal } from "./agentHost";

export interface AgentSteeringFollowUp {
  readonly text: string;
  readonly status: "submission-unknown" | "ownership-unknown";
  readonly message: string;
}

type SendPrompt = (text: string) => Promise<HostRefusal | { readonly kind: "sent" }>;

/** The ports also report server errors as refusals, so none proves safe automatic resubmission. */
export async function sendSteeringFollowUp(
  text: string,
  send: SendPrompt,
): Promise<AgentSteeringFollowUp | undefined> {
  try {
    const result = await send(text);
    return result.kind === "refused"
      ? {
          text,
          status: "submission-unknown",
          message: `${result.message} Acceptance was not confirmed. Check the conversation and queue before resending.`,
        }
      : undefined;
  } catch {
    return {
      text,
      status: "submission-unknown",
      message:
        "The host did not confirm the next prompt. Check the conversation and queue before resending.",
    };
  }
}

/** A lost take response cannot establish ownership, even if we saw the notes before it. */
export async function takeSteeringFollowUp(input: {
  readonly displayedText: string;
  readonly take: () => Promise<
    | HostRefusal
    | { readonly kind: "taken"; readonly notes: ReadonlyArray<NativeHarnessSteeringNote> }
  >;
  readonly send: SendPrompt;
}): Promise<AgentSteeringFollowUp | undefined> {
  let taken;
  try {
    taken = await input.take();
  } catch {
    return {
      text: input.displayedText,
      status: "ownership-unknown",
      message:
        "The host did not confirm who took the notes. Check the conversation and queue before resending.",
    };
  }
  if (taken.kind === "refused") {
    return { text: input.displayedText, status: "ownership-unknown", message: taken.message };
  }
  if (taken.notes.length === 0) return undefined;
  return sendSteeringFollowUp(taken.notes.map((note) => note.text).join("\n\n"), input.send);
}
