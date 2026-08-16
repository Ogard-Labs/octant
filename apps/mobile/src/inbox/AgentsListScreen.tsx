import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  createMobileChatWithFirstTurn,
  decodeMobileModelOptionId,
  listAllHostsMobileInbox,
  MobileInboxFailure,
  type MobileInboxHostFailure,
  type MobileInboxRow,
} from "@octant/client-runtime";
import { presentStaleHostSecurity } from "@octant/domain";
import { MOBILE_COPY } from "../copy";
import { useMobileSession } from "../session/MobileSessionContext";
import { usePlacementHostModels } from "../session/usePlacementHostModels";
import { formatScreenshotSafeLabel } from "../security/screenshotSafeLabel";
import { mobileSpacing, mobileTypography } from "../theme/tokens";
import { useTheme, type ThemeColors } from "../../design-system";
import { IconButton } from "../ui/IconButton";
import { ModelPickerSheet } from "../ui/ModelPickerSheet";
import { HomeComposerSheet } from "./HomeComposerSheet";
import { InboxComposerDock } from "./InboxComposerDock";
import { sectionForAgentRow } from "./agentsListPresentation";

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

export function AgentsListScreen(props: AgentsListScreenProps) {
  const { colors } = useTheme();
  const {
    transports,
    hosts,
    inboxHostFilter,
    setInboxHostFilter,
    placementHostId,
    transportForHost,
    health,
  } = useMobileSession();
  const [rows, setRows] = useState<ReadonlyArray<MobileInboxRow>>([]);
  const [failures, setFailures] = useState<ReadonlyArray<MobileInboxHostFailure>>([]);
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [creating, setCreating] = useState(false);
  const [composerError, setComposerError] = useState<string | undefined>();
  const [modelOpen, setModelOpen] = useState(false);
  const [modelOptionId, setModelOptionId] = useState<string | undefined>();
  const [composerOpen, setComposerOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");

  const placementTransport = useMemo(() => {
    if (placementHostId !== undefined) {
      const selected = transportForHost(placementHostId);
      if (selected !== undefined) return selected;
    }
    return transports[0];
  }, [placementHostId, transportForHost, transports]);

  const placementHealth = useMemo(() => {
    if (placementTransport === undefined) return "idle" as const;
    return health.find((entry) => entry.hostId === placementTransport.hostId)?.kind ?? "idle";
  }, [health, placementTransport]);
  const staleGate = useMemo(() => presentStaleHostSecurity(placementHealth), [placementHealth]);
  const models = usePlacementHostModels(placementTransport);

  useEffect(() => {
    if (modelOptionId === undefined && models.options[0] !== undefined) {
      setModelOptionId(models.options[0].id);
    }
  }, [modelOptionId, models.options]);

  const hostLabel = useMemo(() => {
    const labels = new Map(hosts.map((host) => [host.hostId, host.label]));
    return (hostId: string) => labels.get(hostId) ?? hostId.slice(0, 8);
  }, [hosts]);

  const visibleTransports = useMemo(() => {
    if (inboxHostFilter === "all") return transports;
    return transports.filter((transport) => transport.hostId === inboxHostFilter);
  }, [inboxHostFilter, transports]);

  const refresh = useCallback(async () => {
    if (visibleTransports.length === 0) {
      setRows([]);
      setFailures([]);
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      const result = await listAllHostsMobileInbox(visibleTransports);
      setRows(result.rows);
      setFailures(result.failures);
    } catch (cause) {
      setError(
        cause instanceof MobileInboxFailure
          ? cause.message
          : "Could not load threads from the host.",
      );
    } finally {
      setLoading(false);
    }
  }, [visibleTransports]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selectedModel = useMemo(
    () => models.options.find((option) => option.id === modelOptionId),
    [modelOptionId, models.options],
  );

  const createChat = async () => {
    if (placementTransport === undefined) {
      setComposerError("Pair a host before starting a Chat thread.");
      return;
    }
    if (!staleGate.allowProductMutations) {
      setComposerError(staleGate.message);
      return;
    }
    setCreating(true);
    setComposerError(undefined);
    try {
      const decoded =
        modelOptionId === undefined ? undefined : decodeMobileModelOptionId(modelOptionId);
      const row = await createMobileChatWithFirstTurn({
        transport: placementTransport,
        prompt,
        ...(decoded === undefined
          ? {}
          : {
              providerInstanceId: decoded.providerInstanceId,
              modelId: decoded.modelId,
            }),
      });
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

  const listData = useMemo(() => {
    const items: Array<
      | { readonly kind: "header"; readonly id: string; readonly title: string }
      | { readonly kind: "row"; readonly row: MobileInboxRow }
    > = [];
    const normalizedQuery = query.trim().toLowerCase();
    const searchedRows = (sectionRows: ReadonlyArray<MobileInboxRow>) =>
      normalizedQuery.length === 0
        ? sectionRows
        : sectionRows.filter((row) =>
            [row.title, row.status, row.mode, hostLabel(row.hostId)].some((value) =>
              value.toLowerCase().includes(normalizedQuery),
            ),
          );
    const pushSection = (title: string, sectionRows: ReadonlyArray<MobileInboxRow>) => {
      const visibleRows = searchedRows(sectionRows);
      if (visibleRows.length === 0) return;
      items.push({ kind: "header", id: `h-${title}`, title });
      for (const row of visibleRows) items.push({ kind: "row", row });
    };
    if (props.view === "all") {
      pushSection(MOBILE_COPY.needsAttention, grouped.attention);
      pushSection(MOBILE_COPY.working, grouped.working);
      pushSection(MOBILE_COPY.inReview, grouped.review);
      pushSection(MOBILE_COPY.read, grouped.read);
    } else {
      pushSection("Recents", grouped[props.view]);
    }
    return items;
  }, [grouped, hostLabel, props.view, query]);

  const title =
    props.view === "all"
      ? "All Agents"
      : props.view === "attention"
        ? MOBILE_COPY.needsAttention
        : props.view === "working"
          ? MOBILE_COPY.working
          : MOBILE_COPY.inReview;

  const placementLabel = useMemo(() => {
    if (placementTransport === undefined) return undefined;
    return hosts.find((host) => host.hostId === placementTransport.hostId)?.label;
  }, [hosts, placementTransport]);

  const modelLabel =
    selectedModel?.label ??
    (models.options.length === 0 ? MOBILE_COPY.modelUnavailable : MOBILE_COPY.modelHostOnly);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        shell: { flex: 1, backgroundColor: "transparent" },
        topBar: {
          flexDirection: "row",
          justifyContent: "space-between",
          paddingHorizontal: mobileSpacing.md,
          paddingTop: mobileSpacing.sm,
        },
        topActions: { flexDirection: "row", gap: mobileSpacing.sm },
        hero: {
          color: colors.textPrimary,
          fontSize: mobileTypography.hero.fontSize,
          fontWeight: mobileTypography.hero.fontWeight,
          paddingHorizontal: mobileSpacing.md,
          marginTop: mobileSpacing.lg,
          marginBottom: mobileSpacing.md,
        },
        search: {
          marginHorizontal: mobileSpacing.md,
          marginBottom: mobileSpacing.md,
          minHeight: 44,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderColor: colors.separator,
          color: colors.textPrimary,
          fontSize: mobileTypography.body.fontSize,
          outlineColor: "transparent",
          outlineStyle: "solid",
          outlineWidth: 0,
        },
        filters: {
          flexDirection: "row",
          flexWrap: "wrap",
          gap: mobileSpacing.xs,
          paddingHorizontal: mobileSpacing.md,
          marginBottom: mobileSpacing.md,
        },
        chip: {
          backgroundColor: colors.surface,
          borderRadius: 999,
          paddingHorizontal: mobileSpacing.sm,
          paddingVertical: mobileSpacing.xs,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.border,
        },
        chipActive: {
          backgroundColor: colors.surfaceElevated,
          borderColor: colors.separator,
        },
        chipLabel: {
          color: colors.textPrimary,
          fontSize: mobileTypography.caption.fontSize,
        },
        list: { paddingHorizontal: mobileSpacing.md, paddingBottom: 126 },
        section: {
          color: colors.textSecondary,
          fontSize: mobileTypography.caption.fontSize,
          marginTop: mobileSpacing.md,
          marginBottom: mobileSpacing.sm,
        },
        sectionRow: {
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
        },
        row: {
          flexDirection: "row",
          alignItems: "center",
          gap: mobileSpacing.sm,
          paddingVertical: mobileSpacing.md,
          paddingHorizontal: mobileSpacing.xs,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.separator,
        },
        dot: {
          width: 8,
          height: 8,
          borderRadius: 4,
        },
        rowBody: { flex: 1, gap: 6 },
        metaRow: {
          flexDirection: "row",
          alignItems: "center",
          gap: mobileSpacing.sm,
          flexWrap: "wrap",
        },
        statusPill: {
          fontSize: 12,
          fontWeight: "600",
          textTransform: "capitalize",
        },
        rowTitle: {
          color: colors.textPrimary,
          fontSize: mobileTypography.body.fontSize,
          fontWeight: "600",
        },
        rowMeta: {
          fontSize: mobileTypography.caption.fontSize,
          color: colors.textSecondary,
        },
        help: {
          color: colors.textSecondary,
          paddingHorizontal: mobileSpacing.md,
          lineHeight: 20,
        },
        warn: {
          color: colors.textSecondary,
          paddingHorizontal: mobileSpacing.md,
        },
        error: {
          color: colors.danger,
          paddingHorizontal: mobileSpacing.md,
        },
        stale: { paddingBottom: mobileSpacing.xs },
      }),
    [colors],
  );

  return (
    <View style={styles.shell} testID="mobile-agents-list">
      <View style={styles.topBar}>
        <IconButton
          accessibilityLabel="Back"
          name="chevron-back"
          onPress={props.onBack}
          size={52}
          testID="mobile-agents-back"
        />
        <View style={styles.topActions}>
          <IconButton
            accessibilityLabel={searchOpen ? "Close search" : "Search agent work"}
            name={searchOpen ? "close-outline" : "search-outline"}
            onPress={() => {
              setSearchOpen((open) => !open);
              if (searchOpen) setQuery("");
            }}
            size={52}
            testID="mobile-agents-search"
          />
          <IconButton
            accessibilityLabel="Filter hosts"
            name="options-outline"
            onPress={() => setFiltersOpen((open) => !open)}
            size={52}
            testID="mobile-agents-filter"
          />
        </View>
      </View>
      <Text style={styles.hero}>{title}</Text>

      {searchOpen ? (
        <TextInput
          autoFocus
          onChangeText={setQuery}
          placeholder="Search work"
          placeholderTextColor={colors.textTertiary}
          style={styles.search}
          testID="mobile-agents-search-input"
          value={query}
        />
      ) : null}

      {filtersOpen ? (
        <View style={styles.filters} testID="mobile-inbox-host-filters">
          <Pressable
            onPress={() => setInboxHostFilter("all")}
            style={[styles.chip, inboxHostFilter === "all" ? styles.chipActive : null]}
            testID="mobile-inbox-filter-all"
          >
            <Text style={styles.chipLabel}>{MOBILE_COPY.allHosts}</Text>
          </Pressable>
          {hosts.map((host) => (
            <Pressable
              key={host.hostId}
              onPress={() => setInboxHostFilter(host.hostId)}
              style={[styles.chip, inboxHostFilter === host.hostId ? styles.chipActive : null]}
              testID={`mobile-inbox-filter-${host.hostId}`}
            >
              <Text style={styles.chipLabel}>{host.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {loading ? <ActivityIndicator color={colors.accent} /> : null}
      {failures.length > 0 ? (
        <Text style={styles.warn} testID="mobile-inbox-partial-failure">
          {failures.length} host{failures.length === 1 ? "" : "s"} unavailable — showing healthy
          hosts only.
        </Text>
      ) : null}
      {error !== undefined ? (
        <Text style={styles.error} testID="mobile-inbox-error">
          {error}
        </Text>
      ) : null}

      <FlatList
        contentInsetAdjustmentBehavior="automatic"
        data={listData}
        keyExtractor={(item) =>
          item.kind === "header"
            ? item.id
            : `${item.row.hostId}:${item.row.mode}:${item.row.threadId}`
        }
        ListEmptyComponent={
          !loading ? (
            <Text style={styles.help}>
              {transports.length === 0 ? MOBILE_COPY.inboxEmpty : "No threads on these hosts yet."}
            </Text>
          ) : null
        }
        contentContainerStyle={styles.list}
        renderItem={({ item }) => {
          if (item.kind === "header") {
            return (
              <View style={styles.sectionRow}>
                <Text style={styles.section}>{item.title}</Text>
                <Ionicons color={colors.textTertiary} name="chevron-down" size={13} />
              </View>
            );
          }
          const row = item.row;
          const section = sectionForAgentRow(row);
          const tone =
            section === "attention"
              ? colors.attention
              : section === "working"
                ? colors.accent
                : section === "review"
                  ? colors.merged
                  : colors.separator;
          return (
            <Pressable
              accessibilityRole="button"
              onPress={() => props.onOpenThread(row)}
              style={styles.row}
              testID={`mobile-inbox-row-${row.mode}-${row.threadId}`}
            >
              <View style={[styles.dot, { backgroundColor: tone }]} />
              <View style={styles.rowBody}>
                <Text style={styles.rowTitle}>{formatScreenshotSafeLabel(row.title)}</Text>
                <View style={styles.metaRow}>
                  <Text style={[styles.statusPill, { color: statusTone(row.status, colors) }]}>
                    {row.status}
                  </Text>
                  <Text style={styles.rowMeta}>
                    {hostLabel(row.hostId)} · {row.mode}
                  </Text>
                </View>
              </View>
            </Pressable>
          );
        }}
      />

      {!staleGate.allowProductMutations ? (
        <Text style={[styles.error, styles.stale]} testID="mobile-agents-stale-gate">
          {staleGate.message}
        </Text>
      ) : null}
      <InboxComposerDock onOpen={() => setComposerOpen(true)} />
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
        onSubmit={() => void createChat()}
        placementLabel={placementLabel}
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
