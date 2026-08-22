import type { CodeBoardCard, CodeBoardStatus, CodeBoardStatusReason } from "@octant/contracts";
import {
  groupThreadBoardCards,
  threadBoardStatusLabel,
  threadBoardStatusReasonLabel,
  type GroupThreadBoardCardsOptions,
  type ThreadBoardColumn,
  type ThreadBoardGrouping,
  type ThreadBoardProjectRef,
} from "../threadBoard/threadBoardGrouping";

export type CodeBoardGrouping = ThreadBoardGrouping;
export type CodeBoardColumn = ThreadBoardColumn<CodeBoardCard>;
export type CodeBoardProjectRef = ThreadBoardProjectRef;
export type GroupCodeBoardCardsOptions = GroupThreadBoardCardsOptions;

export const codeBoardStatusLabel = threadBoardStatusLabel;
export const codeBoardStatusReasonLabel = threadBoardStatusReasonLabel;

export function groupCodeBoardCards(
  cards: readonly CodeBoardCard[],
  grouping: CodeBoardGrouping,
  options: GroupCodeBoardCardsOptions,
): readonly CodeBoardColumn[] {
  return groupThreadBoardCards(cards, grouping, options);
}

export type { CodeBoardStatus, CodeBoardStatusReason };
