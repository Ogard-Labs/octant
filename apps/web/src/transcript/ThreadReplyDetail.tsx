import type { ReplyDetailLevel } from "@octant/contracts/shell";
import { ListCollapse } from "lucide-react";
import { createContext, useContext, type ReactNode } from "react";
import { OctantMenu } from "../ui/base/OctantMenu";
import {
  REPLY_DETAIL_LABELS,
  REPLY_DETAIL_MENU_DESCRIPTIONS,
  REPLY_DETAIL_LEVELS,
  ReplyDetailContext,
  useThreadReplyDetail,
  type ReplyDetailThread,
  type ThreadReplyDetailState,
} from "./replyDetail";

const ThreadReplyDetailStateContext = createContext<ThreadReplyDetailState | undefined>(undefined);

/**
 * Draws everything inside it at one thread's Reply detail level: the thread's
 * own choice, else the default. Chat, Work, and Code each wrap their thread in
 * one, so the transcript, the thread's menu, and the shortcut agree.
 */
export function ThreadReplyDetailScope(props: {
  readonly thread: ReplyDetailThread;
  readonly children: ReactNode;
}) {
  const state = useThreadReplyDetail(props.thread);
  return (
    <ThreadReplyDetailStateContext.Provider value={state}>
      <ReplyDetailContext.Provider value={state.level}>
        {props.children}
      </ReplyDetailContext.Provider>
    </ThreadReplyDetailStateContext.Provider>
  );
}

const USE_DEFAULT = "default";

/**
 * The thread's own Reply detail choice: Use default, or a level that stays
 * with this thread. Its name says the level in effect and whether it is the
 * thread's own, because a menu trigger cannot otherwise show the selection.
 * A client that cannot change the level (a paired browser) shows nothing.
 */
export function ThreadReplyDetailMenu(props: { readonly triggerClassName?: string }) {
  const state = useContext(ThreadReplyDetailStateContext);
  if (state === undefined || state.setLevel === undefined) return null;
  const setLevel = state.setLevel;
  const levelLabel = REPLY_DETAIL_LABELS[state.level];
  return (
    <OctantMenu
      items={[
        {
          value: USE_DEFAULT,
          label: `Use default (${REPLY_DETAIL_LABELS[state.defaultLevel]})`,
          description: "Follow the level in Settings",
        },
        ...REPLY_DETAIL_LEVELS.map((level) => ({
          value: level,
          label: REPLY_DETAIL_LABELS[level],
          description: REPLY_DETAIL_MENU_DESCRIPTIONS[level],
        })),
      ]}
      onValueChange={(value) => setLevel(levelOfMenuValue(value))}
      trigger={<ListCollapse aria-hidden="true" className="icon" size={16} strokeWidth={1.5} />}
      triggerClassName={props.triggerClassName ?? "shell-icon-button"}
      triggerLabel={
        state.override === undefined
          ? `Reply detail: ${levelLabel}, the default`
          : `Reply detail: ${levelLabel}, this thread's own`
      }
      value={state.override ?? USE_DEFAULT}
    />
  );
}

function levelOfMenuValue(value: string): ReplyDetailLevel | undefined {
  return REPLY_DETAIL_LEVELS.find((level) => level === value);
}
