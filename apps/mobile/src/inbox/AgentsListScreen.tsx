import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  listAllHostsMobileInbox,
  MobileInboxFailure,
  type MobileInboxHostFailure,
  type MobileInboxRow,
} from "@octant/client-runtime";
import { MOBILE_COPY } from "../copy";
import { useMobileSession } from "../session/MobileSessionContext";
import { formatScreenshotSafeLabel } from "../security/screenshotSafeLabel";
import { mobileSpacing, mobileTypography } from "../theme/tokens";
import { useTheme, type ThemeColors } from "../../design-system";
import { ListRow, ListSection, NavBar, SegmentedControl, ToolbarButton } from "../ui/NativeChrome";
import { ModelPickerSheet } from "../ui/ModelPickerSheet";
import { HomeComposerSheet } from "./HomeComposerSheet";
import { sectionForAgentRow } from "./agentsListPresentation";
import { createRequestGuard } from "./requestGuard";
import { usePlacement } from "./usePlacement";

export type AgentListView = "all" | "attention" | "working" | "review";

export interface AgentsListScreenProps {
  readonly onBack: () => void;
  readonly onOpenThread: (row: MobileInboxRow) => void;
  readonly view: AgentListView;
}

function statusTone(status: string, colors: ThemeColors): string {
  const lower = status.toLowerCase();
  if (lower.includes("fail") || lower.includes("error") || lower.includes("closed")) {
    return colors.danger;
  }
  if (lower.includes("merge") || lower.includes("done")) return colors.merged;
  if (lower.includes("wait") || lower.includes("approval")) return colors.warning;
  return colors.textSecondary;
}

