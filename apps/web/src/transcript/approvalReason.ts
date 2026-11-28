import type { PermissionMode } from "@octant/contracts/providers";

/**
 * Why a thread stopped to ask, in one line read from its mode: the sentence
 * under an approval card's question. It names the mode the person chose, not
 * the rule that matched, so it reads the same in Code and Work and never
 * claims more than the mode says.
 */
const REASON: Readonly<Record<PermissionMode, string>> = {
  "ask-first": "This thread asks before it runs commands or changes files.",
  "accept-edits": "This thread edits files on its own and asks before it runs commands.",
  auto: "This thread's reviewer left this one to you.",
  plan: "This thread is planning, read-only, so it asks first.",
  "full-access": "This thread runs with Full access, and this one still asks you.",
};

export function approvalReason(mode: PermissionMode): string {
  return REASON[mode];
}
