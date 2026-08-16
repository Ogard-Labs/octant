import type { MobileCreateMode } from "./createModePresentation";

export type MobileWorkMode = Exclude<MobileCreateMode, "chat">;
export type MobileHomeView = "inbox" | MobileCreateMode;

export function backMobileHomeView(view: MobileHomeView): MobileHomeView | undefined {
  return view === "inbox" ? undefined : "inbox";
}
