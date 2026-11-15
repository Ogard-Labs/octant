import { History } from "../ui/icons";
import { useCallback, useEffect, useRef, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { moveWithinRadioGroup } from "../ui/base/radioGroupKeys";
import type { ThreadSessionClient } from "./codeSessionClient";
import "./code-native-session.css";

type Listed = Awaited<ReturnType<NonNullable<ThreadSessionClient<string>["nativeSessions"]>>>;

const lastWritten = (milliseconds: number) =>
  new Date(milliseconds).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/**
 * Starting an empty Work or Code thread from a session its provider keeps for
 * this folder and account, begun outside Octant, and, once started from one,
 * the session's own id in the thread's details. Nothing shows for a thread
 * that has messages of its own and was not started from a session, or while
 * the provider offers none.
 */
export function CodeNativeSession<Id extends string>(props: {
  readonly threadId: Id;
  readonly threadHasTurns: boolean;
  readonly client: ThreadSessionClient<Id> | undefined;
}) {
  const { threadId, threadHasTurns, client } = props;
  const [listed, setListed] = useState<Listed>();
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const activeThread = useRef(String(threadId));
  activeThread.current = String(threadId);

  const refresh = useCallback(async () => {
    if (client?.nativeSessions === undefined) return;
    const key = String(threadId);
    try {
      const next = await client.nativeSessions(threadId);
      if (activeThread.current === key) setListed(next);
    } catch {
      if (activeThread.current === key) setListed(undefined);
    }
  }, [client, threadId]);

  useEffect(() => {
    setListed(undefined);
    setOpen(false);
    setChosen(undefined);
    setMessage(undefined);
    void refresh();
  }, [refresh, threadHasTurns]);

  const adopt = async () => {
    if (client?.adoptNativeSession === undefined || chosen === undefined) return;
    const choice = listed?.sessions.find((session) => session.nativeSessionId === chosen);
    if (choice === undefined) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await client.adoptNativeSession(threadId, choice.nativeSessionId);
      if ("message" in result) setMessage(result.message);
      else setOpen(false);
      await refresh();
    } catch {
      setMessage("The host could not start this thread from that session. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const adopted = listed?.adopted;
  if (adopted !== undefined) {
    return (
      <section aria-label="Thread details" className="code-native-session">
        <div className="code-native-session__row">
          <History aria-hidden="true" size={14} className="code-native-session__icon" />
          <span className="code-native-session__label">
            Continues a session started outside Octant
          </span>
          <code className="code-native-session__id" title={adopted.nativeSessionId}>
            {adopted.nativeSessionId}
          </code>
          <OctantButton
            type="button"
            size="sm"
            variant="ghost"
            aria-label="Copy the session id"
            onClick={() => void navigator.clipboard?.writeText(adopted.nativeSessionId)}
          >
            Copy
          </OctantButton>
        </div>
      </section>
    );
  }
  if (threadHasTurns || listed === undefined || listed.sessions.length === 0) return null;
  return (
    <section aria-label="Sessions started outside Octant" className="code-native-session">
      <div className="code-native-session__row">
        <History aria-hidden="true" size={14} className="code-native-session__icon" />
        <span className="code-native-session__label">
          {listed.sessions.length === 1
            ? "1 session in this folder was started outside Octant"
            : `${String(listed.sessions.length)} sessions in this folder were started outside Octant`}
        </span>
        <OctantButton
          type="button"
          size="sm"
          variant="ghost"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "Hide" : "Continue one"}
        </OctantButton>
      </div>
      {open ? (
        <div className="code-native-session__choices">
          <p className="code-native-session__legend" id={`native-session-${String(threadId)}`}>
            Continue a session in this thread
          </p>
          <div
            aria-labelledby={`native-session-${String(threadId)}`}
            className="code-native-session__options"
            role="radiogroup"
            onKeyDown={moveWithinRadioGroup}
          >
            {listed.sessions.map((session) => (
              <div
                key={session.nativeSessionId}
                className="code-native-session__choice"
                data-checked={chosen === session.nativeSessionId ? "" : undefined}
              >
                <OctantButton
                  aria-checked={chosen === session.nativeSessionId}
                  className="code-native-session__option"
                  role="radio"
                  size={null}
                  type="button"
                  variant="ghost"
                  onClick={() => setChosen(session.nativeSessionId)}
                >
                  <span className="code-native-session__title">
                    {session.title ?? session.nativeSessionId}
                  </span>
                  <span className="code-native-session__meta">
                    {session.gitBranch === undefined ? "" : `${session.gitBranch} · `}
                    {lastWritten(session.lastModified)}
                  </span>
                </OctantButton>
              </div>
            ))}
          </div>
          <div className="code-native-session__actions">
            <OctantButton
              type="button"
              size="sm"
              disabled={busy || chosen === undefined}
              onClick={() => void adopt()}
            >
              Continue in this thread
            </OctantButton>
          </div>
        </div>
      ) : null}
      {message === undefined ? null : (
        <p className="code-native-session__message" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
