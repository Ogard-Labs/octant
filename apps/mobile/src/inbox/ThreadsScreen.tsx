import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import {
  searchMobileTranscripts,
  type MobileInboxRow,
  type MobileTranscriptHit,
} from "@octant/client-runtime";
import { MOBILE_COPY, MOBILE_SCREEN_TITLES } from "../copy";
import { space, useTheme } from "../../design-system";
import { NEW_BUTTON_CLEARANCE } from "../navigation/places";
import { ScreenHeader } from "../navigation/ScreenHeader";
import { formatScreenshotSafeLabel } from "../security/screenshotSafeLabel";
import { useMobileSession } from "../session/MobileSessionContext";
import { ChoicePill } from "../ui/ChoicePill";
import { ListRow, ListSection } from "../ui/NativeChrome";
import { searchHitsBesideList } from "./agentsListPresentation";
import { EmptyPlace } from "../ui/EmptyPlace";
import { useMobileThreads } from "./MobileThreadsContext";
import { ThreadListNotices } from "./ThreadListNotices";
import { ThreadGroup } from "./ThreadGroup";
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

// Below the list, and the person's to fold.
const SHELVES: ReadonlySet<string> = new Set(["working", "snoozed", "settled"]);

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
  // Working is open and the shelves are folded until the person says otherwise.
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set(["snoozed", "settled"]));
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
        pills: {
          gap: space.sm,
          paddingHorizontal: space.md,
          paddingTop: space.xs,
          paddingBottom: space.sm,
        },
        // A pill's glass casts past the strip, which would cut it off.
        pillRow: { flexGrow: 0, overflow: "visible" },
      }),
    [],
  );
  const projectId =
    heldProject === "all" ? "all" : `${heldProject.hostId}:${heldProject.projectId}`;

  return (
    <View style={{ flex: 1 }} testID="mobile-threads">
      <ScreenHeader
        search={{ placeholder: MOBILE_COPY.searchThreads, onChangeText: setQuery }}
        place
        title={MOBILE_SCREEN_TITLES.threads}
      />
      <ScrollView
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
      >
        <ThreadListNotices />
        <ScrollView
          contentContainerStyle={styles.pills}
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.pillRow}
        >
          <ChoicePill
            neutral="all"
            onSelect={(hostId) => {
              setInboxHostFilter(hostId);
              // A Project leaves the filter with the computer that holds it.
              setProject((held) => (held !== "all" && held.hostId !== hostId ? "all" : held));
            }}
            options={[
              { id: "all", label: MOBILE_COPY.allHosts },
              ...hosts.map((host) => ({ id: host.hostId, label: host.label })),
            ]}
            selected={inboxHostFilter}
            testID="mobile-threads-filter-host"
            title={MOBILE_COPY.workspaces}
          />
          <ChoicePill
            neutral="all"
            onSelect={(id) => {
              const chosen = offeredProjects.find(
                (entry) => `${entry.hostId}:${entry.projectId}` === id,
              );
              setProject(
                chosen === undefined
                  ? "all"
                  : { hostId: chosen.hostId, projectId: chosen.projectId },
              );
            }}
            options={[
              { id: "all", label: MOBILE_COPY.allProjects },
              ...offeredProjects.map((entry) => ({
                id: `${entry.hostId}:${entry.projectId}`,
                label: formatScreenshotSafeLabel(entry.name),
              })),
            ]}
            selected={projectId}
            testID="mobile-threads-filter-project"
            title={MOBILE_COPY.projects}
          />
          <ChoicePill
            neutral="all"
            onSelect={props.onSelectMode}
            options={MODE_OPTIONS}
            selected={props.mode}
            testID="mobile-threads-mode"
            title={MOBILE_COPY.modes}
          />
          <ChoicePill
            onSelect={props.onSelectArrangement}
            options={MOBILE_THREAD_ARRANGEMENTS}
            selected={props.arrangement}
            testID="mobile-home-arrangement"
            title={MOBILE_COPY.arrangement}
          />
        </ScrollView>
        {loading && rows.length === 0 ? <ActivityIndicator color={colors.accent} /> : null}
        {!(loading && rows.length === 0) && groups.length === 0 && threadHits.length === 0 ? (
          <EmptyPlace
            icon="chatbubbles-outline"
            text={
              transports.length === 0
                ? MOBILE_COPY.inboxEmpty
                : query.trim().length > 0 || filtered || props.mode !== "all"
                  ? MOBILE_COPY.searchNone
                  : MOBILE_COPY.threadsNone
            }
          />
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
          {groups.map((group, index) => {
            const shelf = SHELVES.has(group.id);
            return (
              <ThreadGroup
                folded={folded.has(group.id)}
                key={group.id}
                label={index === 0 && !shelf ? undefined : formatScreenshotSafeLabel(group.label)}
                onOpen={props.onOpenThread}
                onToggle={
                  shelf
                    ? () =>
                        setFolded((current) => {
                          const next = new Set(current);
                          if (!next.delete(group.id)) next.add(group.id);
                          return next;
                        })
                    : undefined
                }
                rows={group.rows}
                testID={`mobile-home-group-${group.id}`}
              />
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}
