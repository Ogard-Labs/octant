import { useEffect, useRef, useState } from "react";
import {
  decodeThreadMessageQueueCommand,
  decodeThreadMessageQueueScope,
  type NativeHarnessSteeringNote,
  type OctantMode,
  type ThreadMessageQueueCommand,
} from "@octant/contracts";
import type { NativeHarnessClient } from "@octant/client-runtime/native-harness-client";
import type { ThreadMessageQueueClient } from "../messageQueue/threadMessageQueueClient";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";

interface Props {
  readonly client: Pick<NativeHarnessClient, "takeSteering">;
  readonly queue: ThreadMessageQueueClient;
  readonly threadId: string;
  readonly mode: OctantMode;
  readonly settled: boolean;
  readonly blocked?: boolean;
  readonly onBusy?: (busy: boolean) => void;
  readonly onRetryPending?: (pending: boolean) => void;
  readonly notes: ReadonlyArray<NativeHarnessSteeringNote>;
  readonly refresh: () => Promise<unknown>;
}

interface Claimed {
  readonly notes: ReadonlyArray<NativeHarnessSteeringNote>;
  readonly command: ThreadMessageQueueCommand;
}

/** The host, not a displayed snapshot, decides which client owns the notes. */
export function UnreachedSteeringFollowUp(props: Props) {
  const attempted = useRef(new Set<string>());
  const working = useRef(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [canRetryClaim, setCanRetryClaim] = useState(false);
  const [retained, setRetained] = useState<ReadonlyArray<NativeHarnessSteeringNote>>([]);
  const [retry, setRetry] = useState<
    { readonly kind: "send" | "admit"; readonly claimed: Claimed } | undefined
  >();

  const retryPending = retry !== undefined;
  useEffect(() => {
    props.onRetryPending?.(retryPending);
    return () => props.onRetryPending?.(false);
  }, [props.onRetryPending, retryPending]);

  async function admit(claimed: Claimed) {
    try {
      const snapshot = await props.queue.read(claimed.command.scope);
      if (snapshot.paused || snapshot.holdReason !== undefined) {
        setNotice("The message queue is on hold. Resume it before retrying these notes.");
        return;
      }
      await submit({
        ...claimed,
        command: decodeThreadMessageQueueCommand({
          ...claimed.command,
          expectedVersion: snapshot.version,
          requestId: crypto.randomUUID(),
        }),
      });
    } catch {
      setNotice(
        "The message queue is unavailable. Your notes remain below; retry when it is available.",
      );
    }
  }

  async function submit(claimed: Claimed) {
    try {
      const result = await props.queue.execute(claimed.command);
      if (result.status === "applied" || result.status === "duplicate") {
        setRetained([]);
        setRetry(undefined);
        setNotice(undefined);
      } else {
        setRetry({ kind: "admit", claimed });
        const reason =
          result.status === "refused"
            ? `The host refused it: ${result.reason.replaceAll("-", " ")}.`
            : "The queue changed before it could be added.";
        setNotice(
          `The follow-up was not queued. ${reason} Your notes remain in this window; retry the next message when ready.`,
        );
      }
    } catch {
      // The host may already have queued this message. Check the same id;
      // putting the notes back now could start a second copy.
      setRetry({ kind: "send", claimed });
      setNotice(
        "The next message may already be queued. Check submission to confirm it without sending a second copy.",
      );
    }
  }

  async function claim() {
    const notes = props.notes.filter((note) => note.status === "queued");
    if (notes.length === 0 || working.current || props.blocked) return;
    working.current = true;
    props.onBusy?.(true);
    setBusy(true);
    setCanRetryClaim(false);
    try {
      const scope = decodeThreadMessageQueueScope({ mode: props.mode, threadId: props.threadId });
      let snapshot;
      try {
        snapshot = await props.queue.read(scope);
      } catch {
        setCanRetryClaim(true);
        setNotice("The message queue is unavailable. The notes have not been taken.");
        return;
      }
      if (snapshot.paused || snapshot.holdReason !== undefined) {
        setCanRetryClaim(true);
        setNotice("The message queue is on hold. Resume it before sending the unreached notes.");
        return;
      }
      let taken;
      try {
        taken = await props.client.takeSteering(props.threadId);
      } catch {
        setRetained(notes);
        setNotice(
          "The host did not confirm who took these notes. Another client may have them. Check the thread before sending them again; they will not be replayed automatically.",
        );
        return;
      }
      const first = taken.taken[0];
      if (first === undefined) return;
      const claimed: Claimed = {
        notes: taken.taken,
        command: decodeThreadMessageQueueCommand({
          kind: "enqueue",
          scope,
          expectedVersion: snapshot.version,
          requestId: crypto.randomUUID(),
          messageId: first.id,
          payload: { mode: props.mode, prompt: taken.taken.map((note) => note.text).join("\n\n") },
        }),
      };
      setRetained(claimed.notes);
      await submit(claimed);
    } finally {
      working.current = false;
      props.onBusy?.(false);
      setBusy(false);
      await props.refresh();
    }
  }

  const signature = props.notes
    .filter((note) => note.status === "queued")
    .map((note) => note.id)
    .join(",");
  useEffect(() => {
    if (
      !props.settled ||
      props.blocked ||
      working.current ||
      retry !== undefined ||
      retained.length > 0 ||
      signature === "" ||
      attempted.current.has(signature)
    )
      return;
    attempted.current.add(signature);
    void claim();
  }, [props.settled, props.blocked, signature, busy, retry, retained.length]);

  if (notice === undefined && retained.length === 0) return null;
  return (
    <div>
      {retained.length === 0 ? null : (
        <ul aria-label="Notes awaiting follow-up confirmation">
          {retained.map((note) => (
            <li key={note.id}>{note.text}</li>
          ))}
        </ul>
      )}
      {notice === undefined ? null : <OctantAlert tone="warning">{notice}</OctantAlert>}
      {!canRetryClaim || !props.settled ? null : (
        <OctantButton disabled={busy} size="sm" variant="secondary" onClick={() => void claim()}>
          Send as next message
        </OctantButton>
      )}
      {retry === undefined ? null : (
        <OctantButton
          disabled={busy || props.blocked || (retry.kind === "admit" && !props.settled)}
          size="sm"
          variant="secondary"
          onClick={() => {
            if (working.current || props.blocked || (retry.kind === "admit" && !props.settled))
              return;
            working.current = true;
            props.onBusy?.(true);
            setBusy(true);
            void (retry.kind === "send" ? submit(retry.claimed) : admit(retry.claimed)).finally(
              async () => {
                working.current = false;
                props.onBusy?.(false);
                setBusy(false);
                await props.refresh();
              },
            );
          }}
        >
          {retry.kind === "send" ? "Check submission" : "Retry next message"}
        </OctantButton>
      )}
    </div>
  );
}
