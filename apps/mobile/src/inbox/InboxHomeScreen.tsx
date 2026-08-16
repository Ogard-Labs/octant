import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  createMobileChatWithFirstTurn,
  createMobileCodeFromPrompt,
  createMobileWorkFromPrompt,
  decodeMobileModelOptionId,
  fetchMobileCodeProjects,
  fetchMobileWorkProjects,
  listAllHostsMobileInbox,
  MobileCodeCreationFailure,
  MobileInboxFailure,
  type MobileCodeProjectOption,
  type MobileCodeCreationRetry,
  type MobileCodeDeliveryTargetProposal,
  type MobileWorkProjectOption,
  type MobileInboxRow,
} from "@octant/client-runtime";
import type { CodeDeliveryTarget } from "@octant/contracts";
import { presentStaleHostSecurity } from "@octant/domain";
import { MOBILE_COPY } from "../copy";
import { useMobileSession } from "../session/MobileSessionContext";
import { usePlacementHostModels } from "../session/usePlacementHostModels";
import { formatScreenshotSafeLabel } from "../security/screenshotSafeLabel";
import { GlassSurface, radii, space, typography, useTheme } from "../../design-system";
import { mobileCreateModePresentation, type MobileCreateMode } from "./createModePresentation";
import type { MobileHomeView } from "./homeView";
import { inboxStatusCounts, inboxWorkStatus } from "./inboxWorkPresentation";
import { HomeComposerSheet } from "./HomeComposerSheet";
import { HomeNavigationSheet } from "./HomeNavigationSheet";
import { InboxComposerDock } from "./InboxComposerDock";
import { FloatingComposer } from "../ui/FloatingComposer";
import { IconButton } from "../ui/IconButton";
import { ModelPickerSheet } from "../ui/ModelPickerSheet";
import { CodeDeliveryTargetSheet } from "./CodeDeliveryTargetSheet";
import { selectMobilePlacementTransport } from "./placementTransport";
import { createProjectRequestGuard } from "./projectRequestGuard";
import { StatusCard } from "../ui/StatusCard";
import type { AgentListView } from "./AgentsListScreen";

export interface InboxHomeScreenProps {
  readonly homeMode: MobileHomeView;
  readonly onSelectHomeMode: (mode: MobileHomeView) => void;
  readonly onOpenAgents: (view: AgentListView) => void;
  readonly onOpenHosts: () => void;
  readonly onOpenWorkspace: (hostId: string) => void;
  readonly onAddWorkspace: () => void;
  readonly onOpenThread: (row: MobileInboxRow) => void;
}

const VIEW_TITLES: Record<Exclude<MobileHomeView, "inbox">, string> = {
  chat: "Chats",
  work: "Work",
  code: "Code",
};

function modeIcon(
  mode: MobileInboxRow["mode"],
): "chatbubble-outline" | "folder-outline" | "code-slash" {
  if (mode === "work") return "folder-outline";
  if (mode === "code") return "code-slash";
  return "chatbubble-outline";
}

