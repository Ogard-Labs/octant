/** Words, never colour alone, for the mode a thread belongs to. */
export function threadModeLabel(mode: "chat" | "work" | "code"): string {
  if (mode === "work") return "Work";
  if (mode === "code") return "Code";
  return "Chat";
}
