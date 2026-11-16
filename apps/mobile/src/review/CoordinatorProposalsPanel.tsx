import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  approveCoordinatorProposal,
  declineCoordinatorProposal,
  loadMobileCoordinatorProposals,
  mobileCoordinatorProposalPort,
  OWNER_POSTURE_LABELS,
  sendMobileCodeTurn,
  type MobileCoordinatorProposal,
  type MobileRemoteTransport,
} from "@octant/client-runtime";
import type { CodeThread } from "@octant/contracts";
import { useTheme } from "../../design-system/theme";
import { space as mobileSpacing, typography as mobileTypography } from "../../design-system/tokens";

/**
 * A coordinator's pending proposed workers on the phone
 * (docs/design/coordinator-threads.md#the-start-setting). A phone the host's
 * own person paired approves a worker as it was asked for, or declines it,
 * and the host journals the phone as the actor; choosing another provider,
 * checkout or level stays with the review at a window on the host. Every
 * other session sees what waits and where to approve it, since the host
 * refuses its decision.
 */
export function CoordinatorProposalsPanel(props: {
  readonly transport: MobileRemoteTransport;
  readonly thread: CodeThread;
  /** What the host said of this session; absent or false shows no decision. */
  readonly actsAsHostPerson?: boolean;
}) {
  const { colors } = useTheme();
  const { transport } = props;
  const { id, projectId } = props.thread;
  const threadId = String(id);
  const [proposals, setProposals] = useState<{
    readonly threadId: string;
    readonly entries: ReadonlyArray<MobileCoordinatorProposal>;
  }>();
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const decide = async (run: () => Promise<string | undefined>) => {
    setBusy(true);
    setMessage(undefined);
    try {
      setMessage(await run());
    } catch {
      setMessage("The decision reply was lost. Refresh before deciding again.");
    } finally {
      setBusy(false);
      setRevision((value) => value + 1);
    }
  };
  const approve = (entry: MobileCoordinatorProposal) =>
    decide(async () => {
      const approved = await approveCoordinatorProposal({
        port: mobileCoordinatorProposalPort(transport),
        entry,
        coordinator: props.thread,
      });
      if (approved.status === "refused") return approved.message;
      // The worker is durable whether or not its first turn starts.
      try {
        await sendMobileCodeTurn({
          transport,
          threadId: String(approved.thread.id),
          prompt: entry.proposal.intent,
        });
      } catch {
        return "The worker was created, but its first message could not be sent. Open it to retry.";
      }
      return "Worker approved and started.";
    });
  const decline = (entry: MobileCoordinatorProposal) =>
    decide(async () => {
      const declined = await declineCoordinatorProposal({
        port: mobileCoordinatorProposalPort(transport),
        entry,
      });
      return declined.status === "declined" ? "Worker declined." : declined.message;
    });
  const button = (key: string, label: string, act: () => void) => (
    <Pressable
      key={key}
      accessibilityRole="button"
      accessibilityState={{ disabled: busy }}
      disabled={busy}
      onPress={act}
      style={{
        padding: mobileSpacing.md,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: mobileSpacing.sm,
        opacity: busy ? 0.5 : 1,
      }}
    >
      <Text style={{ color: colors.textPrimary }}>{label}</Text>
    </Pressable>
  );
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const entries = await loadMobileCoordinatorProposals(transport, { id, projectId });
        if (!disposed) setProposals({ threadId, entries });
      } catch {
        // A failed read keeps the last one; the next poll tries again.
      }
      if (!disposed) timer = setTimeout(() => void read(), 10_000);
    };
    void read();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [transport, id, threadId, projectId, revision]);
  const entries = proposals?.threadId === threadId ? proposals.entries : [];
  if (entries.length === 0 && message === undefined) return null;
  return (
    <View style={{ gap: mobileSpacing.sm }} testID="mobile-coordinator-proposals">
      {entries.map((entry) => (
        <View
          accessibilityLabel={`Proposed worker: ${entry.proposal.title}`}
          key={String(entry.proposal.id)}
          style={{
            gap: mobileSpacing.xs,
            padding: mobileSpacing.md,
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: mobileSpacing.sm,
          }}
        >
          <Text style={{ color: colors.textSecondary, ...mobileTypography.caption }}>
            Worker · waiting for approval
          </Text>
          <Text style={{ color: colors.textPrimary, fontWeight: "600" }}>
            {entry.proposal.title}
          </Text>
          <Text style={{ color: colors.textPrimary }}>{entry.proposal.intent}</Text>
          {entry.proposal.workerOptions === undefined ? null : (
            <Text style={{ color: colors.textSecondary }}>
              Requested level: {OWNER_POSTURE_LABELS[entry.proposal.workerOptions.executionPolicy]}{" "}
              or lower
            </Text>
          )}
          {props.actsAsHostPerson === true ? (
            <>
              {button("approve", "Approve and start", () => void approve(entry))}
              {button("decline", "Decline", () => void decline(entry))}
            </>
          ) : (
            <Text style={{ color: colors.textSecondary }}>
              Approve at a window on this computer.
            </Text>
          )}
        </View>
      ))}
      {message === undefined ? null : (
        <Text accessibilityLiveRegion="polite" style={{ color: colors.textSecondary }}>
          {message}
        </Text>
      )}
    </View>
  );
}
