import { useCallback, useMemo } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Icon } from "../ui/Icon";
import { useFocusEffect } from "@react-navigation/native";
import type { MobileInboxRow } from "@octant/client-runtime";
import { MOBILE_COPY, mobileHostHealthLabel, MOBILE_SCREEN_TITLES } from "../copy";
import { radii, space, typography, useTheme } from "../../design-system";
import { hostHealthTone } from "../hosts/hostHealthTone";
import type { CountedThreads } from "../navigation/routes";
import { NEW_BUTTON_CLEARANCE } from "../navigation/places";
import { ScreenHeader } from "../navigation/ScreenHeader";
import { useMobileSession } from "../session/MobileSessionContext";
import { CountTile } from "../ui/CountTile";
import { inboxEmptyState } from "./inboxEmptyState";
import { inboxPriorityRows, inboxStatusCounts } from "./inboxWorkPresentation";
import { useMobileThreads } from "./MobileThreadsContext";
import { ThreadListNotices } from "./ThreadListNotices";
import { ThreadGroup } from "./ThreadGroup";

export interface HomeScreenProps {
  readonly onOpenCounted: (view: CountedThreads) => void;
  readonly onOpenThreads: () => void;
  readonly onOpenTodos: () => void;
  readonly onOpenSettings: () => void;
  readonly onOpenWorkspace: (hostId: string) => void;
  readonly onAddWorkspace: () => void;
  /** Opens the pairing screen with the QR scanner already open. */
  readonly onScanToPair: () => void;
  readonly onOpenThread: (row: MobileInboxRow) => void;
}

/** Enough to show what needs the person without pushing Computers off the first screen. */
const HOME_RECENT_LIMIT = 5;

