import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import {
  loadMobileCoordinatorProposals,
  OWNER_POSTURE_LABELS,
  type MobileCoordinatorProposal,
  type MobileRemoteTransport,
} from "@octant/client-runtime";
import type { CodeThread } from "@octant/contracts";
import { useTheme } from "../../design-system/theme";
import { space as mobileSpacing, typography as mobileTypography } from "../../design-system/tokens";

/**
 * A coordinator's pending proposed workers on the phone, read-only
 * (docs/design/coordinator-threads.md#the-start-setting). The host's proposal
 * routes refuse a paired caller, so the phone shows what waits and where to
 * approve it, and never offers a decision.
 */
export function CoordinatorProposalsPanel(props: {
  readonly transport: MobileRemoteTransport;
  readonly thread: Pick<CodeThread, "id" | "projectId">;
}) {
  const { colors } = useTheme();
  const { transport } = props;
  const { id, projectId } = props.thread;
  const threadId = String(id);
  const [proposals, setProposals] = useState<{
    readonly threadId: string;
    readonly entries: ReadonlyArray<MobileCoordinatorProposal>;
  }>();
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
  }, [transport, id, threadId, projectId]);
  const entries = proposals?.threadId === threadId ? proposals.entries : [];
  if (entries.length === 0) return null;
  return (
    <View style={{ gap: mobileSpacing.sm }} testID="mobile-coordinator-proposals">
      {entries.map((proposal) => (
        <View
          accessibilityLabel={`Proposed worker: ${proposal.title}`}
          key={String(proposal.id)}
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
          <Text style={{ color: colors.textPrimary, fontWeight: "600" }}>{proposal.title}</Text>
          <Text style={{ color: colors.textPrimary }}>{proposal.intent}</Text>
          {proposal.workerOptions === undefined ? null : (
            <Text style={{ color: colors.textSecondary }}>
              Requested level: {OWNER_POSTURE_LABELS[proposal.workerOptions.executionPolicy]} or
              lower
            </Text>
          )}
          <Text style={{ color: colors.textSecondary }}>Approve at a window on this computer.</Text>
        </View>
      ))}
    </View>
  );
}
