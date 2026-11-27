import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ReplyDetailLevel } from "@octant/contracts";
import { MOBILE_COPY } from "../../copy";
import { radii, space, typography, useTheme } from "../../../design-system";
import { formatScreenshotSafeLabel } from "../../security/screenshotSafeLabel";
import { Icon } from "../../ui/Icon";
import { mobileReplyDetailPresentation } from "../../ui/replyDetailPresentation";
import type { MobileIconName } from "../../ui/symbols";
import { ToolActivity } from "../../ui/ToolActivity";
import type { PlanTask, TurnActivity } from "./turnActivity";

const TASK_ICON: Readonly<Record<PlanTask["state"], MobileIconName>> = {
  pending: "ellipse-outline",
  running: "play-circle",
  waiting: "pause-circle-outline",
  completed: "checkmark-circle",
  failed: "close-circle",
};

/** Files named before the rest fold behind their count. */
const FILES_SHOWN = 4;

/** What a turn did above its reply: its thinking, calls and plan. */
export function TurnActivityView(props: {
  readonly activity: TurnActivity;
  readonly live: boolean;
  readonly replyDetail: ReplyDetailLevel;
  readonly testID: string;
}) {
  const { activity } = props;
  const { colors } = useTheme();
  const presentation = mobileReplyDetailPresentation(props.replyDetail, "");
  const styles = useMemo(
    () =>
      StyleSheet.create({
        stack: { gap: space.xs },
        line: { minHeight: 28, flexDirection: "row", alignItems: "center", gap: space.sm },
        quiet: { color: colors.textSecondary, fontSize: typography.detail.fontSize },
        plan: {
          gap: 2,
          paddingVertical: space.sm,
          paddingHorizontal: 12,
          borderRadius: radii.md,
          backgroundColor: colors.control,
        },
        planTitle: {
          color: colors.textSecondary,
          fontSize: typography.caption.fontSize,
          fontWeight: "600",
          paddingBottom: 2,
        },
        task: { flexDirection: "row", alignItems: "flex-start", gap: space.sm, paddingVertical: 3 },
        taskText: {
          flex: 1,
          color: colors.textPrimary,
          fontSize: typography.detail.fontSize,
          lineHeight: 20,
        },
        taskDone: { color: colors.textTertiary },
      }),
    [colors],
  );
  const taskInk = (state: PlanTask["state"]): string =>
    state === "completed"
      ? colors.success
      : state === "failed"
        ? colors.danger
        : state === "running"
          ? colors.accent
          : colors.textTertiary;
  const done = activity.plan.filter((task) => task.state === "completed").length;
  const thinking =
    activity.reasoningMs === undefined
      ? props.live && activity.calls.length === 0
        ? MOBILE_COPY.thinking
        : undefined
      : MOBILE_COPY.thoughtFor(Math.max(1, Math.round(activity.reasoningMs / 1_000)));
  if (thinking === undefined && activity.calls.length === 0 && activity.plan.length === 0)
    return null;
  return (
    <View style={styles.stack} testID={props.testID}>
      {thinking === undefined ? null : (
        <View style={styles.line}>
          <Icon color={colors.textTertiary} name="bulb-outline" size={16} />
          <Text style={styles.quiet}>{thinking}</Text>
        </View>
      )}
      {activity.calls.length === 0 ? null : (
        <ToolActivity
          calls={activity.calls}
          defaultDetailOpen={presentation.toolDetailOpen}
          defaultOpen={presentation.toolCallsOpen}
          testID={`${props.testID}-calls`}
        />
      )}
      {activity.callsTruncated ? (
        <Text style={styles.quiet}>{MOBILE_COPY.toolCallsTruncated}</Text>
      ) : null}
      {activity.plan.length === 0 ? null : (
        <View style={styles.plan} testID={`${props.testID}-plan`}>
          <Text style={styles.planTitle}>
            {MOBILE_COPY.planProgress(done, activity.plan.length)}
          </Text>
          {activity.plan.map((task) => (
            <View
              accessibilityLabel={`${MOBILE_COPY.planTaskState[task.state]}, ${formatScreenshotSafeLabel(task.text)}`}
              accessible
              key={task.id}
              style={styles.task}
            >
              <View style={{ paddingTop: 2 }}>
                <Icon color={taskInk(task.state)} name={TASK_ICON[task.state]} size={15} />
              </View>
              <Text style={[styles.taskText, task.state === "completed" ? styles.taskDone : null]}>
                {formatScreenshotSafeLabel(task.text)}
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

/** The files that changed while a turn ran, under its reply. */
export function TurnFilesView(props: {
  readonly files: NonNullable<TurnActivity["files"]>;
  /** Opens the changes; absent where the phone has no view of them. */
  readonly onReview?: (() => void) | undefined;
  readonly testID: string;
}) {
  const { files, total, truncated } = props.files;
  const { colors } = useTheme();
  const [all, setAll] = useState(false);
  const styles = useMemo(
    () =>
      StyleSheet.create({
        card: { borderRadius: radii.md, backgroundColor: colors.control, paddingVertical: 4 },
        row: {
          minHeight: 34,
          flexDirection: "row",
          alignItems: "center",
          gap: space.sm,
          paddingHorizontal: 12,
        },
        title: {
          flex: 1,
          color: colors.textPrimary,
          fontSize: typography.detail.fontSize,
          fontWeight: "500",
        },
        path: {
          flex: 1,
          color: colors.textSecondary,
          fontFamily: typography.mono.fontFamily,
          fontSize: typography.caption.fontSize,
        },
        count: { fontSize: typography.caption.fontSize, fontVariant: ["tabular-nums"] },
        action: { color: colors.accent, fontSize: typography.detail.fontSize },
      }),
    [colors],
  );
  const shown = all ? files : files.slice(0, FILES_SHOWN);
  const counted = files.filter((file) => file.insertions !== undefined);
  const added = counted.reduce((sum, file) => sum + (file.insertions ?? 0), 0);
  const removed = counted.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  const lines = (insertions: number, deletions: number) => (
    <>
      <Text style={[styles.count, { color: colors.success }]}>{`+${insertions}`}</Text>
      <Text style={[styles.count, { color: colors.danger }]}>{`−${deletions}`}</Text>
    </>
  );
  return (
    <View style={styles.card} testID={props.testID}>
      <Pressable
        accessibilityRole={props.onReview === undefined ? "text" : "button"}
        disabled={props.onReview === undefined}
        onPress={props.onReview}
        style={styles.row}
      >
        <Icon color={colors.textSecondary} name="document-text-outline" size={15} />
        <Text style={styles.title}>{MOBILE_COPY.filesChanged(total, truncated)}</Text>
        {/* A count of the files listed would pass for the whole turn's. */}
        {counted.length === total && total > 0 ? lines(added, removed) : null}
        {props.onReview === undefined ? null : (
          <Icon color={colors.textTertiary} name="chevron-forward" size={14} />
        )}
      </Pressable>
      {shown.map((file) => (
        <View key={file.path} style={styles.row}>
          <Text ellipsizeMode="head" numberOfLines={1} style={styles.path}>
            {formatScreenshotSafeLabel(file.path)}
          </Text>
          {file.insertions === undefined ? null : lines(file.insertions, file.deletions ?? 0)}
        </View>
      ))}
      {all || files.length <= FILES_SHOWN ? null : (
        <Pressable accessibilityRole="button" onPress={() => setAll(true)} style={styles.row}>
          <Text style={styles.action}>{MOBILE_COPY.filesMore(files.length - FILES_SHOWN)}</Text>
        </Pressable>
      )}
    </View>
  );
}
