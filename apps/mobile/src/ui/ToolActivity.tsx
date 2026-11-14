import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { space, typography, useTheme } from "../../design-system";
import { MOBILE_COPY } from "../copy";

export type ToolCallStatus = "running" | "done" | "failed";

export interface ToolCall {
  readonly name: string;
  readonly status: ToolCallStatus;
  readonly summary: string;
}

export interface ToolActivityProps {
  /** One run of consecutive tool calls in a reply, oldest first. */
  readonly calls: ReadonlyArray<ToolCall>;
  /** Whether a settled run starts open rather than behind "N tool calls". */
  readonly defaultOpen: boolean;
  /** Whether a finished call starts with its summary showing (Reply detail High). */
  readonly defaultDetailOpen: boolean;
  readonly testID?: string;
}

/**
 * Past this many rows an open run shows only its latest ones behind "+N
 * earlier": a long agent run otherwise pushed the answer several screens
 * below the calls that produced it.
 */
const VISIBLE_ROWS = 5;
const ROW_HEIGHT = 28;
const MARK_SIZE = 20;

function statusLabel(status: ToolCallStatus): string {
  switch (status) {
    case "running":
      return MOBILE_COPY.toolStatusRunning;
    case "failed":
      return MOBILE_COPY.toolStatusFailed;
    case "done":
      return MOBILE_COPY.toolStatusDone;
  }
}

function useActivityStyles() {
  const { colors } = useTheme();
  return useMemo(
    () => ({
      colors,
      styles: StyleSheet.create({
        wrap: { marginBottom: space.xs },
        row: { flexDirection: "row", alignItems: "stretch", gap: space.sm },
        railColumn: { width: MARK_SIZE, alignItems: "center" },
        railLine: {
          flex: 1,
          width: StyleSheet.hairlineWidth * 2,
          backgroundColor: colors.hairline,
        },
        railSpacer: { flex: 1 },
        mark: {
          width: MARK_SIZE,
          height: MARK_SIZE,
          borderRadius: MARK_SIZE / 2,
          alignItems: "center",
          justifyContent: "center",
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.hairline,
          backgroundColor: colors.glassFillThin,
        },
        body: { flex: 1, minWidth: 0 },
        top: { minHeight: ROW_HEIGHT, flexDirection: "row", alignItems: "center", gap: space.sm },
        name: {
          flexShrink: 1,
          color: colors.textPrimary,
          fontSize: typography.detail.fontSize,
          fontWeight: "500",
          fontFamily: typography.mono.fontFamily,
        },
        quiet: {
          flexShrink: 1,
          color: colors.textSecondary,
          fontSize: typography.detail.fontSize,
          fontWeight: "500",
        },
        state: { marginLeft: "auto", fontSize: typography.meta.fontSize, fontWeight: "500" },
        summary: {
          paddingBottom: space.xs,
          color: colors.textSecondary,
          fontSize: typography.detail.fontSize,
          lineHeight: 19,
        },
      }),
    }),
    [colors],
  );
}

type ActivityStyles = ReturnType<typeof useActivityStyles>;

/** One rung of the rail: the line above and below a round mark, then the row. */
function RailRow(props: {
  readonly look: ActivityStyles;
  readonly first: boolean;
  readonly last: boolean;
  readonly mark: React.ReactNode;
  readonly children: React.ReactNode;
}) {
  const { styles } = props.look;
  return (
    <View style={styles.row}>
      <View style={styles.railColumn}>
        <View style={{ height: (ROW_HEIGHT - MARK_SIZE) / 2 }}>
          {props.first ? null : <View style={styles.railLine} />}
        </View>
        <View style={styles.mark}>{props.mark}</View>
        {props.last ? <View style={styles.railSpacer} /> : <View style={styles.railLine} />}
      </View>
      <View style={styles.body}>{props.children}</View>
    </View>
  );
}

