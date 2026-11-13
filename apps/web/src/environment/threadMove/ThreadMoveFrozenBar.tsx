import type { MovedThreadReference, ThreadMoveThreadStatus } from "@octant/contracts";
import { useState, type ReactNode } from "react";
import { OctantButton } from "../../ui/base/OctantButton";
import { percent } from "./ThreadMoveComputerCard";
import { formatBytes } from "./threadMoveSize";
import type { ThreadMoveClient } from "./threadMoveClient";

/**
 * What holds a thread so that its composer gives way to the frozen bar:
 * moving away, set to move once its turn ends, waiting for an owner phone to
 * confirm the move, handed over through its branch, or arriving here and not
 * yet committed. A failed move holds nothing; its notice sits in the
 * Environment and the composer returns.
 */
export function holdsThread(status: ThreadMoveThreadStatus | undefined): boolean {
  return (
    status?.sending !== undefined ||
    status?.waiting !== undefined ||
    status?.waitingForPhone !== undefined ||
    status?.handedOver !== undefined ||
    status?.arriving !== undefined
  );
}

/**
 * The bar that takes the composer's place while a move holds the thread. The
 * host already refuses every command on a held thread; the bar says what
 * holds it and offers the one action that releases it, instead of a composer
 * whose every send would be refused with the moving reason. Canonical:
 * docs/design/hub-and-spokes.md "Moving a thread: screens", "While it moves".
 */
export function ThreadMoveFrozenBar(props: {
  readonly client: ThreadMoveClient;
  readonly thread: MovedThreadReference;
  readonly status: ThreadMoveThreadStatus;
  readonly onChanged: () => void;
}) {
  const [working, setWorking] = useState(false);
  const [takeBackOffered, setTakeBackOffered] = useState(false);
  const { sending, waiting, waitingForPhone, handedOver, arriving } = props.status;
  const act = (action: () => Promise<unknown>) => {
    setWorking(true);
    void action().finally(() => {
      setWorking(false);
      props.onChanged();
    });
  };

  if (sending !== undefined) {
    const value = percent(sending);
    return (
      <FrozenBarFrame
        action={
          takeBackOffered ? (
            <OctantButton
              disabled={working}
              onClick={() => {
                act(() => props.client.takeBack(String(sending.moveId)));
                setTakeBackOffered(false);
              }}
              size="sm"
              variant="outline"
            >
              Take back here
            </OctantButton>
          ) : (
            <OctantButton
              disabled={working || sending.state === "committed"}
              onClick={() =>
                act(async () => {
                  const outcome = await props.client.cancel(String(sending.moveId));
                  setTakeBackOffered(outcome === "destination-unreachable");
                })
              }
              size="sm"
              variant="outline"
            >
              Cancel move
            </OctantButton>
          )
        }
        progress={
          <div
            aria-label={`Moving to ${sending.destinationName}`}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={value}
            className="thread-move-frozen__progress"
            role="progressbar"
          >
            <span style={{ width: `${String(value)}%` }} />
          </div>
        }
        title={`Moving to ${sending.destinationName}`}
      >
        {takeBackOffered ? (
          `${sending.destinationName} can't be reached to confirm. Take it back here and that computer may still hold a copy.`
        ) : (
          <span className="thread-move-frozen__figures">
            {formatBytes(sending.bytesSent)} of {formatBytes(sending.bytesTotal)}
          </span>
        )}
      </FrozenBarFrame>
    );
  }

  if (waiting !== undefined) {
    return (
      <FrozenBarFrame
        action={
          <OctantButton
            disabled={working}
            onClick={() => act(() => props.client.stopWaiting(props.thread))}
            size="sm"
            variant="outline"
          >
            Don't move
          </OctantButton>
        }
        title={`Moving to ${waiting.destinationName} after this turn`}
      >
        A new message would start another turn and keep the move waiting.
      </FrozenBarFrame>
    );
  }

  // Nothing is frozen on the host yet, but a message sent now would start a
  // turn, and a move set to start at once would then be refused as busy.
  if (waitingForPhone !== undefined) {
    return (
      <FrozenBarFrame
        action={
          <OctantButton
            disabled={working}
            onClick={() => act(() => props.client.stopWaiting(props.thread))}
            size="sm"
            variant="outline"
          >
            Don't move
          </OctantButton>
        }
        title="Waiting for your phone"
      >
        Confirm on your phone to move this thread to {waitingForPhone.destinationName}. It waits
        until{" "}
        {new Date(waitingForPhone.expiresAt).toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
        })}
        .
      </FrozenBarFrame>
    );
  }

  if (handedOver !== undefined) {
    return (
      <FrozenBarFrame
        action={
          <OctantButton
            disabled={working}
            onClick={() => act(() => props.client.handoverTakeBack(String(handedOver.handoverId)))}
            size="sm"
            variant="outline"
          >
            Take back here
          </OctantButton>
        }
        title={
          <>
            Handed over on <code className="thread-move-frozen__branch">{handedOver.branch}</code>
          </>
        }
      >
        {handedOver.pushed
          ? "Continue it on any computer that can fetch that branch."
          : "The branch isn't pushed, so the work is on no other computer yet."}
      </FrozenBarFrame>
    );
  }

  if (arriving !== undefined) {
    return (
      <FrozenBarFrame
        {...(arriving.mayActivateAnyway
          ? {
              action: (
                <OctantButton
                  disabled={working}
                  onClick={() => act(() => props.client.activate(String(arriving.moveId)))}
                  size="sm"
                  variant="outline"
                >
                  Activate anyway
                </OctantButton>
              ),
            }
          : {})}
        title={`Arriving from ${arriving.originName}`}
      >
        {arriving.mayActivateAnyway
          ? `${arriving.originName} froze this thread before it went away, so it can't have gone on there.`
          : `This thread opens here once ${arriving.originName} confirms the move.`}
      </FrozenBarFrame>
    );
  }

  return null;
}

function FrozenBarFrame(props: {
  readonly title: ReactNode;
  readonly children: ReactNode;
  readonly progress?: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <section aria-label="This thread is held by a move" className="composer thread-move-frozen">
      <div className="thread-move-frozen__surface">
        {props.progress}
        <div className="thread-move-frozen__body">
          <div className="thread-move-frozen__text">
            <p className="thread-move-frozen__title">{props.title}</p>
            <p className="thread-move-frozen__meta">{props.children}</p>
          </div>
          {props.action}
        </div>
      </div>
    </section>
  );
}
