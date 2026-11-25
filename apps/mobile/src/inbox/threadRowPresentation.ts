import { mobileWaitingAskLine, type MobileInboxRow } from "@octant/client-runtime";
import type { ThemeColors } from "../../design-system";
import type { MobileIconName } from "../ui/IconButton";
import { inboxWorkStatus } from "./inboxWorkPresentation";

export function threadModeLabel(mode: MobileInboxRow["mode"]): string {
  return mode === "code" ? "Code" : mode === "work" ? "Work" : "Chat";
}

export function threadModeIcon(mode: MobileInboxRow["mode"]): MobileIconName {
  if (mode === "work") return "briefcase-outline";
  return mode === "code" ? "code-slash" : "chatbubble-outline";
}

export function threadRowDetail(row: MobileInboxRow, parts: ReadonlyArray<string>): string {
  const ask = row.waitingAsk === undefined ? [] : [mobileWaitingAskLine(row.waitingAsk)];
  return [...parts, ...ask].join(" · ");
}

export function threadStatusTone(row: MobileInboxRow, colors: ThemeColors): string {
  const status = inboxWorkStatus(row.status, row.reviewState, row.live);
  if (status === "Needs attention") return colors.warning;
  if (status === "Working") return colors.attention;
  return status === "In review" ? colors.merged : colors.textTertiary;
}
