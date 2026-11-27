import type { ReactNode } from "react";
import type { MobilePlaceId } from "./places";

export interface PlaceTabsProps {
  readonly active: MobilePlaceId;
  /** True while a thread's composer has the corner a drawn New would cover. */
  readonly newHidden: boolean;
  readonly onSelect: (place: MobilePlaceId) => void;
  readonly onNew: () => void;
  /** Off while the computer new threads go to takes none from this phone. */
  readonly newDisabled: boolean;
  /** Each place's own stack, by place. A place not opened yet has none. */
  readonly screens: Readonly<Partial<Record<MobilePlaceId, ReactNode>>>;
}
