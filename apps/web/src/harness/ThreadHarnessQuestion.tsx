import { useCallback, useEffect, useRef, useState } from "react";
import type { NativeHarnessSessionView } from "@octant/contracts";
import type { NativeHarnessClient } from "@octant/client-runtime/native-harness-client";
import { scheduleVisibleInterval } from "../polling/documentVisibility";
import { ProviderQuestionCard } from "../transcript/ProviderQuestionCard";
import { OctantAlert } from "../ui/base/OctantAlert";
import "./native-harness.css";

export interface ThreadHarnessQuestionProps {
  readonly client: Pick<NativeHarnessClient, "session" | "answerQuestion">;
  readonly threadId: string;
  /**
   * The thread list already says this thread waits on the person. It starts the
   * quick refresh straight away; without it the card reads the session once and
   * then only while a question is showing, so an idle thread costs one read.
   */
  readonly waiting?: boolean;
  readonly refreshIntervalMs?: number;
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
  const { client, threadId } = props;
  const [read, setRead] = useState<{
    readonly threadId: string;
    readonly view: NativeHarnessSessionView | null;
  }>();
  const [notice, setNotice] = useState<string>();
  const generation = useRef(0);
  const inFlight = useRef(false);
  const answering = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const mine = ++generation.current;
    try {
      const view = await client.session(threadId);
      // A response for a thread the card has left must not paint over the one
      // it shows now.
      if (generation.current === mine) setRead({ threadId, view });
    } catch {
      // Keep what was last read while the host reconnects.
    } finally {
      inFlight.current = false;
    }
  }, [client, threadId]);

  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  const view = read?.threadId === threadId ? read.view : undefined;
  const question =
    view === null ||
    view === undefined ||
    view.session.mode !== "work" ||
    view.session.status === "recovery-required"
      ? undefined
      : view.questions.find((entry) => entry.status === "pending" && entry.source === undefined);
  const polling = props.waiting === true || question !== undefined;
  useEffect(() => {
    void load();
    if (!polling) return;
    return scheduleVisibleInterval(() => void load(), props.refreshIntervalMs ?? 1_500);
  }, [load, polling, props.refreshIntervalMs]);
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
        await load();
        answering.current = false;
      }
    },
    [question, client, threadId, load],
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
