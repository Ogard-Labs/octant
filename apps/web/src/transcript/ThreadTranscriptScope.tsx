import type { ComponentProps } from "react";
import { ResultQuoteScope } from "./ResultQuoteScope";
import { ThreadReplyDetailScope } from "./ThreadReplyDetail";

export function ThreadTranscriptScope(props: ComponentProps<typeof ThreadReplyDetailScope>) {
  const { mode, threadId } = props.thread;
  return (
    <ThreadReplyDetailScope thread={props.thread}>
      <ResultQuoteScope threadId={`${mode}:${threadId}`}>{props.children}</ResultQuoteScope>
    </ThreadReplyDetailScope>
  );
}