export function HomeScreen(props: HomeScreenProps) {
  const { colors } = useTheme();
  const { hosts, hostsLoaded, health } = useMobileSession();
  const { rows, loading, refresh } = useMobileThreads();
  const emptyState = inboxEmptyState({ hosts, hostsLoaded });
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );
  const counts = useMemo(() => inboxStatusCounts(rows), [rows]);
  const priorityRows = useMemo(() => inboxPriorityRows(rows, HOME_RECENT_LIMIT), [rows]);
  const hostToneColor = (kind: Parameters<typeof hostHealthTone>[0]): string => {
    const tone = hostHealthTone(kind);
    return tone === "danger"
      ? colors.danger
      : tone === "warning"
        ? colors.warning
        : colors.textSecondary;
  };

  const styles = useMemo(
    () =>
      StyleSheet.create({
        content: { paddingBottom: NEW_BUTTON_CLEARANCE, flexGrow: 1 },
        tiles: {
          flexDirection: "row",
          gap: 10,
          paddingHorizontal: space.md,
          marginTop: space.xs,
          marginBottom: space.lg,
        },
        firstRun: {
          gap: space.md,
          padding: space.lg,
          marginHorizontal: space.md,
          borderRadius: radii.md,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.hairline,
          backgroundColor: colors.surfaceElevatedSolid,
        },
        firstRunTitle: {
          color: colors.textPrimary,
          fontSize: typography.title.fontSize,
          fontWeight: typography.title.fontWeight,
          letterSpacing: typography.title.letterSpacing,
        },
        firstRunBody: {
          color: colors.textSecondary,
          fontSize: typography.body.fontSize,
          lineHeight: 21,
        },
        firstRunButton: {
          backgroundColor: colors.accent,
          height: 50,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: radii.md,
        },
        firstRunButtonLabel: {
          color: colors.sendLabel,
          fontWeight: "600",
          fontSize: 17,
        },
        loader: { marginVertical: space.md },
        heading: { minHeight: 44, justifyContent: "flex-end", paddingHorizontal: space.md },
        headingLabel: {
          color: colors.textSecondary,
          fontSize: typography.detail.fontSize,
          fontWeight: "600",
          paddingBottom: space.sm,
        },
        computer: {
          minHeight: 60,
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          paddingHorizontal: space.md,
        },
        pressed: { backgroundColor: colors.controlHover },
        computerIcon: {
          width: 36,
          height: 36,
          borderRadius: 10,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.control,
        },
        computerBody: { flex: 1, gap: 2 },
        computerName: { color: colors.textPrimary, fontSize: 16, fontWeight: "500" },
        computerState: { flexDirection: "row", alignItems: "center", gap: 6 },
        computerDetail: { flex: 1, color: colors.textTertiary, fontSize: 13 },
        dot: { width: 7, height: 7, borderRadius: 4 },
        add: { color: colors.accent, fontSize: 16, fontWeight: "500" },
        seeAll: { minHeight: 44, justifyContent: "center", paddingHorizontal: space.md },
        seeAllLabel: { color: colors.accent, fontSize: typography.detail.fontSize },
      }),
    [colors],
  );

  return (
    <View style={{ flex: 1 }} testID="mobile-inbox-home">
      <ScreenHeader
        actions={[
          {
            label: "Search threads",
            icon: "search",
            onPress: props.onOpenThreads,
            testID: "mobile-home-search",
          },
          {
            label: MOBILE_SCREEN_TITLES.todos,
            icon: "checkmark-circle-outline",
            onPress: props.onOpenTodos,
            testID: "mobile-home-open-todos",
          },
          {
            label: "Settings",
            icon: "settings-outline",
            onPress: props.onOpenSettings,
            testID: "mobile-home-settings",
          },
        ]}
        title={MOBILE_SCREEN_TITLES.home}
      />
      <ScrollView
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
      >
        <ThreadListNotices />
        {emptyState !== undefined ? (
          <View style={styles.firstRun} testID="mobile-home-first-run">
            <Text style={styles.firstRunTitle}>{emptyState.title}</Text>
            <Text style={styles.firstRunBody}>{emptyState.body}</Text>
            <Pressable
              accessibilityRole="button"
              onPress={props.onScanToPair}
              style={styles.firstRunButton}
              testID="mobile-home-scan-to-pair"
            >
              <Text style={styles.firstRunButtonLabel}>{emptyState.actionLabel}</Text>
            </Pressable>
          </View>
        ) : (
          <View>
            <View style={styles.tiles} testID="mobile-home-count-tiles">
              <CountTile
                count={counts.needsAttention}
                hue={colors.paletteBlue}
                icon="file-tray"
                label={MOBILE_COPY.needsAttention}
                onPress={() => props.onOpenCounted("attention")}
                testID="mobile-tile-attention"
              />
              <CountTile
                count={counts.working}
                hue={colors.paletteOrange}
                icon="play-circle"
                label={MOBILE_COPY.working}
                onPress={() => props.onOpenCounted("working")}
                testID="mobile-tile-working"
              />
              <CountTile
                count={counts.inReview}
                hue={colors.palettePurple}
                icon="eye"
                label={MOBILE_COPY.inReview}
                onPress={() => props.onOpenCounted("review")}
                testID="mobile-tile-review"
              />
            </View>

            {priorityRows.length > 0 ? (
              <View testID="mobile-home-recent">
                <ThreadGroup
                  label={MOBILE_COPY.homeRecent}
                  onOpen={props.onOpenThread}
                  rows={priorityRows}
                />
                <Pressable
                  accessibilityRole="button"
                  hitSlop={8}
                  onPress={props.onOpenThreads}
                  style={styles.seeAll}
                  testID="mobile-home-see-all"
                >
                  <Text style={styles.seeAllLabel}>{MOBILE_COPY.homeSeeAll}</Text>
                </Pressable>
              </View>
            ) : null}

            {loading ? <ActivityIndicator color={colors.accent} style={styles.loader} /> : null}
            <View accessibilityRole="header" accessible style={styles.heading}>
              <Text style={styles.headingLabel}>{MOBILE_COPY.workspaces}</Text>
            </View>
            {hosts.map((host) => {
              const kind = health.find((entry) => entry.hostId === host.hostId);
              const ready = kind?.kind === "ready";
              const detail = `${mobileHostHealthLabel(kind?.kind ?? "idle")}${
                kind?.detail !== undefined ? ` · ${kind.detail}` : ""
              }`;
              return (
                <Pressable
                  accessibilityLabel={`${host.label}, ${detail}`}
                  accessibilityRole="button"
                  key={host.hostId}
                  onPress={() => props.onOpenWorkspace(host.hostId)}
                  style={({ pressed }) => [styles.computer, pressed ? styles.pressed : null]}
                  testID={`mobile-workspace-${host.hostId}`}
                >
                  <View style={styles.computerIcon}>
                    <Icon color={colors.textSecondary} name="desktop-outline" size={18} />
                  </View>
                  <View style={styles.computerBody}>
                    <Text numberOfLines={1} style={styles.computerName}>
                      {host.label}
                    </Text>
                    <View style={styles.computerState}>
                      <View
                        style={[
                          styles.dot,
                          {
                            backgroundColor: ready
                              ? colors.success
                              : hostToneColor(kind?.kind ?? "idle"),
                          },
                        ]}
                      />
                      <Text numberOfLines={1} style={styles.computerDetail}>
                        {detail}
                      </Text>
                    </View>
                  </View>
                </Pressable>
              );
            })}
            <Pressable
              accessibilityRole="button"
              onPress={props.onAddWorkspace}
              style={({ pressed }) => [styles.computer, pressed ? styles.pressed : null]}
              testID="mobile-workspace-add"
            >
              <View style={styles.computerIcon}>
                <Icon color={colors.accent} name="add" size={20} />
              </View>
              <Text style={styles.add}>{MOBILE_COPY.addWorkspace}</Text>
            </Pressable>
          </View>
        )}
      </ScrollView>
    </View>
  );
}
