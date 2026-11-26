import type {
  MobileLiveTask,
  MobileProviderDirectoryEntry,
  MobileSubagent,
} from "@octant/client-runtime";
import { useEffect, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { space, typography, useTheme } from "../../design-system";
import { MOBILE_COPY } from "../copy";
import { BottomSheet } from "../ui/BottomSheet";
import { ComposerSurface } from "../ui/ComposerSurface";
import { Icon } from "../ui/Icon";
import {
  orderedSubagents,
  subagentRouteLabel,
  subagentRunTime,
  subagentStatus,
  subagentTitle,
  subagentsPillLabel,
  type SubagentTone,
} from "./subagentsPresentation";

function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

function useToneColour(): (tone: SubagentTone) => string {
  const { colors } = useTheme();
  return (tone) =>
    tone === "working"
      ? colors.accent
      : tone === "done"
        ? colors.success
        : tone === "failed"
          ? colors.danger
          : colors.textTertiary;
}

/** "11 done", over the composer; it opens the thread's subagents. */
export function SubagentsPill(props: {
  readonly subagents: ReadonlyArray<MobileSubagent>;
  readonly liveTasks: ReadonlyArray<MobileLiveTask>;
  readonly onPress: () => void;
}) {
  const { colors } = useTheme();
  const tasks =
    props.liveTasks.length === 0
      ? undefined
      : MOBILE_COPY.subagentsLiveTasks(props.liveTasks.length);
  const label = [subagentsPillLabel(props.subagents), tasks]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
  if (label.length === 0) return null;
  return (
    <View style={styles.pillPlace}>
      <Pressable
        accessibilityHint={MOBILE_COPY.subagentsPillHint}
        accessibilityLabel={`${MOBILE_COPY.subagentsTitle}: ${label}`}
        accessibilityRole="button"
        hitSlop={8}
        onPress={props.onPress}
        testID="mobile-subagents-pill"
      >
        <ComposerSurface contentStyle={styles.pillContent} radius={18}>
          <Icon color={colors.textSecondary} name="people-outline" size={15} />
          <Text
            maxFontSizeMultiplier={1.6}
            style={[styles.pillText, { color: colors.textPrimary }]}
          >
            {label}
          </Text>
        </ComposerSurface>
      </Pressable>
    </View>
  );
}

/**
 * Every subagent of the thread, one row each: what it was asked, how it
 * stands, how long it ran, where it runs and its latest line. A row opens the
 * subagent, with Stop while the computer offers it.
 */
export function SubagentsSheet(props: {
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly subagents: ReadonlyArray<MobileSubagent>;
  readonly liveTasks: ReadonlyArray<MobileLiveTask>;
  readonly providerDirectory: ReadonlyArray<MobileProviderDirectoryEntry>;
  /** Absent where this device may not stop anything. */
  readonly onStop?: ((subagent: MobileSubagent) => Promise<string | undefined>) | undefined;
  readonly onStopLiveTasks?: (() => Promise<string | undefined>) | undefined;
}) {
  const { colors } = useTheme();
  const toneColour = useToneColour();
  const [openId, setOpenId] = useState<string>();
  const [stopping, setStopping] = useState(false);
  const [notice, setNotice] = useState<string>();
  const ordered = useMemo(() => orderedSubagents(props.subagents), [props.subagents]);
  const open = ordered.find((subagent) => subagent.id === openId);
  const now = useNow(
    props.visible && ordered.some((s) => subagentStatus(s.status).tone === "working"),
  );

  useEffect(() => {
    if (!props.visible) {
      setOpenId(undefined);
      setNotice(undefined);
    }
  }, [props.visible]);

  const confirm = (title: string, action: () => Promise<string | undefined>) =>
    Alert.alert(title, MOBILE_COPY.subagentStopBody, [
      { text: MOBILE_COPY.subagentCancel, style: "cancel" },
      {
        text: MOBILE_COPY.subagentStop,
        style: "destructive",
        onPress: () => {
          setStopping(true);
          setNotice(undefined);
          void action().then((refusal) => {
            setStopping(false);
            setNotice(refusal);
          });
        },
      },
    ]);

  const row = (subagent: MobileSubagent) => {
    const status = subagentStatus(subagent.status);
    const route = subagentRouteLabel(subagent, props.providerDirectory);
    const time = subagentRunTime(subagent, now);
    return (
      <Pressable
        accessibilityRole="button"
        key={subagent.id}
        onPress={() => {
          setNotice(undefined);
          setOpenId(subagent.id);
        }}
        style={({ pressed }) => [
          styles.row,
          { borderBottomColor: colors.hairline },
          pressed ? { backgroundColor: colors.controlPressed } : null,
        ]}
        testID={`mobile-subagent-${subagent.id}`}
      >
        <View style={[styles.dot, { backgroundColor: toneColour(status.tone) }]} />
        <View style={styles.rowBody}>
          <View style={styles.rowHead}>
            <Text numberOfLines={1} style={[styles.rowTitle, { color: colors.textPrimary }]}>
              {subagentTitle(subagent)}
            </Text>
            {time.length === 0 ? null : (
              <Text style={[styles.time, { color: colors.textSecondary }]}>{time}</Text>
            )}
            <Icon color={colors.textTertiary} name="chevron-forward" size={14} />
          </View>
          {/* The status leads its own line, so a long task never cuts it off. */}
          <Text numberOfLines={1} style={[styles.meta, { color: colors.textSecondary }]}>
            <Text style={{ color: toneColour(status.tone) }}>{status.label}</Text>
            {route.length === 0 ? "" : ` · ${route}`}
          </Text>
          {subagent.latest === undefined ? null : (
            <Text numberOfLines={2} style={[styles.latest, { color: colors.textSecondary }]}>
              {subagent.latest}
            </Text>
          )}
        </View>
      </Pressable>
    );
  };

  const detail = (subagent: MobileSubagent) => {
    const status = subagentStatus(subagent.status);
    const route = subagentRouteLabel(subagent, props.providerDirectory);
    const time = subagentRunTime(subagent, now);
    const onStop = props.onStop;
    return (
      <View testID="mobile-subagent-detail">
        <Pressable
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => {
            setNotice(undefined);
            setOpenId(undefined);
          }}
          style={styles.back}
          testID="mobile-subagent-back"
        >
          <Icon color={colors.accent} name="chevron-back" size={16} />
          <Text style={[typography.body, { color: colors.accent }]}>
            {MOBILE_COPY.subagentsTitle}
          </Text>
        </Pressable>
        <Text selectable style={[typography.title, { color: colors.textPrimary }]}>
          {subagent.task.trim().length === 0 ? subagentTitle(subagent) : subagent.task.trim()}
        </Text>
        <Text style={[styles.meta, { color: colors.textSecondary, marginTop: space.xs }]}>
          <Text style={{ color: toneColour(status.tone) }}>{status.label}</Text>
          {[time, route].filter((part) => part.length > 0).map((part) => ` · ${part}`)}
        </Text>
        {subagent.result === undefined && subagent.latest === undefined ? null : (
          <>
            <Text style={[styles.section, { color: colors.textSecondary }]}>
              {subagent.result === undefined
                ? MOBILE_COPY.subagentLatest
                : MOBILE_COPY.subagentReply}
            </Text>
            <Text selectable style={[typography.body, { color: colors.textPrimary }]}>
              {(subagent.result ?? subagent.latest ?? "").trim()}
            </Text>
          </>
        )}
        {subagent.stoppable && onStop !== undefined ? (
          <Pressable
            accessibilityRole="button"
            disabled={stopping}
            onPress={() => confirm(MOBILE_COPY.subagentStopTitle, () => onStop(subagent))}
            style={[styles.stop, { borderColor: colors.danger, opacity: stopping ? 0.5 : 1 }]}
            testID="mobile-subagent-stop"
          >
            <Icon color={colors.danger} name="stop" size={14} />
            <Text style={[typography.body, { color: colors.danger, fontWeight: "600" }]}>
              {MOBILE_COPY.subagentStop}
            </Text>
          </Pressable>
        ) : null}
      </View>
    );
  };

  const onStopLiveTasks = props.onStopLiveTasks;
  return (
    <BottomSheet
      onClose={props.onClose}
      testID="mobile-subagents-sheet"
      title={MOBILE_COPY.subagentsTitle}
      visible={props.visible}
    >
      <ScrollView contentContainerStyle={styles.content}>
        {notice === undefined ? null : (
          <Text style={[styles.notice, { color: colors.danger }]} testID="mobile-subagent-notice">
            {notice}
          </Text>
        )}
        {open !== undefined ? (
          detail(open)
        ) : (
          <>
            {ordered.length === 0 && props.liveTasks.length === 0 ? (
              <Text style={[typography.body, { color: colors.textSecondary }]}>
                {MOBILE_COPY.subagentsEmpty}
              </Text>
            ) : null}
            {ordered.map(row)}
            {props.liveTasks.length === 0 ? null : (
              <View testID="mobile-live-tasks">
                <Text style={[styles.section, { color: colors.textSecondary }]}>
                  {MOBILE_COPY.subagentsBackgroundTasks}
                </Text>
                {props.liveTasks.map((task) => (
                  <View
                    key={task.taskId}
                    style={[styles.row, { borderBottomColor: colors.hairline }]}
                  >
                    <View style={[styles.dot, { backgroundColor: colors.accent }]} />
                    <Text
                      numberOfLines={2}
                      style={[styles.rowTitle, { color: colors.textPrimary }]}
                    >
                      {task.description ?? task.taskId}
                    </Text>
                  </View>
                ))}
                {onStopLiveTasks === undefined ? null : (
                  <Pressable
                    accessibilityRole="button"
                    disabled={stopping}
                    onPress={() => confirm(MOBILE_COPY.liveTasksStopTitle, onStopLiveTasks)}
                    style={[
                      styles.stop,
                      { borderColor: colors.danger, opacity: stopping ? 0.5 : 1 },
                    ]}
                    testID="mobile-live-tasks-stop"
                  >
                    <Icon color={colors.danger} name="stop" size={14} />
                    <Text style={[typography.body, { color: colors.danger, fontWeight: "600" }]}>
                      {MOBILE_COPY.liveTasksStop}
                    </Text>
                  </Pressable>
                )}
              </View>
            )}
          </>
        )}
      </ScrollView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  pillPlace: { alignItems: "center", paddingBottom: space.sm },
  pillContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  pillText: { fontSize: typography.caption.fontSize, fontWeight: "500" },
  content: { paddingHorizontal: space.md, paddingBottom: space.xl },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.sm,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 7 },
  rowBody: { flex: 1, gap: 2 },
  rowHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  rowTitle: { ...typography.body, flex: 1, fontWeight: "500" },
  time: { ...typography.detail, fontVariant: ["tabular-nums"] },
  meta: { ...typography.detail },
  latest: { ...typography.detail },
  section: {
    ...typography.caption,
    fontWeight: "600",
    marginTop: space.md,
    marginBottom: space.xs,
    textTransform: "uppercase",
  },
  back: { flexDirection: "row", alignItems: "center", gap: 2, marginBottom: space.sm },
  stop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    marginTop: space.lg,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  notice: { ...typography.detail, marginBottom: space.sm },
});
