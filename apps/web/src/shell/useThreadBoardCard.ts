import type { CodeBoardCard, CodeBoardQuery, CodeBoardView, ProjectId } from "@octant/contracts";
import { useEffect, useState } from "react";

/**
 * The board's card for one Code thread: its checkout and the files it has
 * changed, as the host observed them.
 *
 * The board is the one read that carries the changed-file count, so the dock
 * overview borrows it rather than asking Git itself. It is read only while the
 * dock is showing that overview (`enabled`), and a later read keeps the card
 * already on screen until the fresh one lands, so a slow or refused board never
 * blanks the Changes section.
 */
export function useThreadBoardCard(input: {
  readonly loadBoard: ((query: CodeBoardQuery) => Promise<CodeBoardView>) | undefined;
  readonly projectId: ProjectId | undefined;
  readonly threadId: string;
  readonly enabled: boolean;
  readonly changeRevision: number;
}): CodeBoardCard | undefined {
  const [card, setCard] = useState<{
    readonly threadId: string;
    readonly card: CodeBoardCard;
  }>();
  const { loadBoard, projectId, threadId, enabled, changeRevision } = input;
  useEffect(() => {
    if (!enabled || loadBoard === undefined || projectId === undefined) return;
    let cancelled = false;
    loadBoard({ version: 1, projectIds: [projectId] }).then(
      (view) => {
        if (cancelled) return;
        const found = view.cards.find((candidate) => String(candidate.threadId) === threadId);
        if (found !== undefined) setCard({ threadId, card: found });
      },
      () => {
        // A board that cannot be read says nothing new.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [enabled, loadBoard, projectId, threadId, changeRevision]);
  // A card read for another thread must not describe this one.
  return card?.threadId === threadId ? card.card : undefined;
}
