import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import {
  searchMobileTranscripts,
  type MobileInboxRow,
  type MobileTranscriptHit,
} from "@octant/client-runtime";
import { MOBILE_COPY, MOBILE_SCREEN_TITLES } from "../copy";
import { radii, space, typography, useTheme } from "../../design-system";
import { NEW_BUTTON_CLEARANCE } from "../navigation/places";
import { ScreenHeader } from "../navigation/ScreenHeader";
import { formatScreenshotSafeLabel } from "../security/screenshotSafeLabel";
import { useMobileSession } from "../session/MobileSessionContext";
import { ListRow, ListSection, SegmentedControl } from "../ui/NativeChrome";
import { searchHitsBesideList } from "./agentsListPresentation";
import { useMobileThreads } from "./MobileThreadsContext";
import { ThreadListNotices } from "./ThreadListNotices";
import { ThreadRow } from "./ThreadRow";
import { filterThreads, type MobileThreadFilter } from "./threadFilters";
import {
  arrangeMobileThreads,
  MOBILE_THREAD_ARRANGEMENTS,
  type MobileThreadArrangement,
} from "./threadArrangement";
import { threadModeIcon } from "./threadRowPresentation";

const MODE_OPTIONS: ReadonlyArray<{
  readonly id: MobileThreadFilter["mode"];
  readonly label: string;
}> = [
  { id: "all", label: MOBILE_COPY.allModes },
  { id: "chat", label: "Chat" },
  { id: "work", label: "Work" },
  { id: "code", label: "Code" },
];

