import { useState } from "react";
import type { ConversationInputPolicy } from "@octant/contracts/conversation-inputs";

/** One explicit next-turn choice, scoped to the same endpoint and task as the unsent draft. */
export function useContinuationInputPolicy(
  mode: "chat" | "work" | "code",
  threadId: string,
  serverUrl?: string,
) {
  const key = `octant.continuation-inputs.v1:${serverUrl ?? globalThis.location?.origin ?? ""}:${mode}:${threadId}`;
  const read = (): ConversationInputPolicy => {
    try {
      return globalThis.localStorage.getItem(key) === "text-only" ? "text-only" : "preserve";
    } catch {
      return "preserve";
    }
  };
  const [selected, setSelected] = useState(() => ({ key, policy: read() }));
  const change = (policy: ConversationInputPolicy) => {
    try {
      if (policy === "preserve") globalThis.localStorage.removeItem(key);
      else globalThis.localStorage.setItem(key, policy);
    } catch {
      /* Sending remains usable without local storage. */
    }
    setSelected({ key, policy });
  };
  return {
    policy: selected.key === key ? selected.policy : read(),
    change,
    reset: () => change("preserve"),
  };
}
