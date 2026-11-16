import type { MobileCreateMode } from "./createModePresentation";

export type MobileWorkMode = Exclude<MobileCreateMode, "chat">;
export type MobileHomeView = "inbox" | Exclude<MobileCreateMode, "chat">;

export function backMobileHomeView(view: MobileHomeView): MobileHomeView | undefined {
  return view === "inbox" ? undefined : "inbox";
}
