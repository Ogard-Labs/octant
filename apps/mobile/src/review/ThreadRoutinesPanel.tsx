import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { loadMobileThreadRoutines } from "@octant/client-runtime";
import type { MobileRemoteTransport, MobileThreadRoutine } from "@octant/client-runtime";
import { routineScheduleLabel } from "@octant/domain";
import { useTheme } from "../../design-system/theme";
import { space as mobileSpacing, typography as mobileTypography } from "../../design-system/tokens";
import { MOBILE_COPY } from "../copy";

const REFRESH_MS = 10_000;

/**
 * The routines a thread set up, read-only, so the phone shows that something
 * is scheduled and whether it waits for the person. A paired phone may read
 * routines but not change them: resuming or editing one is a window's job, so
 * the panel says where, and offers no button. It shows nothing when the thread
 * has no routine, and keeps the last answer when a read fails.
 */
export function ThreadRoutinesPanel(props: {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  readonly mode: "work" | "code";
  readonly projectId: string;
}) {
  const { colors } = useTheme();
  const { transport, threadId, mode, projectId } = props;
  const [read, setRead] = useState<{
    readonly threadId: string;
    readonly routines: ReadonlyArray<MobileThreadRoutine>;
  }>();
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const routines = await loadMobileThreadRoutines(transport, { threadId, mode, projectId });
        if (!disposed) setRead({ threadId, routines });
      } catch {
        // A failed read keeps the last one; the next poll tries again.
      }
      if (!disposed) timer = setTimeout(() => void load(), REFRESH_MS);
    };
    void load();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [transport, threadId, mode, projectId]);
  const routines = read?.threadId === threadId ? read.routines : [];
  if (routines.length === 0) return null;
  return (
    <View style={{ gap: mobileSpacing.sm }} testID="mobile-thread-routines">
      {routines.map((routine) => (
        <View
          accessibilityLabel={`${MOBILE_COPY.threadRoutineLabel}: ${routine.name}`}
          key={routine.id}
          style={{
            gap: mobileSpacing.xs,
            padding: mobileSpacing.md,
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: mobileSpacing.sm,
          }}
          testID={`mobile-thread-routine-${routine.id}`}
        >
          <Text style={{ color: colors.textSecondary, ...mobileTypography.caption }}>
            {routine.followUp ? MOBILE_COPY.threadRoutineFollowUp : MOBILE_COPY.threadRoutineLabel}
          </Text>
          <Text numberOfLines={1} style={{ color: colors.textPrimary, fontWeight: "600" }}>
            {routine.name}
          </Text>
          <Text style={{ color: colors.textSecondary }}>
            {routineScheduleLabel(routine.trigger)}
            {routine.paused ? ` · ${MOBILE_COPY.threadRoutinePaused}` : ""}
          </Text>
          {routine.paused ? (
            <Text style={{ color: colors.textSecondary, ...mobileTypography.caption }}>
              {MOBILE_COPY.threadRoutineResumeAtWindow}
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}
