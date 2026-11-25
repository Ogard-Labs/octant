import type { MobileInboxRow } from "@octant/client-runtime";
import type { MobileIconName } from "../ui/IconButton";

export function threadModeLabel(mode: MobileInboxRow["mode"]): string {
  return mode === "code" ? "Code" : mode === "work" ? "Work" : "Chat";
}

export function threadModeIcon(mode: MobileInboxRow["mode"]): MobileIconName {
  if (mode === "work") return "briefcase-outline";
  return mode === "code" ? "code-slash" : "chatbubble-outline";
}
