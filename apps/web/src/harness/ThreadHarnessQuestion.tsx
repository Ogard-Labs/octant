import { useCallback, useEffect, useRef, useState } from "react";
import type { NativeHarnessSessionView } from "@octant/contracts";
import type { NativeHarnessClient } from "@octant/client-runtime/native-harness-client";
import { ProviderQuestionCard } from "../transcript/ProviderQuestionCard";
import { OctantAlert } from "../ui/base/OctantAlert";
import "./native-harness.css";

export interface ThreadHarnessQuestionProps {
  readonly client: Pick<NativeHarnessClient, "answerQuestion">;
  readonly threadId: string;
  /** The thread's session as `ThreadHarnessCards` last read it. */
  readonly view: NativeHarnessSessionView | null | undefined;
  readonly reload: () => Promise<unknown>;
}

/**
 * A Work lead's own pending question that a turn can still receive. Code's
 * and Chat's reach their threads another way, a subagent's is the Agents
 * tab's, and one a restart left behind reaches no turn.
 */
export function workLeadQuestion(view: NativeHarnessSessionView | null | undefined) {
  return view === null ||
    view === undefined ||
    view.session.mode !== "work" ||
    view.session.status === "recovery-required"
    ? undefined
    : view.questions.find((entry) => entry.status === "pending" && entry.source === undefined);
}

/**
 * A Work thread's agent asking the person its own question, shown in the
 * thread it blocks, beside the composer, the way a Work or Code question is.
 * Anyone reading the thread can answer it without opening the Agents tab.
 *
 * The card decides nothing. The answer goes to the thread's session route,
 * the one the Agents tab answers through, which checks the window and the
 * principal on the host first. Only a Work session's question is shown: a
 * Code lead's question already reaches its thread through Code's inline
 * question, and a Chat lead's question parks the Chat turn and shows in the
 * transcript. A subagent's question is not shown here; the Agents tab answers
 * it. A question a restart left behind reaches no turn, so it is not offered.
 */
export function ThreadHarnessQuestion(props: ThreadHarnessQuestionProps) {
  const { client, threadId, view, reload } = props;
  const [notice, setNotice] = useState<string>();
  const answering = useRef(false);

  const question = workLeadQuestion(view);
  useEffect(() => setNotice(undefined), [threadId, question?.id]);

  const answer = useCallback(
    async (text: string) => {
      // The card has no disabled state of its own, so a second press while the
      // first answer is in flight is dropped here rather than refused by the host.
      if (question === undefined || answering.current) return;
      answering.current = true;
      try {
        const result = await client.answerQuestion(threadId, {
          questionId: String(question.id),
          answer: text,
        });
        setNotice(result.kind === "question-refused" ? result.message : undefined);
      } catch {
        setNotice("The answer was not delivered. Try again.");
      } finally {
        await reload();
        answering.current = false;
      }
    },
    [question, client, threadId, reload],
  );

  if (question === undefined) return null;
  return (
    <div className="thread-harness-question">
      <ProviderQuestionCard
        key={String(question.id)}
        onAnswer={(text) => void answer(text)}
        options={question.options.map((label) => ({ label }))}
        prompt={question.prompt}
      />
      {notice === undefined ? null : (
        <OctantAlert className="native-harness-panel__error" tone="warning">
          {notice}
        </OctantAlert>
      )}
    </div>
  );
}
