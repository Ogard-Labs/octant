import { useCallback, useMemo } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import type { MobileInboxRow } from "@octant/client-runtime";
import { MOBILE_COPY, mobileHostHealthLabel, MOBILE_SCREEN_TITLES } from "../copy";
import { radii, space, typography, useTheme } from "../../design-system";
import { hostHealthTone } from "../hosts/hostHealthTone";
import type { CountedThreads } from "../navigation/routes";
import { ScreenHeader } from "../navigation/ScreenHeader";
import { useMobileSession } from "../session/MobileSessionContext";
import { CountTile } from "../ui/CountTile";
import { ListRow, ListSection } from "../ui/NativeChrome";
import { inboxEmptyState } from "./inboxEmptyState";
import { inboxPriorityRows, inboxStatusCounts } from "./inboxWorkPresentation";
import { useMobileThreads } from "./MobileThreadsContext";
import { useNewThread } from "./NewThreadContext";
import { ThreadReadFailures } from "./ThreadReadFailures";
import { ThreadRow } from "./ThreadRow";

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
  const { transports, hosts, hostsLoaded, health } = useMobileSession();
  const { rows, loading, refresh } = useMobileThreads();
  const { accessReason } = useNewThread();
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
        content: { paddingBottom: space.xl, flexGrow: 1 },
        subhero: {
          color: colors.textSecondary,
          fontSize: typography.detail.fontSize,
          lineHeight: 18,
          paddingHorizontal: space.md,
          marginBottom: space.md,
        },
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
        {accessReason === undefined ? null : (
          <Text accessibilityLiveRegion="polite" style={styles.subhero}>
            {accessReason}
          </Text>
        )}
        <ThreadReadFailures />
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

            {transports.length === 0 ? null : (
              <ListSection testID="mobile-home-todos">
                <ListRow
                  accessory="chevron"
                  icon="checkmark-circle-outline"
                  label={MOBILE_SCREEN_TITLES.todos}
                  last
                  onPress={props.onOpenTodos}
                  testID="mobile-home-open-todos"
                />
              </ListSection>
            )}

            {priorityRows.length > 0 ? (
              <ListSection
                action={{
                  label: MOBILE_COPY.homeSeeAll,
                  onPress: props.onOpenThreads,
                  testID: "mobile-home-see-all",
                }}
                testID="mobile-home-recent"
                title={MOBILE_COPY.homeRecent}
              >
                {priorityRows.map((row, index) => (
                  <ThreadRow
                    key={`${row.hostId}:${row.mode}:${row.threadId}`}
                    last={index === priorityRows.length - 1}
                    onOpen={props.onOpenThread}
                    row={row}
                  />
                ))}
              </ListSection>
            ) : null}

            {loading ? <ActivityIndicator color={colors.accent} style={styles.loader} /> : null}
            <ListSection title={MOBILE_COPY.workspaces}>
              {hosts.map((host) => {
                const hostWorkCount = rows.filter(
                  (row) => row.hostId === host.hostId && row.mode !== "chat",
                ).length;
                const hostHealth = health.find((entry) => entry.hostId === host.hostId);
                const tone = hostHealthTone(hostHealth?.kind ?? "idle");
                return (
                  <ListRow
                    detail={`${mobileHostHealthLabel(hostHealth?.kind ?? "idle")}${
                      hostHealth?.detail !== undefined ? ` · ${hostHealth.detail}` : ""
                    }`}
                    detailTone={
                      tone === "neutral" ? undefined : hostToneColor(hostHealth?.kind ?? "idle")
                    }
                    icon="desktop"
                    iconTone={
                      tone === "neutral"
                        ? colors.paletteBlue
                        : hostToneColor(hostHealth?.kind ?? "idle")
                    }
                    key={host.hostId}
                    label={host.label}
                    onPress={() => props.onOpenWorkspace(host.hostId)}
                    testID={`mobile-workspace-${host.hostId}`}
                    value={hostWorkCount > 0 ? String(hostWorkCount) : undefined}
                  />
                );
              })}
              <ListRow
                accessory="none"
                icon="add"
                iconTone={colors.textTertiary}
                label={MOBILE_COPY.addWorkspace}
                labelTone={colors.accent}
                last
                onPress={props.onAddWorkspace}
                testID="mobile-workspace-add"
              />
            </ListSection>
          </View>
        )}
      </ScrollView>
    </View>
  );
}
