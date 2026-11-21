import {
  decodeCodeThreadId,
  type CodeProjectPullRequestLinkedThread,
  type CodeThreadId,
} from "@octant/contracts";
import { useMemo, useState } from "react";
import { CodeBlock } from "../transcript/CodeBlock";
import { OctantSelectField } from "../ui/base/OctantSelect";
import {
  CodeLineNotes,
  type CodeLineNoteAnchor,
  type CodeLineNotesSendResult,
} from "./CodeLineNotes";
import { parseUnifiedDiff } from "./unifiedDiff";
import { UnifiedDiffList } from "./UnifiedDiffList";

export interface PullRequestDiffWithNotesProps {
  readonly diff: string;
  readonly diffTruncated: boolean;
  readonly linkedThreads: ReadonlyArray<CodeProjectPullRequestLinkedThread>;
  readonly onSendLineNotes?: (
    threadId: CodeThreadId,
    message: string,
  ) => Promise<CodeLineNotesSendResult>;
  readonly noticeClassName: string;
  readonly emptyClassName?: string;
}

/**
 * Renders a pull request's unified diff with clickable line numbers and
 * window-local line notes that deliver as one ordinary follow-up to a chosen
 * linked Code thread. Posting to GitHub stays a separate explicit action.
 */
export function PullRequestDiffWithNotes(props: PullRequestDiffWithNotesProps) {
  const [noteAnchor, setNoteAnchor] = useState<CodeLineNoteAnchor>();
  const [chosenThreadId, setChosenThreadId] = useState<CodeThreadId>();
  const files = useMemo(
    () => (props.diff.length === 0 ? [] : parseUnifiedDiff(props.diff)),
    [props.diff],
  );
  const selectedThread =
    props.linkedThreads.find((thread) => String(thread.threadId) === String(chosenThreadId)) ??
    props.linkedThreads[0];
  const sendLineNotes = props.onSendLineNotes;
  const sendUnavailable =
    props.linkedThreads.length === 0
      ? "Link a Code thread to send notes"
      : sendLineNotes === undefined
        ? "Open this pull request in a Code window to send notes."
        : undefined;

  // Keep CodeLineNotes mounted across empty or raw-fallback refreshes so
  // unsent pending notes and open drafts are never discarded while the review
  // stays open.
  return (
    <div className="code-pr-review__diff-notes">
      {props.diffTruncated ? (
        <p className={props.noticeClassName} role="note">
          This diff is truncated and is not complete.
        </p>
      ) : null}
      {props.diff.length === 0 ? (
        <p className={props.emptyClassName} role="status">
          No diff observed.
        </p>
      ) : files.length === 0 ? (
        <div className="code-pr-review__diff">
          <CodeBlock code={props.diff} language="diff" />
        </div>
      ) : (
        <div className="code-pr-review__diff">
          <UnifiedDiffList
            files={files}
            onSelectLine={(selection) =>
              setNoteAnchor({
                path: selection.path,
                side: selection.side,
                line: selection.line,
                text: selection.text,
              })
            }
          />
        </div>
      )}
      <CodeLineNotes
        {...(noteAnchor === undefined ? {} : { anchor: noteAnchor })}
        {...(selectedThread === undefined || sendLineNotes === undefined
          ? {}
          : {
              onSend: (message) => sendLineNotes(selectedThread.threadId, message),
            })}
        {...(sendUnavailable === undefined ? {} : { sendUnavailable })}
        {...(props.linkedThreads.length === 0 || selectedThread === undefined
          ? {}
          : {
              sendFooter: (
                <div className="code-line-notes__thread-picker">
                  <OctantSelectField
                    aria-label="Send notes to thread"
                    className="code-line-notes__thread-select"
                    onValueChange={(value) => setChosenThreadId(decodeCodeThreadId(value))}
                    options={props.linkedThreads.map((thread) => ({
                      id: String(thread.threadId),
                      label: thread.title,
                    }))}
                    value={String(selectedThread.threadId)}
                  />
                </div>
              ),
            })}
      />
    </div>
  );
}
