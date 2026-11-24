import type { ThreadSecretAnswer } from "@octant/contracts/thread-secrets";
import { ThreadSecretCard } from "./ThreadSecretCard";
import { useThreadSecrets } from "./threadSecretsFeed";

/** The cards an agent's requests wait in, at the end of the conversation. */
export function ThreadSecrets(props: {
  readonly threadId: string;
  readonly serverUrl?: string | undefined;
  readonly windowCapability?: string | undefined;
}) {
  const { threadId } = props;
  const { view, unavailable, send, browse } = useThreadSecrets(props);
  if (view.requests.length === 0) return null;
  const answer = (value: ThreadSecretAnswer) => send({ kind: "answer", threadId, answer: value });
  return (
    <div className="thread-column thread-secrets" aria-label="Secret requests">
      {unavailable ? <p role="status">Octant is reconnecting to this computer.</p> : null}
      {view.requests.map((card) => (
        <ThreadSecretCard
          key={card.id}
          card={card}
          answer={answer}
          browse={(step, signal) => browse(card.id, step, signal)}
        />
      ))}
    </div>
  );
}