/** Chat, Work and Code threads from every paired computer, in one list. */
export function ThreadsScreen(props: {
  readonly arrangement: MobileThreadArrangement;
  readonly onSelectArrangement: (arrangement: MobileThreadArrangement) => void;
  readonly mode: MobileThreadFilter["mode"];
  readonly onSelectMode: (mode: MobileThreadFilter["mode"]) => void;
  /** Opens a thread; a message search hit also names the turn to scroll to. */
  readonly onOpenThread: (row: MobileInboxRow, focusTurnId?: string) => void;
}) {
  const { colors } = useTheme();
  const { transports, hosts, inboxHostFilter, setInboxHostFilter } = useMobileSession();
  const { rows, loading, refresh, projects, projectName } = useMobileThreads();
  const [project, setProject] = useState<MobileThreadFilter["project"]>("all");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [messageHits, setMessageHits] = useState<ReadonlyArray<MobileTranscriptHit>>([]);
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );
  // Titles filter in place; message text is the host's search, asked once the
  // person pauses typing, across every paired computer and every mode.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setMessageHits([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void Promise.all(
        transports.map((transport) =>
          searchMobileTranscripts(transport, trimmed, controller.signal),
        ),
      ).then((results) => {
        if (controller.signal.aborted) return;
        setMessageHits(results.flatMap((result) => (result.status === "ready" ? result.hits : [])));
      });
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, transports]);

  // Home can also narrow Threads to one computer.
  const heldProject =
    project !== "all" && inboxHostFilter !== "all" && project.hostId !== inboxHostFilter
      ? "all"
      : project;
  const shown = useMemo(() => {
    const wanted = query.trim().toLowerCase();
    return filterThreads(rows, {
      mode: props.mode,
      hostId: inboxHostFilter,
      project: heldProject,
    }).filter((row) => wanted.length === 0 || row.title.toLowerCase().includes(wanted));
  }, [heldProject, inboxHostFilter, props.mode, query, rows]);
  const groups = useMemo(
    () => arrangeMobileThreads({ rows: shown, arrangement: props.arrangement, projectName }),
    [projectName, props.arrangement, shown],
  );
  const threadHits = useMemo(() => searchHitsBesideList(messageHits, shown), [messageHits, shown]);
  const offeredProjects = projects.filter(
    (entry) => inboxHostFilter === "all" || entry.hostId === inboxHostFilter,
  );
  const filtered = inboxHostFilter !== "all" || heldProject !== "all";

  const styles = useMemo(
    () =>
      StyleSheet.create({
        content: { paddingBottom: NEW_BUTTON_CLEARANCE, flexGrow: 1 },
        control: { paddingHorizontal: space.md, paddingBottom: space.sm },
        chips: { gap: space.sm, paddingHorizontal: space.md },
        chipRow: { flexGrow: 0, marginBottom: space.sm },
        chip: {
          height: 32,
          justifyContent: "center",
          paddingHorizontal: 12,
          borderRadius: radii.pill,
          backgroundColor: colors.control,
        },
        chipActive: { backgroundColor: colors.accent },
        chipLabel: {
          color: colors.textPrimary,
          fontSize: typography.detail.fontSize,
          fontWeight: "500",
        },
        chipLabelActive: { color: colors.sendLabel },
        empty: {
          color: colors.textSecondary,
          fontSize: typography.detail.fontSize,
          padding: space.md,
          textAlign: "center",
        },
      }),
    [colors],
  );
  const chip = (id: string, label: string, active: boolean, onPress: () => void) => (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      key={id}
      onPress={onPress}
      style={[styles.chip, active ? styles.chipActive : null]}
      testID={`mobile-threads-filter-${id}`}
    >
      <Text style={[styles.chipLabel, active ? styles.chipLabelActive : null]}>{label}</Text>
    </Pressable>
  );

  return (
    <View style={{ flex: 1 }} testID="mobile-threads">
      <ScreenHeader
        actions={[
          {
            label: filtered ? "Filters, on" : "Filters",
            icon: filtered ? "filter-circle" : "filter-circle-outline",
            onPress: () => setFiltersOpen((open) => !open),
            testID: "mobile-threads-filter",
          },
        ]}
        search={{ placeholder: MOBILE_COPY.searchThreads, onChangeText: setQuery }}
        title={MOBILE_SCREEN_TITLES.threads}
      />
      <ScrollView
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
      >
        <ThreadListNotices />
        <View style={styles.control}>
          <SegmentedControl
            onSelect={props.onSelectMode}
            optionTestID={(id) => `mobile-threads-mode-${id}`}
            options={MODE_OPTIONS}
            selected={props.mode}
            testID="mobile-threads-modes"
          />
        </View>
        {filtersOpen ? (
          <>
            <ScrollView
              contentContainerStyle={styles.chips}
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.chipRow}
            >
              {chip("host-all", MOBILE_COPY.allHosts, inboxHostFilter === "all", () =>
                setInboxHostFilter("all"),
              )}
              {hosts.map((host) =>
                chip(`host-${host.hostId}`, host.label, inboxHostFilter === host.hostId, () => {
                  setInboxHostFilter(host.hostId);
                  // A Project leaves the filter with the computer that holds it.
                  setProject((held) =>
                    held !== "all" && held.hostId !== host.hostId ? "all" : held,
                  );
                }),
              )}
            </ScrollView>
            {offeredProjects.length === 0 ? null : (
              <ScrollView
                contentContainerStyle={styles.chips}
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.chipRow}
              >
                {chip("project-all", MOBILE_COPY.allProjects, heldProject === "all", () =>
                  setProject("all"),
                )}
                {offeredProjects.map((entry) =>
                  chip(
                    `project-${entry.hostId}-${entry.projectId}`,
                    formatScreenshotSafeLabel(entry.name),
                    heldProject !== "all" &&
                      heldProject.hostId === entry.hostId &&
                      heldProject.projectId === entry.projectId,
                    () => setProject({ hostId: entry.hostId, projectId: entry.projectId }),
                  ),
                )}
              </ScrollView>
            )}
            <View style={styles.control}>
              <SegmentedControl
                onSelect={props.onSelectArrangement}
                optionTestID={(id) => `mobile-home-arrangement-${id}`}
                options={MOBILE_THREAD_ARRANGEMENTS}
                selected={props.arrangement}
                testID="mobile-home-arrangement"
              />
            </View>
          </>
        ) : null}
        {loading && rows.length === 0 ? <ActivityIndicator color={colors.accent} /> : null}
        {!(loading && rows.length === 0) && groups.length === 0 && threadHits.length === 0 ? (
          <Text style={styles.empty}>
            {transports.length === 0
              ? MOBILE_COPY.inboxEmpty
              : query.trim().length > 0 || filtered || props.mode !== "all"
                ? MOBILE_COPY.searchNone
                : MOBILE_COPY.threadsNone}
          </Text>
        ) : null}
        {threadHits.length > 0 ? (
          <ListSection testID="mobile-agents-message-hits" title={MOBILE_COPY.searchMessages}>
            {threadHits.map((hit, index) => (
              <ListRow
                detail={formatScreenshotSafeLabel(
                  hit.field === "tool"
                    ? `${MOBILE_COPY.searchToolOutput} · ${hit.snippet}`
                    : hit.field === "canvas"
                      ? `${MOBILE_COPY.searchCanvas} · ${hit.snippet}`
                      : hit.snippet,
                )}
                icon={threadModeIcon(hit.mode)}
                key={`${hit.hostId}:${hit.mode}:${hit.threadId}:${hit.turnId ?? hit.canvasId ?? "title"}`}
                label={formatScreenshotSafeLabel(hit.title)}
                last={index === threadHits.length - 1}
                onPress={() =>
                  props.onOpenThread(
                    rows.find(
                      (row) =>
                        row.hostId === hit.hostId &&
                        row.mode === hit.mode &&
                        row.threadId === hit.threadId,
                    ) ?? {
                      hostId: hit.hostId,
                      mode: hit.mode,
                      threadId: hit.threadId,
                      title: hit.title,
                      status: "active",
                      freshness: "",
                    },
                    hit.turnId,
                  )
                }
                testID={`mobile-agents-message-hit-${hit.mode}-${hit.threadId}`}
              />
            ))}
          </ListSection>
        ) : null}
        <View testID="mobile-home-thread-list">
          {groups.map((group) => (
            <ListSection
              key={group.id}
              testID={`mobile-home-group-${group.id}`}
              title={`${formatScreenshotSafeLabel(group.label)}  ${group.rows.length}`}
            >
              {group.rows.map((row, index) => (
                <ThreadRow
                  key={`${row.hostId}:${row.mode}:${row.threadId}`}
                  last={index === group.rows.length - 1}
                  onOpen={props.onOpenThread}
                  row={row}
                  showProject={props.arrangement !== "projects"}
                />
              ))}
            </ListSection>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}
