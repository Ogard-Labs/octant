import { useCallback, useRef, useState } from "react";
import { Text } from "react-native";
import {
  answerMobileChatQuestion,
  answerMobileCodeQuestion,
  listMobileCodePendingQuestions,
  type MobileCodePendingQuestion,
  type MobileQuestionAnswerOutcome,
  type MobileRemoteTransport,
} from "@octant/client-runtime";
import type { ChatThreadView } from "@octant/contracts";
import { useTheme } from "../../design-system";
import { MOBILE_COPY } from "../copy";
import { usePolledResource } from "../runtime/usePolledResource";
import { mobileTypography } from "../theme/tokens";
import { MobileQuestionnaireCard, MobileSingleQuestionCard } from "./MobileQuestionnaireCard";

function useQuestionAnswer(onSettled: () => void, watchingOnly: boolean) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [note, setNote] = useState<string>();
  const run = async (send: () => Promise<MobileQuestionAnswerOutcome>): Promise<boolean> => {
    if (watchingOnly || busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setNote(undefined);
    try {
      const outcome = await send();
      if (outcome.status === "refused") {
        setNote(outcome.message);
        return false;
      }
      return true;
    } catch {
      setNote(MOBILE_COPY.approvalSendFailed);
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
      onSettled();
    }
  };
  return { busy, note, run };
}

export interface ChatQuestionCardsProps {
  readonly transport: MobileRemoteTransport;
  readonly view: ChatThreadView;
  readonly watchingOnly?: boolean;
  readonly onSettled: () => void;
}

/**
 * Pending provider questions and questionnaires waiting on a Chat thread,
 * rendered with the shared mobile questionnaire card.
 */
export function ChatQuestionCards(props: ChatQuestionCardsProps) {
  const pending = props.view.turns.flatMap((turn) =>
    turn.attempts.flatMap((attempt) =>
      attempt.outcome === "waiting" && attempt.pendingQuestion !== undefined
        ? [{ turn, attempt, question: attempt.pendingQuestion }]
        : [],
    ),
  );
  if (pending.length === 0) return null;
  return (
    <>
      {pending.map(({ turn, attempt, question }) => (
        <ChatQuestionCard
          attemptId={String(attempt.id)}
          expectedVersion={props.view.thread.version}
          key={`${String(attempt.id)}:${question.requestId}`}
          onSettled={props.onSettled}
          question={question}
          threadId={String(props.view.thread.id)}
          transport={props.transport}
          turnId={String(turn.id)}
          watchingOnly={props.watchingOnly === true}
        />
      ))}
    </>
  );
}

function ChatQuestionCard(props: {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  readonly expectedVersion: number;
  readonly turnId: string;
  readonly attemptId: string;
  readonly question: NonNullable<
    ChatThreadView["turns"][number]["attempts"][number]["pendingQuestion"]
  >;
  readonly watchingOnly: boolean;
  readonly onSettled: () => void;
}) {
  const { busy, note, run } = useQuestionAnswer(props.onSettled, props.watchingOnly);
  const submit = (answer: string) =>
    run(() =>
      answerMobileChatQuestion({
        transport: props.transport,
        threadId: props.threadId,
        expectedVersion: props.expectedVersion,
        turnId: props.turnId,
        attemptId: props.attemptId,
        requestId: props.question.requestId,
        answer,
      }),
    );

  if (props.question.questionnaire !== undefined && props.question.secret !== true) {
    return (
      <MobileQuestionnaireCard
        busy={busy}
        draftKey={`chat:${props.transport.hostId}:${props.threadId}:${props.attemptId}:${props.question.requestId}`}
        note={note}
        noteTestID="mobile-chat-question-note"
        onSubmit={(response) => submit(JSON.stringify(response))}
        prompt={props.question.prompt}
        questionnaire={props.question.questionnaire}
        submitTestID="mobile-chat-questionnaire-submit"
        testID="mobile-chat-questionnaire"
        watchingOnly={props.watchingOnly}
      />
    );
  }

  return (
    <MobileSingleQuestionCard
      busy={busy}
      note={note}
      noteTestID="mobile-chat-question-note"
      onSubmit={(answer) => void submit(answer)}
      options={props.question.options}
      prompt={props.question.prompt}
      secret={props.question.secret}
      submitTestID="mobile-chat-question-submit"
      testID="mobile-chat-question"
      watchingOnly={props.watchingOnly}
    />
  );
}

export interface CodeQuestionCardsProps {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  readonly watchingOnly?: boolean;
  readonly refreshIntervalMs?: number;
  readonly onSettled?: () => void;
}

/**
 * Pending provider questions and questionnaires waiting on a Code thread,
 * read from the host's pending-requests list and answered through the thread's
 * own provider-input operation.
 */
export function CodeQuestionCards(props: CodeQuestionCardsProps) {
  const { colors } = useTheme();
  const load = useCallback(
    () => listMobileCodePendingQuestions(props.transport, props.threadId),
    [props.transport, props.threadId],
  );
  const resource = usePolledResource(load, { intervalMs: props.refreshIntervalMs ?? 2_000 });
  const questions = resource.value ?? [];
  if (questions.length === 0) return null;

  const settled = () => {
    void resource.reload();
    props.onSettled?.();
  };

  return (
    <>
      {questions.map((question) => (
        <CodeQuestionCard
          key={question.answer.requestId}
          onSettled={settled}
          question={question}
          transport={props.transport}
          watchingOnly={props.watchingOnly === true}
        />
      ))}
      {resource.error === undefined ? null : (
        <Text style={[mobileTypography.caption, { color: colors.textSecondary }]}>
          {MOBILE_COPY.approvalReconnecting}
        </Text>
      )}
    </>
  );
}

function CodeQuestionCard(props: {
  readonly transport: MobileRemoteTransport;
  readonly question: MobileCodePendingQuestion;
  readonly watchingOnly: boolean;
  readonly onSettled: () => void;
}) {
  const { busy, note, run } = useQuestionAnswer(props.onSettled, props.watchingOnly);
  const submit = (response: string) =>
    run(() =>
      answerMobileCodeQuestion({
        transport: props.transport,
        threadId: String(props.question.answer.threadId),
        checkoutId: String(props.question.answer.checkoutId),
        requestId: props.question.answer.requestId,
        response,
      }),
    );

  if (props.question.questionnaire !== undefined && props.question.secret !== true) {
    return (
      <MobileQuestionnaireCard
        busy={busy}
        draftKey={`code:${props.transport.hostId}:${String(props.question.threadId)}:${props.question.answer.requestId}`}
        note={note}
        noteTestID="mobile-code-question-note"
        onSubmit={(response) => submit(JSON.stringify(response))}
        prompt={props.question.text}
        questionnaire={props.question.questionnaire}
        submitTestID="mobile-code-questionnaire-submit"
        testID="mobile-code-questionnaire"
        watchingOnly={props.watchingOnly}
      />
    );
  }

  return (
    <MobileSingleQuestionCard
      busy={busy}
      note={note}
      noteTestID="mobile-code-question-note"
      onSubmit={(answer) => void submit(answer)}
      options={props.question.options}
      prompt={props.question.text}
      secret={props.question.secret}
      submitTestID="mobile-code-question-submit"
      testID="mobile-code-question"
      watchingOnly={props.watchingOnly}
    />
  );
}
