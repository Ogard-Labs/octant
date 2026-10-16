import { useCallback, useEffect, useRef, useState } from "react";
import type { NativeHarnessSessionView } from "@octant/contracts";
import {
  NativeHarnessClientFailure,
  type NativeHarnessClient,
} from "@octant/client-runtime/native-harness-client";
import { scheduleVisibleInterval } from "../polling/documentVisibility";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import "./native-harness.css";

export interface ThreadHarnessSteeringProps {
  readonly client: Pick<NativeHarnessClient, "session" | "steer">;
  readonly threadId: string;
  /** The thread list says a turn is running; it starts and stops the quick refresh. */
  readonly running: boolean;
  readonly refreshIntervalMs?: number;
}

/**
 * Notes for the lead of a running turn, beside the composer. A note reaches
 * the lead inside its next tool result, so one can only be queued while a turn
 * is live; between turns the composer sends an ordinary message. The control
 * decides nothing: it posts to the thread's session steering route, which
 * checks the window and the principal on the host, so a window or paired
 * device gets exactly the reach it already has there.
 *
 * Only a thread whose lead is the Octant harness has a session; any other
 * thread reads one `null` and renders nothing.
 */
export function ThreadHarnessSteering(props: ThreadHarnessSteeringProps) {
  const { client, threadId, running } = props;
  const [read, setRead] = useState<{
    readonly threadId: string;
    readonly view: NativeHarnessSessionView | null;
  }>();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const generation = useRef(0);
  const inFlight = useRef(false);
  // A retried send keeps its id, so the host lands the note once however many
  // times the request had to be repeated.
  const pendingNoteId = useRef<string | undefined>(undefined);

  const load = useCallback(async () => {
    if (inFlight.current) return undefined;
    inFlight.current = true;
    const mine = ++generation.current;
    try {
      const view = await client.session(threadId);
      // A response for a thread the control has left must not paint over the
      // one it shows now.
      if (generation.current === mine) setRead({ threadId, view });
      return view;
    } catch {
      // Keep what was last read while the host reconnects.
      return undefined;
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
  useEffect(() => {
    setDraft("");
    setNotice(undefined);
    pendingNoteId.current = undefined;
  }, [threadId]);

  const view = read?.threadId === threadId ? read.view : undefined;
  const hasSession = view !== null;
  // One read when the thread opens and when a turn starts or ends, so notes
  // the lead never reached show up at the turn's end.
  useEffect(() => {
    void load();
  }, [load, running]);
  useEffect(() => {
    if (!running || !hasSession) return;
    return scheduleVisibleInterval(() => void load(), props.refreshIntervalMs ?? 2_000);
  }, [load, running, hasSession, props.refreshIntervalMs]);

  const send = useCallback(
    async (text: string) => {
      if (busy) return;
      setBusy(true);
      pendingNoteId.current ??= globalThis.crypto.randomUUID();
      try {
        await client.steer(threadId, { kind: "queue", text, noteId: pendingNoteId.current });
        pendingNoteId.current = undefined;
        setDraft("");
        setNotice(undefined);
      } catch (failure) {
        // The draft stays, with its id, so the person can send it again.
        setNotice(
          failure instanceof NativeHarnessClientFailure
            ? failure.message
            : "The note was not queued. Try again.",
        );
      } finally {
        setBusy(false);
        await load();
      }
    },
    [busy, client, threadId, load],
  );

  const discard = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await client.steer(threadId, { kind: "clear" });
      setNotice(undefined);
    } catch (failure) {
      setNotice(
        failure instanceof NativeHarnessClientFailure
          ? failure.message
          : "The notes were not discarded. Try again.",
      );
    } finally {
      setBusy(false);
      await load();
    }
  }, [busy, client, threadId, load]);

  if (view === null || view === undefined) return null;
  const steerable = view.session.status === "running";
  const notes = view.steering ?? [];
  const unreached = !steerable && notes.some((note) => note.status === "queued");
  if (!steerable && notes.length === 0) return null;

  return (
    <section aria-label="Notes for the lead" className="thread-harness-steering">
      {notes.length === 0 ? null : (
        <ul aria-label="Notes for the running turn" className="native-harness-steering">
          {notes.map((note) => (
            <li key={note.id}>
              <span className="native-harness-steering__status">
                {note.status === "delivered" ? "delivered" : steerable ? "queued" : "not reached"}
              </span>{" "}
              {note.text}
            </li>
          ))}
        </ul>
      )}
      {steerable ? (
        <form
          aria-label="Steer the running turn"
          className="native-harness-panel__actions"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = draft.trim();
            if (trimmed.length > 0) void send(trimmed);
          }}
        >
          <OctantInput
            aria-label="Note for the lead"
            className="thread-harness-steering__input"
            maxLength={4_096}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Add a note for the lead's next step"
            value={draft}
          />
          <OctantButton
            disabled={busy || draft.trim().length === 0}
            size="sm"
            type="submit"
            variant="secondary"
          >
            Send note
          </OctantButton>
        </form>
      ) : null}
      {unreached ? (
        // The terminal sends a note the lead never reached as the next
        // prompt; here the person can drop it instead.
        <div className="native-harness-panel__actions">
          <OctantButton
            disabled={busy}
            onClick={() => void discard()}
            size="sm"
            type="button"
            variant="secondary"
          >
            Discard unsent notes
          </OctantButton>
        </div>
      ) : null}
      {notice === undefined ? null : (
        <OctantAlert className="native-harness-panel__error" tone="warning">
          {notice}
        </OctantAlert>
      )}
    </section>
  );
}
