import type { TabsScreenIconIOS } from "react-native-screens";
import type { MobileIconName } from "../ui/IconButton";

type SFSymbol = Extract<TabsScreenIconIOS, { type: "sfSymbol" }>["name"];

export type MobilePlaceId = "home" | "bots" | "threads" | "prs" | "inbox";

export interface MobilePlace {
  readonly id: MobilePlaceId;
  /** Spoken for the icon-only item. */
  readonly label: string;
  readonly symbol: SFSymbol;
  readonly selectedSymbol: SFSymbol;
  readonly icon: MobileIconName;
  readonly selectedIcon: MobileIconName;
  /** False for a place whose own work has not landed; it keeps its order. */
  readonly shipped: boolean;
}

export const MOBILE_PLACES: ReadonlyArray<MobilePlace> = [
  {
    id: "home",
    label: "Home",
    symbol: "house",
    selectedSymbol: "house.fill",
    icon: "home-outline",
    selectedIcon: "home",
    shipped: true,
  },
  {
    id: "bots",
    label: "Bots",
    symbol: "sparkles",
    selectedSymbol: "sparkles",
    icon: "sparkles-outline",
    selectedIcon: "sparkles",
    shipped: false,
  },
  {
    id: "threads",
    label: "Threads",
    symbol: "bubble.left.and.bubble.right",
    selectedSymbol: "bubble.left.and.bubble.right.fill",
    icon: "chatbubbles-outline",
    selectedIcon: "chatbubbles",
    shipped: true,
  },
  {
    id: "prs",
    label: "Pull requests",
    symbol: "arrow.triangle.pull",
    selectedSymbol: "arrow.triangle.pull",
    icon: "git-pull-request-outline",
    selectedIcon: "git-pull-request",
    shipped: false,
  },
  {
    id: "inbox",
    label: "Inbox",
    symbol: "tray",
    selectedSymbol: "tray.fill",
    icon: "file-tray-outline",
    selectedIcon: "file-tray",
    shipped: true,
  },
];

export function shippedMobilePlaces(): ReadonlyArray<MobilePlace> {
  return MOBILE_PLACES.filter((place) => place.shipped);
}

export function placeFor(id: string): MobilePlaceId {
  return shippedMobilePlaces().find((place) => place.id === id)?.id ?? "home";
}

/** A thread takes the bottom of the window for its composer, as a pushed
 * conversation does in the system's own apps. */
export function screenHidesBar(screen: string): boolean {
  return screen === "thread";
}