function CallRow(props: {
  readonly look: ActivityStyles;
  readonly call: ToolCall;
  readonly first: boolean;
  readonly last: boolean;
  readonly defaultDetailOpen: boolean;
}) {
  const { colors, styles } = props.look;
  const { call } = props;
  // A finished call folds its summary so a long run stays scannable; a
  // running or failed call keeps its detail in view.
  const collapsible = call.status === "done" && call.summary.length > 0;
  const [open, setOpen] = useState(props.defaultDetailOpen);
  const showSummary = call.summary.length > 0 && (!collapsible || open);
  const tone =
    call.status === "failed"
      ? colors.danger
      : call.status === "running"
        ? colors.attention
        : colors.textTertiary;
  const mark =
    call.status === "running" ? (
      <ActivityIndicator
        color={colors.attention}
        size="small"
        style={{ transform: [{ scale: 0.6 }] }}
      />
    ) : (
      <Ionicons
        color={call.status === "failed" ? colors.danger : colors.success}
        name={call.status === "failed" ? "close" : "checkmark"}
        size={12}
      />
    );
  return (
    <RailRow first={props.first} last={props.last} look={props.look} mark={mark}>
      <Pressable
        accessibilityLabel={`${call.name}, ${statusLabel(call.status)}`}
        accessibilityRole={collapsible ? "button" : "text"}
        accessibilityState={collapsible ? { expanded: open } : {}}
        disabled={!collapsible}
        onPress={() => setOpen((value) => !value)}
        style={styles.top}
        testID="mobile-tool-part-toggle"
      >
        <Text numberOfLines={1} style={styles.name}>
          {call.name}
        </Text>
        <Text style={[styles.state, { color: tone }]}>{statusLabel(call.status)}</Text>
        {collapsible ? (
          <Ionicons
            color={colors.textTertiary}
            name={open ? "chevron-down" : "chevron-forward"}
            size={14}
          />
        ) : null}
      </Pressable>
      {showSummary ? <Text style={styles.summary}>{call.summary}</Text> : null}
    </RailRow>
  );
}

/**
 * A run of tool calls drawn as one rail of 28px rows, each with a round
 * status mark. A settled run folds behind "N tool calls" unless the Reply
 * detail level opens it (docs/design/thread-view.md › Transcript).
 */
export function ToolActivity(props: ToolActivityProps) {
  const look = useActivityStyles();
  const { colors, styles } = look;
  const settled = props.calls.every((call) => call.status !== "running");
  const [open, setOpen] = useState(!settled || props.defaultOpen);
  const [showEarlier, setShowEarlier] = useState(false);
  const failed = props.calls.filter((call) => call.status === "failed").length;

  if (!open) {
    const label =
      props.calls.length === 1
        ? MOBILE_COPY.toolCallsOne
        : MOBILE_COPY.toolCalls(props.calls.length);
    return (
      <View style={styles.wrap} testID={props.testID ?? "mobile-tool-activity"}>
        <RailRow
          first
          last
          look={look}
          mark={<Ionicons color={colors.textSecondary} name="construct-outline" size={11} />}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: false }}
            onPress={() => setOpen(true)}
            style={styles.top}
            testID="mobile-tool-activity-toggle"
          >
            <Text numberOfLines={1} style={styles.quiet}>
              {label}
            </Text>
            {failed > 0 ? (
              <Text style={[styles.state, { color: colors.danger }]}>
                {MOBILE_COPY.toolCallsFailed(failed)}
              </Text>
            ) : null}
            <Ionicons
              color={colors.textTertiary}
              name="chevron-forward"
              size={14}
              style={failed > 0 ? undefined : { marginLeft: "auto" }}
            />
          </Pressable>
        </RailRow>
      </View>
    );
  }

  const hidden = showEarlier ? 0 : Math.max(0, props.calls.length - VISIBLE_ROWS);
  const visible = props.calls.slice(hidden);
  return (
    <View style={styles.wrap} testID={props.testID ?? "mobile-tool-activity"}>
      {hidden > 0 ? (
        <RailRow
          first
          last={false}
          look={look}
          mark={<Ionicons color={colors.textSecondary} name="ellipsis-horizontal" size={11} />}
        >
          <Pressable
            accessibilityRole="button"
            onPress={() => setShowEarlier(true)}
            style={styles.top}
            testID="mobile-tool-activity-earlier"
          >
            <Text style={styles.quiet}>{MOBILE_COPY.toolCallsEarlier(hidden)}</Text>
          </Pressable>
        </RailRow>
      ) : null}
      {visible.map((call, index) => (
        <CallRow
          call={call}
          defaultDetailOpen={props.defaultDetailOpen}
          first={hidden === 0 && index === 0}
          // Calls are append-only within a reply, so their position is stable.
          key={hidden + index}
          last={index === visible.length - 1}
          look={look}
        />
      ))}
    </View>
  );
}
