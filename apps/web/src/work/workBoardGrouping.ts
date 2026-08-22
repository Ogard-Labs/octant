import type { WorkBoardCard, WorkBoardStatus, WorkBoardStatusReason } from "@octant/contracts";
import {
  groupThreadBoardCards,
  threadBoardStatusLabel,
  threadBoardStatusReasonLabel,
  type GroupThreadBoardCardsOptions,
  type ThreadBoardColumn,
  type ThreadBoardGrouping,
  type ThreadBoardProjectRef,
} from "../threadBoard/threadBoardGrouping";

export type WorkBoardGrouping = ThreadBoardGrouping;
export type WorkBoardColumn = ThreadBoardColumn<WorkBoardCard>;
export type WorkBoardProjectRef = ThreadBoardProjectRef;
export type GroupWorkBoardCardsOptions = GroupThreadBoardCardsOptions;

export const workBoardStatusLabel = threadBoardStatusLabel;
export const workBoardStatusReasonLabel = threadBoardStatusReasonLabel;

export function groupWorkBoardCards(
  cards: readonly WorkBoardCard[],
  grouping: WorkBoardGrouping,
  options: GroupWorkBoardCardsOptions,
): readonly WorkBoardColumn[] {
  return groupThreadBoardCards(cards, grouping, options);
}

export type { WorkBoardStatus, WorkBoardStatusReason };