/** Host lifecycle words arrive lower-case ("active"); labels are sentence case. */
function sentenceCase(value: string): string {
  return value.length === 0 ? value : `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

export function AgentsListScreen(props: AgentsListScreenProps) {
  const { colors } = useTheme();
  const { transports, hosts, inboxHostFilter, setInboxHostFilter, refreshHosts } =
    useMobileSession();
  const [rows, setRows] = useState<ReadonlyArray<MobileInboxRow>>([]);
  const [failures, setFailures] = useState<ReadonlyArray<MobileInboxHostFailure>>([]);
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [creating, setCreating] = useState(false);
  const [composerError, setComposerError] = useState<string | undefined>();
  const [modelOpen, setModelOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  // The filter switches in place, so moving between views never leaves the list.
  const [view, setView] = useState<AgentListView>(props.view);

  const requestGuard = useRef(createRequestGuard()).current;
  const {
    placementTransport,
    placementLabel,
    placementDisabledReason,
    staleGate,
    models,
    modelOptionId,
    setModelOptionId,
    modelLabel,
    createChat,
  } = usePlacement({ fallbackToFirstHost: true });

  const hostLabel = useMemo(() => {
    const labels = new Map(hosts.map((host) => [host.hostId, host.label]));
    return (hostId: string) => labels.get(hostId) ?? hostId.slice(0, 8);
  }, [hosts]);

  const visibleTransports = useMemo(() => {
    if (inboxHostFilter === "all") return transports;
    return transports.filter((transport) => transport.hostId === inboxHostFilter);
  }, [inboxHostFilter, transports]);

  const refresh = useCallback(async () => {
    // A slower, older fetch must not overwrite what a newer one already showed.
    const request = requestGuard.begin();
    if (visibleTransports.length === 0) {
      setRows([]);
      setFailures([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      const result = await listAllHostsMobileInbox(visibleTransports);
      if (!requestGuard.isCurrent(request)) return;
      setRows(result.rows);
      setFailures(result.failures);
    } catch (cause) {
      if (!requestGuard.isCurrent(request)) return;
      setError(
        cause instanceof MobileInboxFailure
          ? cause.message
          : "Could not load threads from the host.",
      );
    } finally {
      if (requestGuard.isCurrent(request)) setLoading(false);
    }
  }, [requestGuard, visibleTransports]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createChatThread = async () => {
    if (placementTransport === undefined) {
      setComposerError("Pair a computer before starting a Chat thread.");
      return;
    }
    if (!staleGate.allowProductMutations) {
      setComposerError(staleGate.message);
      return;
    }
    setCreating(true);
    setComposerError(undefined);
    try {
      const row = await createChat(prompt);
      setPrompt("");
      setComposerOpen(false);
      await refresh();
      props.onOpenThread(row);
    } catch (cause) {
      setComposerError(
        cause instanceof MobileInboxFailure
          ? cause.message
          : "Could not create a Chat thread on the host.",
      );
    } finally {
      setCreating(false);
    }
  };

  const grouped = useMemo(() => {
    const attention: MobileInboxRow[] = [];
    const working: MobileInboxRow[] = [];
    const review: MobileInboxRow[] = [];
    const read: MobileInboxRow[] = [];
    for (const row of rows) {
      const section = sectionForAgentRow(row);
      if (section === "attention") attention.push(row);
      else if (section === "working") working.push(row);
      else if (section === "review") review.push(row);
      else read.push(row);
    }
    return { attention, working, review, read };
  }, [rows]);

  const sections = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const searchedRows = (sectionRows: ReadonlyArray<MobileInboxRow>) =>
      normalizedQuery.length === 0
        ? sectionRows
        : sectionRows.filter((row) =>
            [row.title, row.status, row.mode, hostLabel(row.hostId)].some((value) =>
              value.toLowerCase().includes(normalizedQuery),
            ),
          );
    const all: ReadonlyArray<{
      readonly title: string;
      readonly rows: ReadonlyArray<MobileInboxRow>;
    }> =
      view === "all"
        ? [
            { title: MOBILE_COPY.needsAttention, rows: grouped.attention },
            { title: MOBILE_COPY.working, rows: grouped.working },
            { title: MOBILE_COPY.inReview, rows: grouped.review },
            { title: MOBILE_COPY.read, rows: grouped.read },
          ]
        : [{ title: MOBILE_COPY.homeRecent, rows: grouped[view] }];
    return all
      .map((section) => ({ title: section.title, rows: searchedRows(section.rows) }))
      .filter((section) => section.rows.length > 0);
  }, [grouped, hostLabel, query, view]);

  const viewOptions: ReadonlyArray<{ readonly id: AgentListView; readonly label: string }> = [
    { id: "all", label: MOBILE_COPY.statusAllShort },
    { id: "attention", label: MOBILE_COPY.needsAttention },
    { id: "working", label: MOBILE_COPY.working },
    { id: "review", label: MOBILE_COPY.inReview },
  ];

  const modeLabel = (mode: MobileInboxRow["mode"]) =>
    mode === "code" ? "Code" : mode === "work" ? "Work" : "Chat";
  const modeIcon = (mode: MobileInboxRow["mode"]) =>
    mode === "code" ? "code-slash" : mode === "work" ? "briefcase-outline" : "chatbubble-outline";

  const styles = useMemo(
    () =>
      StyleSheet.create({
        shell: { flex: 1, backgroundColor: "transparent" },
        controls: { paddingHorizontal: mobileSpacing.md, gap: 10, marginBottom: mobileSpacing.md },
        search: {
          height: 36,
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingHorizontal: 8,
          borderRadius: 10,
          backgroundColor: colors.control,
        },
        searchInput: {
          flex: 1,
          height: 36,
          color: colors.textPrimary,
          fontSize: 17,
          outlineColor: "transparent",
          outlineStyle: "solid",
          outlineWidth: 0,
        },
        filters: { gap: mobileSpacing.sm },
        chip: {
          height: 30,
          justifyContent: "center",
          paddingHorizontal: 12,
          borderRadius: 999,
          backgroundColor: colors.control,
        },
        chipActive: { backgroundColor: colors.accent },
        chipLabel: {
          color: colors.textPrimary,
          fontSize: mobileTypography.detail.fontSize,
          fontWeight: "500",
        },
        chipLabelActive: { color: colors.sendLabel },
        list: { paddingBottom: mobileSpacing.xl },
        help: {
          color: colors.textSecondary,
          fontSize: mobileTypography.detail.fontSize,
          lineHeight: 18,
          paddingHorizontal: mobileSpacing.md,
          paddingVertical: mobileSpacing.md,
          textAlign: "center",
        },
        warn: { color: colors.warning, fontSize: mobileTypography.detail.fontSize, lineHeight: 18 },
        error: {
          color: colors.danger,
          fontSize: mobileTypography.detail.fontSize,
          paddingHorizontal: mobileSpacing.md,
          marginBottom: mobileSpacing.sm,
        },
        stale: { paddingTop: mobileSpacing.xs },
        failureRow: {
          paddingHorizontal: mobileSpacing.md,
          paddingBottom: mobileSpacing.sm,
          gap: 2,
        },
        retry: {
          color: colors.accent,
          fontSize: mobileTypography.detail.fontSize,
          fontWeight: "500",
        },
      }),
    [colors],
  );

  const title = viewOptions.find((option) => option.id === view)?.label ?? MOBILE_COPY.allAgents;

  return (
    <View style={styles.shell} testID="mobile-agents-list">
      <NavBar
        backLabel={MOBILE_COPY.inboxTitle}
        backTestID="mobile-agents-back"
        onBack={props.onBack}
        title={view === "all" ? MOBILE_COPY.allAgents : title}
        trailing={
          <>
            <ToolbarButton
              accessibilityLabel={searchOpen ? "Close search" : "Search agent work"}
              icon={searchOpen ? "close-circle" : "search"}
              onPress={() => {
                setSearchOpen((open) => !open);
                if (searchOpen) setQuery("");
              }}
              testID="mobile-agents-search"
            />
            <ToolbarButton
              accessibilityLabel="Filter hosts"
              icon={inboxHostFilter === "all" ? "filter-circle-outline" : "filter-circle"}
              onPress={() => setFiltersOpen((open) => !open)}
              testID="mobile-agents-filter"
            />
            <ToolbarButton
              accessibilityLabel="New Chat thread"
              icon="create-outline"
              onPress={() => setComposerOpen(true)}
              testID="mobile-agents-compose"
            />
          </>
        }
      />

      <View style={styles.controls}>
        {searchOpen ? (
          <View style={styles.search}>
            <Ionicons color={colors.textTertiary} name="search" size={16} />
            <TextInput
              autoFocus
              onChangeText={setQuery}
              placeholder="Search"
              placeholderTextColor={colors.textTertiary}
              style={styles.searchInput}
              testID="mobile-agents-search-input"
              value={query}
            />
          </View>
        ) : null}
        <SegmentedControl
          onSelect={setView}
          optionTestID={(id) => `mobile-agents-view-${id}`}
          options={viewOptions}
          selected={view}
          testID="mobile-agents-views"
        />
        {filtersOpen ? (
          <ScrollView
            contentContainerStyle={styles.filters}
            horizontal
            showsHorizontalScrollIndicator={false}
            testID="mobile-inbox-host-filters"
          >
            {[{ hostId: "all", label: MOBILE_COPY.allHosts }, ...hosts].map((host) => {
              const active = inboxHostFilter === host.hostId;
              return (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  key={host.hostId}
                  onPress={() => setInboxHostFilter(host.hostId)}
                  style={[styles.chip, active ? styles.chipActive : null]}
                  testID={`mobile-inbox-filter-${host.hostId}`}
                >
                  <Text style={[styles.chipLabel, active ? styles.chipLabelActive : null]}>
                    {host.label}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        ) : null}
      </View>

      {failures.map((failure) => {
        const label = hostLabel(failure.hostId);
        const message =
          failure.category === "incompatible"
            ? `${label} sent thread data this app version can't read. Update the app or the host.`
            : `${label}: ${failure.message}`;
        return (
          <View
            key={failure.hostId}
            style={styles.failureRow}
            testID={`mobile-inbox-failure-${failure.hostId}`}
          >
            <Text style={styles.warn}>{message}</Text>
            <Pressable
              onPress={() => void refresh()}
              testID={`mobile-inbox-retry-${failure.hostId}`}
            >
              <Text style={styles.retry}>Retry</Text>
            </Pressable>
          </View>
        );
      })}
      {error !== undefined ? (
        <Text style={styles.error} testID="mobile-inbox-error">
          {error}
        </Text>
      ) : null}

      <ScrollView contentContainerStyle={styles.list} contentInsetAdjustmentBehavior="automatic">
        {loading ? <ActivityIndicator color={colors.accent} /> : null}
        {!loading && sections.length === 0 ? (
          <Text style={styles.help}>
            {transports.length === 0 ? MOBILE_COPY.inboxEmpty : "No threads here yet"}
          </Text>
        ) : null}
        {sections.map((section) => (
          <ListSection key={section.title} title={section.title}>
            {section.rows.map((row, index) => (
              <ListRow
                accessory="none"
                detail={`${hostLabel(row.hostId)} · ${modeLabel(row.mode)}`}
                icon={modeIcon(row.mode)}
                key={`${row.hostId}:${row.mode}:${row.threadId}`}
                label={formatScreenshotSafeLabel(row.title)}
                last={index === section.rows.length - 1}
                onPress={() => props.onOpenThread(row)}
                testID={`mobile-inbox-row-${row.mode}-${row.threadId}`}
                value={sentenceCase(row.status)}
                valueTone={statusTone(row.status, colors)}
              />
            ))}
          </ListSection>
        ))}
      </ScrollView>

      {!staleGate.allowProductMutations ? (
        <Text style={[styles.error, styles.stale]} testID="mobile-agents-stale-gate">
          {staleGate.message}
        </Text>
      ) : null}
      <HomeComposerSheet
        availableModes={["chat"]}
        busy={creating}
        editable={staleGate.allowProductMutations && placementTransport !== undefined}
        error={composerError}
        mode="chat"
        modelLabel={modelLabel}
        onChangePrompt={setPrompt}
        onClose={() => setComposerOpen(false)}
        onPressModel={() => setModelOpen(true)}
        onSelectMode={() => undefined}
        onSubmit={() => void createChatThread()}
        onRefreshHost={() => void refreshHosts()}
        placementLabel={placementLabel}
        placementDisabledReason={placementDisabledReason}
        prompt={prompt}
        visible={composerOpen}
      />
      <ModelPickerSheet
        onClose={() => setModelOpen(false)}
        onSelect={(id) => {
          setModelOptionId(id);
          setModelOpen(false);
        }}
        options={models.options.map((option) => ({
          id: option.id,
          label: option.label,
          detail: option.detail,
        }))}
        selectedId={modelOptionId}
        visible={modelOpen}
      />
    </View>
  );
}
