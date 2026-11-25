import type { ReactNode } from "react";
import type { MobilePlaceId } from "./places";

export interface PlaceTabsProps {
  readonly active: MobilePlaceId;
  readonly barHidden: boolean;
  readonly onSelect: (place: MobilePlaceId) => void;
  readonly onNew: () => void;
  /** Off while the computer new threads go to takes none from this phone. */
  readonly newDisabled: boolean;
  /** Each place's own stack, by place. A place not opened yet has none. */
  readonly screens: Readonly<Partial<Record<MobilePlaceId, ReactNode>>>;
}