export function InboxHomeScreen(props: InboxHomeScreenProps) {
  const { colors } = useTheme();
  const { transports, hosts, placementHostId, transportForHost, health } = useMobileSession();
  const [rows, setRows] = useState<ReadonlyArray<MobileInboxRow>>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [composerError, setComposerError] = useState<string | undefined>();
  const [modelOpen, setModelOpen] = useState(false);
  const [composerSheetOpen, setComposerSheetOpen] = useState(false);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [composerMode, setComposerMode] = useState<MobileCreateMode>("chat");
  const [modelOptionId, setModelOptionId] = useState<string | undefined>();
  const [workProjects, setWorkProjects] = useState<ReadonlyArray<MobileWorkProjectOption>>([]);
  const [codeProjects, setCodeProjects] = useState<ReadonlyArray<MobileCodeProjectOption>>([]);
  const [workProjectId, setWorkProjectId] = useState<string | undefined>();
  const [codeProjectId, setCodeProjectId] = useState<string | undefined>();
  const [codeRetry, setCodeRetry] = useState<MobileCodeCreationRetry | undefined>();
  const [deliveryTargetProposal, setDeliveryTargetProposal] = useState<
    MobileCodeDeliveryTargetProposal | undefined
  >();
  const projectRequestGuard = useRef(createProjectRequestGuard()).current;
  const deliveryTargetResolver = useRef<
    ((target: CodeDeliveryTarget | undefined) => void) | undefined
  >(undefined);

  const placementTransport = useMemo(() => {
    return selectMobilePlacementTransport({ placementHostId, transports, transportForHost });
  }, [placementHostId, transportForHost, transports]);
  const placementHealth = useMemo(() => {
    if (placementTransport === undefined) return "idle" as const;
    return health.find((entry) => entry.hostId === placementTransport.hostId)?.kind ?? "idle";
  }, [health, placementTransport]);
  const staleGate = useMemo(() => presentStaleHostSecurity(placementHealth), [placementHealth]);
  const models = usePlacementHostModels(placementTransport);
  const requestDeliveryTarget = useCallback((proposal: MobileCodeDeliveryTargetProposal) => {
    return new Promise<CodeDeliveryTarget | undefined>((resolve) => {
      deliveryTargetResolver.current?.(undefined);
      deliveryTargetResolver.current = resolve;
      setDeliveryTargetProposal(proposal);
    });
  }, []);

  const finishDeliveryTarget = useCallback((target: CodeDeliveryTarget | undefined) => {
    const resolve = deliveryTargetResolver.current;
    deliveryTargetResolver.current = undefined;
    setDeliveryTargetProposal(undefined);
    resolve?.(target);
  }, []);

  useEffect(
    () => () => {
      deliveryTargetResolver.current?.(undefined);
      deliveryTargetResolver.current = undefined;
    },
    [],
  );

  useEffect(() => {
    setCodeRetry(undefined);
  }, [placementTransport]);
  const placementLabel = useMemo(() => {
    if (placementTransport === undefined) return undefined;
    return hosts.find((host) => host.hostId === placementTransport.hostId)?.label;
  }, [hosts, placementTransport]);
  const hostLabels = useMemo(
    () => new Map(hosts.map((host) => [host.hostId, host.label])),
    [hosts],
  );

  useEffect(() => {
    if (modelOptionId === undefined && models.options[0] !== undefined) {
      setModelOptionId(models.options[0].id);
    }
  }, [modelOptionId, models.options]);

  useEffect(() => {
    const request = projectRequestGuard.begin();
    setWorkProjects([]);
    setCodeProjects([]);
    setWorkProjectId(undefined);
    setCodeProjectId(undefined);
    if (placementTransport === undefined) {
      return () => projectRequestGuard.invalidate();
    }
    let cancelled = false;
    void Promise.all([
      fetchMobileWorkProjects(placementTransport).catch(() => []),
      fetchMobileCodeProjects(placementTransport).catch(() => []),
    ]).then(([nextWork, nextCode]) => {
      if (cancelled || !projectRequestGuard.isCurrent(request)) return;
      setWorkProjects(nextWork);
      setCodeProjects(nextCode);
      setWorkProjectId((current) =>
        nextWork.some((project) => project.projectId === current)
          ? current
          : nextWork[0]?.projectId,
      );
      setCodeProjectId((current) =>
        nextCode.some((project) => project.projectId === current)
          ? current
          : nextCode[0]?.projectId,
      );
    });
    return () => {
      cancelled = true;
      projectRequestGuard.invalidate();
    };
  }, [placementTransport, projectRequestGuard]);

  const refresh = useCallback(async () => {
    if (transports.length === 0) {
      setRows([]);
      return;
    }
    setLoading(true);
    try {
      const result = await listAllHostsMobileInbox(transports);
      setRows(result.rows);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [transports]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selectedModel = useMemo(
    () => models.options.find((option) => option.id === modelOptionId),
    [modelOptionId, models.options],
  );
  const selectedWorkProject = workProjects.find((project) => project.projectId === workProjectId);
  const selectedCodeProject = codeProjects.find((project) => project.projectId === codeProjectId);
  const modeRows = useMemo(
    () => (props.homeMode === "inbox" ? [] : rows.filter((row) => row.mode === props.homeMode)),
    [props.homeMode, rows],
  );
  const counts = useMemo(() => inboxStatusCounts(rows), [rows]);

  const createThread = async (mode: MobileCreateMode) => {
    if (placementTransport === undefined) {
      setComposerError(MOBILE_COPY.pairBeforeCreate);
      return;
    }
    if (!staleGate.allowProductMutations) {
      setComposerError(staleGate.message);
      return;
    }
    setCreating(true);
    setComposerError(undefined);
    try {
      if (mode === "code") {
        if (selectedCodeProject === undefined) {
          setComposerError(MOBILE_COPY.codeNoProject);
          return;
        }
        if (selectedModel === undefined) {
          setComposerError("Select a host-advertised model before starting Code.");
          return;
        }
        const row = await createMobileCodeFromPrompt({
          transport: placementTransport,
          prompt,
          project: selectedCodeProject,
          providerInstanceId: selectedModel.providerInstanceId,
          modelId: selectedModel.modelId,
          confirmDeliveryTarget: requestDeliveryTarget,
          ...(codeRetry === undefined ? {} : { retry: codeRetry }),
        });
        setPrompt("");
        setCodeRetry(undefined);
        setComposerSheetOpen(false);
        await refresh();
        props.onOpenThread(row);
        return;
      }
      if (mode === "work") {
        if (selectedWorkProject === undefined) {
          setComposerError(MOBILE_COPY.workNoProject);
          return;
        }
        if (selectedModel === undefined) {
          setComposerError("Select a host-advertised model before creating Work.");
          return;
        }
        const row = await createMobileWorkFromPrompt({
          transport: placementTransport,
          prompt,
          projectId: selectedWorkProject.projectId,
          providerInstanceId: selectedModel.providerInstanceId,
          modelId: selectedModel.modelId,
          bindingRevisionId: selectedWorkProject.bindingRevisionId,
        });
        setPrompt("");
        setComposerSheetOpen(false);
        await refresh();
        props.onOpenThread(row);
        return;
      }
      const decoded =
        modelOptionId === undefined ? undefined : decodeMobileModelOptionId(modelOptionId);
      const row = await createMobileChatWithFirstTurn({
        transport: placementTransport,
        prompt,
        ...(decoded === undefined
          ? {}
          : { providerInstanceId: decoded.providerInstanceId, modelId: decoded.modelId }),
      });
      setPrompt("");
      setComposerSheetOpen(false);
      await refresh();
      props.onOpenThread(row);
    } catch (cause) {
      if (cause instanceof MobileCodeCreationFailure) setCodeRetry(cause.retry);
      setComposerError(
        cause instanceof MobileInboxFailure
          ? cause.message
          : "Could not create a thread on the host.",
      );
    } finally {
      setCreating(false);
    }
  };

  const modelLabel =
    selectedModel?.label ??
    (models.options.length === 0 ? MOBILE_COPY.modelUnavailable : MOBILE_COPY.modelHostOnly);
  const footerHint =
    placementLabel !== undefined
      ? `${MOBILE_COPY.newThreadsUse} ${placementLabel}`
      : MOBILE_COPY.composerDisclaimerShort;
  const modePresentation =
    props.homeMode === "inbox"
      ? undefined
      : mobileCreateModePresentation(props.homeMode, {
          placementLabel,
          workProjectName: selectedWorkProject?.name,
          codeProjectName: selectedCodeProject?.name,
        });
  const selectableProjects =
    props.homeMode === "work" ? workProjects : props.homeMode === "code" ? codeProjects : [];
  const selectedProjectId =
    props.homeMode === "work"
      ? workProjectId
      : props.homeMode === "code"
        ? codeProjectId
        : undefined;
  const currentCreateMode: MobileCreateMode =
    props.homeMode === "inbox" ? composerMode : props.homeMode;
  const composerProjectLabel =
    composerMode === "code"
      ? selectedCodeProject?.name
      : composerMode === "work"
        ? selectedWorkProject?.name
        : undefined;

  const styles = useMemo(
    () =>
      StyleSheet.create({
        shell: { flex: 1, backgroundColor: "transparent" },
        topBar: {
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          paddingHorizontal: 20,
          paddingTop: process.env.EXPO_OS === "web" ? 50 : space.sm,
          paddingBottom: space.sm,
        },
        topActions: { flexDirection: "row", gap: space.sm },
        content: { paddingHorizontal: 20, paddingBottom: space.xl, flexGrow: 1 },
        titleRow: {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          marginTop: space.lg,
          marginBottom: space.xl,
        },
        hero: {
          color: colors.textPrimary,
          fontSize: typography.hero.fontSize,
          fontWeight: typography.hero.fontWeight,
          letterSpacing: typography.hero.letterSpacing,
        },
        subhero: {
          color: colors.textSecondary,
          fontSize: typography.caption.fontSize,
          lineHeight: 20,
          marginTop: space.xs,
          marginBottom: space.lg,
        },
        grid: { gap: space.md, marginBottom: space.xxl },
        gridRow: { flexDirection: "row", gap: space.md },
        section: {
          color: colors.textSecondary,
          fontSize: typography.caption.fontSize,
          marginBottom: space.sm,
        },
        workspaceRow: {
          minHeight: 68,
          flexDirection: "row",
          alignItems: "center",
          gap: space.sm,
          paddingHorizontal: space.xs,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.glassStroke,
        },
        workspaceRowPressed: { backgroundColor: colors.glassFillThin },
        workspaceLabel: {
          flex: 1,
          color: colors.textPrimary,
          fontSize: typography.body.fontSize,
          fontWeight: "500",
        },
        workspaceCount: {
          color: colors.textSecondary,
          fontSize: typography.caption.fontSize,
          fontVariant: ["tabular-nums"],
        },
        projectLabel: {
          color: colors.textSecondary,
          fontSize: typography.section.fontSize,
          fontWeight: typography.section.fontWeight,
          letterSpacing: typography.section.letterSpacing,
          textTransform: "uppercase",
          marginBottom: space.sm,
        },
        projectScroll: { marginBottom: space.lg },
        projectScrollContent: { gap: space.sm },
        projectChip: {
          minHeight: 40,
          justifyContent: "center",
          paddingHorizontal: space.md,
          borderRadius: radii.pill,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.glassStroke,
          backgroundColor: colors.glassFillThin,
        },
        projectChipSelected: {
          borderColor: colors.glassStrokeStrong,
          backgroundColor: colors.glassFillThick,
        },
        projectName: {
          color: colors.textPrimary,
          fontSize: typography.caption.fontSize,
          fontWeight: "600",
        },
        workFeed: { gap: space.lg },
        workSection: { gap: space.sm },
        workSectionHeader: {
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
        },
        workSectionTitle: {
          color: colors.textSecondary,
          fontSize: typography.section.fontSize,
          fontWeight: typography.section.fontWeight,
          letterSpacing: typography.section.letterSpacing,
          textTransform: "uppercase",
        },
        workSectionCount: {
          color: colors.textTertiary,
          fontSize: typography.caption.fontSize,
          fontVariant: ["tabular-nums"],
        },
        threadList: { gap: space.sm },
        threadRow: { minHeight: 68 },
        threadRowContent: {
          flexDirection: "row",
          alignItems: "center",
          gap: space.md,
          paddingHorizontal: space.md,
          paddingVertical: space.sm,
        },
        threadIcon: {
          width: 34,
          height: 34,
          borderRadius: 17,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.glassFillRegular,
        },
        threadBody: { flex: 1, gap: 4 },
        threadTitle: {
          color: colors.textPrimary,
          fontSize: typography.body.fontSize,
          fontWeight: "600",
        },
        threadMeta: { color: colors.textSecondary, fontSize: typography.caption.fontSize },
        status: {
          color: colors.textSecondary,
          fontSize: 11,
          fontWeight: "600",
          textAlign: "right",
        },
        empty: { color: colors.textSecondary, lineHeight: 22, paddingVertical: space.md },
        loader: { marginTop: space.md },
        composerError: {
          color: colors.danger,
          paddingHorizontal: space.md,
          paddingBottom: space.xs,
          fontSize: typography.caption.fontSize,
        },
      }),
    [colors],
  );

  const threadRow = (row: MobileInboxRow, showMode: boolean) => (
    <Pressable
      accessibilityRole="button"
      key={`${row.hostId}:${row.mode}:${row.threadId}`}
      onPress={() => props.onOpenThread(row)}
      testID={`mobile-home-thread-row-${row.mode}-${row.threadId}`}
    >
      <GlassSurface
        contentStyle={styles.threadRowContent}
        material="thin"
        radius={radii.md}
        style={styles.threadRow}
      >
        <View style={styles.threadIcon}>
          <Ionicons color={colors.textSecondary} name={modeIcon(row.mode)} size={17} />
        </View>
        <View style={styles.threadBody}>
          <Text numberOfLines={1} style={styles.threadTitle}>
            {formatScreenshotSafeLabel(row.title)}
          </Text>
          <Text numberOfLines={1} style={styles.threadMeta}>
            {showMode ? `${row.mode === "code" ? "Code" : "Work"} · ` : ""}
            {hostLabels.get(row.hostId) ?? row.hostId.slice(0, 8)}
          </Text>
        </View>
        {showMode ? (
          <Text style={styles.status}>{inboxWorkStatus(row.status, row.reviewState)}</Text>
        ) : null}
        <Ionicons color={colors.textTertiary} name="chevron-forward" size={17} />
      </GlassSurface>
    </Pressable>
  );

  return (
    <View style={styles.shell} testID="mobile-inbox-home">
      <View style={styles.topBar}>
        <IconButton
          accessibilityLabel="Open navigation menu"
          name="menu-outline"
          onPress={() => setNavigationOpen(true)}
          size={52}
          testID="mobile-home-menu"
        />
        <View style={styles.topActions}>
          <IconButton
            accessibilityLabel="Search all work"
            iconSize={24}
            name="search-outline"
            onPress={() => props.onOpenAgents("all")}
            size={52}
            testID="mobile-home-search"
          />
          {props.homeMode === "inbox" ? (
            <IconButton
              accessibilityLabel="Add workspace"
              iconSize={24}
              name="folder-open-outline"
              onPress={props.onAddWorkspace}
              size={52}
              testID="mobile-home-add-workspace"
            />
          ) : null}
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.titleRow}>
          <Text style={styles.hero}>
            {props.homeMode === "inbox" ? "Inbox" : VIEW_TITLES[props.homeMode]}
          </Text>
        </View>

        {props.homeMode === "inbox" ? null : (
          <Text style={styles.subhero}>{modePresentation?.description}</Text>
        )}

        {props.homeMode === "work" || props.homeMode === "code" ? (
          <View>
            <Text style={styles.projectLabel}>
              {props.homeMode === "code" ? "Repository" : "Project"}
            </Text>
            {selectableProjects.length === 0 ? (
              <Text style={styles.empty}>
                {props.homeMode === "code" ? MOBILE_COPY.codeNoProject : MOBILE_COPY.workNoProject}
              </Text>
            ) : (
              <ScrollView
                contentContainerStyle={styles.projectScrollContent}
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.projectScroll}
              >
                {selectableProjects.map((project) => {
                  const selected = project.projectId === selectedProjectId;
                  return (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      key={project.projectId}
                      onPress={() => {
                        if (props.homeMode === "work") setWorkProjectId(project.projectId);
                        else setCodeProjectId(project.projectId);
                        setCodeRetry(undefined);
                      }}
                      style={[styles.projectChip, selected ? styles.projectChipSelected : null]}
                      testID={`mobile-home-project-${project.projectId}`}
                    >
                      <Text style={styles.projectName}>
                        {formatScreenshotSafeLabel(project.name)}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            )}
          </View>
        ) : null}

        {props.homeMode === "inbox" ? (
          <View>
            <View style={styles.grid} testID="mobile-home-status-grid">
              <View style={styles.gridRow}>
                <StatusCard
                  icon="play-forward"
                  iconColor={colors.primary}
                  onPress={() => props.onOpenAgents("all")}
                  testID="mobile-card-all-agents"
                  title={MOBILE_COPY.allAgents}
                />
                <StatusCard
                  count={counts.working}
                  icon="ellipse"
                  iconColor={colors.attention}
                  onPress={() => props.onOpenAgents("working")}
                  testID="mobile-card-working"
                  title={MOBILE_COPY.working}
                />
              </View>
              <View style={styles.gridRow}>
                <StatusCard
                  count={counts.needsAttention}
                  icon="notifications-outline"
                  iconColor={colors.warning}
                  onPress={() => props.onOpenAgents("attention")}
                  testID="mobile-card-attention"
                  title={MOBILE_COPY.needsAttention}
                />
                <StatusCard
                  count={counts.inReview}
                  icon="checkmark-circle-outline"
                  iconColor={colors.merged}
                  onPress={() => props.onOpenAgents("review")}
                  testID="mobile-card-review"
                  title={MOBILE_COPY.inReview}
                />
              </View>
            </View>

            <Text style={styles.section}>{MOBILE_COPY.workspaces}</Text>
            {loading ? <ActivityIndicator color={colors.accent} style={styles.loader} /> : null}
            {hosts.map((host) => {
              const hostWorkCount = rows.filter(
                (row) => row.hostId === host.hostId && row.mode !== "chat",
              ).length;
              return (
                <Pressable
                  accessibilityRole="button"
                  key={host.hostId}
                  onPress={() => props.onOpenWorkspace(host.hostId)}
                  style={({ pressed }) => [
                    styles.workspaceRow,
                    pressed ? styles.workspaceRowPressed : null,
                  ]}
                  testID={`mobile-workspace-${host.hostId}`}
                >
                  <Ionicons color={colors.textSecondary} name="folder-outline" size={21} />
                  <Text numberOfLines={1} style={styles.workspaceLabel}>
                    {host.label}
                  </Text>
                  {hostWorkCount > 0 ? (
                    <Text style={styles.workspaceCount}>{hostWorkCount}</Text>
                  ) : null}
                  <Ionicons color={colors.textTertiary} name="chevron-forward" size={18} />
                </Pressable>
              );
            })}
            <Pressable
              accessibilityRole="button"
              onPress={props.onAddWorkspace}
              style={({ pressed }) => [
                styles.workspaceRow,
                pressed ? styles.workspaceRowPressed : null,
              ]}
              testID="mobile-workspace-add"
            >
              <Ionicons color={colors.textSecondary} name="folder-open-outline" size={21} />
              <Text style={styles.workspaceLabel}>{MOBILE_COPY.addWorkspace}</Text>
              <Ionicons color={colors.textTertiary} name="chevron-forward" size={18} />
            </Pressable>
          </View>
        ) : (
          <View style={styles.threadList} testID="mobile-home-thread-list">
            {loading ? <ActivityIndicator color={colors.accent} style={styles.loader} /> : null}
            {!loading && modeRows.length === 0 ? (
              <Text style={styles.empty}>{MOBILE_COPY.inboxNoThreads}</Text>
            ) : (
              modeRows.map((row) => threadRow(row, false))
            )}
          </View>
        )}
      </ScrollView>

      {props.homeMode === "inbox" ? (
        <InboxComposerDock
          onOpen={() => {
            setComposerMode("chat");
            setComposerError(undefined);
            setCodeRetry(undefined);
            setComposerSheetOpen(true);
          }}
        />
      ) : (
        <>
          {composerError !== undefined ? (
            <Text style={styles.composerError} testID="mobile-home-composer-error">
              {composerError}
            </Text>
          ) : null}
          <FloatingComposer
            busy={creating}
            editable={staleGate.allowProductMutations && placementTransport !== undefined}
            footerHint={footerHint}
            modelLabel={modelLabel}
            onChangeText={(value) => {
              setPrompt(value);
              setCodeRetry(undefined);
            }}
            onPressModel={() => setModelOpen(true)}
            onSubmit={() => void createThread(currentCreateMode)}
            placeholder={modePresentation?.placeholder ?? MOBILE_COPY.composerHome}
            testID="mobile-home-composer"
            value={prompt}
          />
        </>
      )}
      <HomeComposerSheet
        busy={creating}
        editable={staleGate.allowProductMutations && placementTransport !== undefined}
        error={composerError}
        mode={composerMode}
        modelLabel={modelLabel}
        onChangePrompt={(value) => {
          setPrompt(value);
          setCodeRetry(undefined);
        }}
        onClose={() => setComposerSheetOpen(false)}
        onPressModel={() => setModelOpen(true)}
        onSelectMode={(mode) => {
          setComposerMode(mode);
          setComposerError(undefined);
          setCodeRetry(undefined);
        }}
        onSubmit={() => void createThread(composerMode)}
        placementLabel={placementLabel}
        projectLabel={composerProjectLabel}
        prompt={prompt}
        visible={composerSheetOpen}
      />
      <HomeNavigationSheet
        activeView={props.homeMode}
        onClose={() => setNavigationOpen(false)}
        onOpenHosts={props.onOpenHosts}
        onSelectView={(view) => {
          setComposerError(undefined);
          setCodeRetry(undefined);
          props.onSelectHomeMode(view);
        }}
        visible={navigationOpen}
      />
      <ModelPickerSheet
        onClose={() => setModelOpen(false)}
        onSelect={(id) => {
          setModelOptionId(id);
          setModelOpen(false);
          setCodeRetry(undefined);
        }}
        options={models.options.map((option) => ({
          id: option.id,
          label: option.label,
          detail: option.detail,
        }))}
        selectedId={modelOptionId}
        visible={modelOpen}
      />
      <CodeDeliveryTargetSheet
        onClose={() => finishDeliveryTarget(undefined)}
        onConfirm={finishDeliveryTarget}
        proposal={deliveryTargetProposal}
      />
    </View>
  );
}
