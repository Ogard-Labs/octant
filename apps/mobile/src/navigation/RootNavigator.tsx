import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { MobileInboxRow } from "@octant/client-runtime";
import { DeviceRevokePanel } from "../approvals/DeviceRevokePanel";
import { MOBILE_COPY, MOBILE_TAB_LABELS, type MobileRouteId } from "../copy";
import { AgentsListScreen, type AgentListView } from "../inbox/AgentsListScreen";
import { InboxHomeScreen } from "../inbox/InboxHomeScreen";
import { backMobileHomeView, type MobileHomeView } from "../inbox/homeView";
import { ThreadScreen } from "../inbox/ThreadScreen";
import { PairingPanel } from "../hosts/PairingPanel";
import { createUnavailableNotificationPermissionPort } from "../notifications/notificationPermissionPort";
import { PushNotificationsPanel } from "../notifications/PushNotificationsPanel";
import { createUnavailableDeviceIntegrityPort } from "../security/deviceIntegrityPort";
import { createExpoBiometricAuthenticator } from "../security/expoBiometricAuthenticator";
import { PrivacySecurityPanel } from "../security/PrivacySecurityPanel";
import { AppearanceBackgroundPanel } from "../appearance/AppearanceBackgroundPanel";
import { createUnavailableScreenshotPrivacyPort } from "../security/screenshotPrivacyPort";
import { useMobileSession } from "../session/MobileSessionContext";
import { mobileRadii, mobileSpacing, mobileTypography } from "../theme/tokens";
import { useTheme } from "../../design-system";
import { IconButton } from "../ui/IconButton";
import { useMobileHardwareBack } from "./useMobileHardwareBack";
import { mobileThreadReturnRouteForDeepLink } from "./navigationState";

export interface RootNavigatorProps {
  readonly activeRoute: MobileRouteId;
  readonly onSelectRoute: (route: MobileRouteId) => void;
  readonly pendingDeepLinkRow?: MobileInboxRow | undefined;
  readonly onDeepLinkConsumed?: (() => void) | undefined;
}

function HostsBody(props: {
  readonly entryMode: "manage" | "add";
  readonly onBack: () => void;
  readonly onPaired: () => void;
}) {
  const { colors } = useTheme();
  const {
    environment,
    hosts,
    health,
    registry,
    refreshHosts,
    resumeHost,
    bridge,
    deviceKeyStore,
    hub,
    transportForHost,
    placementHostId,
    setPlacementHostId,
  } = useMobileSession();
  const authenticator = useMemo(() => createExpoBiometricAuthenticator(), []);
  const notificationPermission = useMemo(() => createUnavailableNotificationPermissionPort(), []);
  const deviceIntegrity = useMemo(() => createUnavailableDeviceIntegrityPort(), []);
  const screenshotPrivacy = useMemo(() => createUnavailableScreenshotPrivacyPort(), []);
  const healthByHostId = useMemo(
    () => new Map(health.map((entry) => [entry.hostId, entry])),
    [health],
  );

  const styles = useMemo(
    () =>
      StyleSheet.create({
        hostsShell: { flex: 1 },
        hostsTop: {
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: mobileSpacing.md,
          paddingTop: mobileSpacing.sm,
          paddingBottom: mobileSpacing.sm,
        },
        hostsTitle: {
          flex: 1,
          textAlign: "center",
          color: colors.textPrimary,
          fontSize: mobileTypography.title.fontSize,
          fontWeight: mobileTypography.title.fontWeight,
        },
        hostsSpacer: { width: 36 },
        body: {
          gap: mobileSpacing.md,
          paddingHorizontal: mobileSpacing.md,
          paddingBottom: mobileSpacing.xl,
        },
        sectionBody: {
          color: colors.textSecondary,
          fontSize: mobileTypography.body.fontSize,
          lineHeight: 22,
        },
        mockNotice: {
          gap: mobileSpacing.xs,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.accent,
          borderRadius: mobileRadii.md,
          backgroundColor: colors.surface,
          padding: mobileSpacing.md,
        },
        mockTitle: {
          color: colors.textPrimary,
          fontSize: mobileTypography.title.fontSize,
          fontWeight: "700",
        },
        hostRow: {
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.border,
          paddingVertical: mobileSpacing.sm,
        },
        hostLabel: {
          color: colors.textPrimary,
          fontWeight: "600",
        },
        hostOrigin: {
          color: colors.textSecondary,
          fontSize: mobileTypography.caption.fontSize,
        },
        hostHealth: {
          color: colors.accent,
          fontSize: mobileTypography.caption.fontSize,
          marginTop: mobileSpacing.xs,
        },
        placementChip: {
          marginTop: mobileSpacing.sm,
          alignSelf: "flex-start",
          backgroundColor: colors.surface,
          borderRadius: mobileRadii.pill,
          paddingHorizontal: mobileSpacing.sm,
          paddingVertical: mobileSpacing.xs,
        },
        placementChipActive: {
          backgroundColor: colors.surfaceElevated,
        },
        chipLabel: {
          color: colors.textPrimary,
          fontSize: mobileTypography.caption.fontSize,
        },
      }),
    [colors],
  );

  return (
    <View style={styles.hostsShell}>
      <View style={styles.hostsTop}>
        <IconButton
          accessibilityLabel="Back"
          name="chevron-back"
          onPress={props.onBack}
          testID="mobile-hosts-back"
          variant="ghost"
        />
        <Text style={styles.hostsTitle}>
          {props.entryMode === "add" ? "Add Workspace" : MOBILE_TAB_LABELS.hosts}
        </Text>
        <View style={styles.hostsSpacer} />
      </View>
      <ScrollView contentContainerStyle={styles.body}>
        {props.entryMode === "add" ? (
          environment.kind === "mock" ? (
            <View style={styles.mockNotice} testID="mobile-hosts-mock-notice">
              <Text style={styles.mockTitle}>Pair a workspace</Text>
              <Text selectable style={styles.sectionBody}>
                Workspace pairing is disabled in mock mode. Switch to the live app to pair a host.
              </Text>
            </View>
          ) : (
            <PairingPanel
              registry={registry}
              deviceKeyStore={deviceKeyStore}
              bridge={bridge}
              onPaired={() => {
                void refreshHosts();
                props.onPaired();
              }}
            />
          )
        ) : (
          <>
            {environment.kind === "mock" ? (
              <View style={styles.mockNotice} testID="mobile-hosts-mock-notice">
                <Text style={styles.mockTitle}>Mock workspace</Text>
                <Text selectable style={styles.sectionBody}>
                  {environment.label}. Hosts, credentials, and actions stay in memory and never
                  connect to a real listener.
                </Text>
              </View>
            ) : null}
            {hosts.length === 0 ? (
              <Text style={styles.sectionBody}>{MOBILE_COPY.hostsEmpty}</Text>
            ) : (
              hosts.map((host) => {
                const status = healthByHostId.get(host.hostId);
                return (
                  <View key={host.hostId} style={styles.hostRow}>
                    <Pressable
                      accessibilityRole="button"
                      disabled={environment.kind === "mock"}
                      onPress={() => resumeHost(host.origin)}
                      testID={`mobile-host-${host.hostId}`}
                    >
                      <Text style={styles.hostLabel}>{host.label}</Text>
                      <Text style={styles.hostOrigin}>{host.origin}</Text>
                      <Text style={styles.hostHealth} testID={`mobile-host-health-${host.hostId}`}>
                        {status?.kind ?? "idle"}
                        {status?.detail !== undefined ? ` · ${status.detail}` : ""}
                      </Text>
                    </Pressable>
                    <Pressable
                      onPress={() => setPlacementHostId(host.hostId)}
                      style={[
                        styles.placementChip,
                        placementHostId === host.hostId ? styles.placementChipActive : null,
                      ]}
                      testID={`mobile-placement-${host.hostId}`}
                    >
                      <Text style={styles.chipLabel}>
                        {placementHostId === host.hostId ? "Placement host" : "Use for new threads"}
                      </Text>
                    </Pressable>
                    {environment.kind === "live" && status?.kind === "ready" ? (
                      <>
                        <PushNotificationsPanel
                          permission={notificationPermission}
                          transport={transportForHost(host.hostId)}
                        />
                        <DeviceRevokePanel
                          authenticator={authenticator}
                          bridge={hub.bridgeForOrigin(host.origin) ?? bridge}
                          transport={transportForHost(host.hostId)}
                          onRevoked={() => {
                            void registry.remove(host.hostId).then(() => refreshHosts());
                          }}
                        />
                      </>
                    ) : null}
                    {environment.kind === "live" && status?.kind === "stale" ? (
                      <DeviceRevokePanel
                        authenticator={authenticator}
                        bridge={hub.bridgeForOrigin(host.origin) ?? bridge}
                        transport={transportForHost(host.hostId)}
                        onRevoked={() => {
                          void registry.remove(host.hostId).then(() => refreshHosts());
                        }}
                      />
                    ) : null}
                  </View>
                );
              })
            )}
            <Text style={styles.sectionBody}>{MOBILE_COPY.placementHint}</Text>
            <AppearanceBackgroundPanel />
            <PrivacySecurityPanel
              hostHealth={
                placementHostId !== undefined
                  ? (healthByHostId.get(placementHostId)?.kind ?? "idle")
                  : hosts[0] !== undefined
                    ? (healthByHostId.get(hosts[0].hostId)?.kind ?? "idle")
                    : "idle"
              }
              integrity={deviceIntegrity}
              screenshotPrivacy={screenshotPrivacy}
            />
          </>
        )}
      </ScrollView>
    </View>
  );
}

const shellStyles = StyleSheet.create({
  shell: {
    flex: 1,
    backgroundColor: "transparent",
  },
});

export function RootNavigator(props: RootNavigatorProps) {
  const [selectedThread, setSelectedThread] = useState<MobileInboxRow | undefined>();
  const [threadReturnRoute, setThreadReturnRoute] = useState<"home" | "agents">("home");
  const [homeMode, setHomeMode] = useState<MobileHomeView>("inbox");
  const [hostEntryMode, setHostEntryMode] = useState<"manage" | "add">("manage");
  const [agentListView, setAgentListView] = useState<AgentListView>("all");
  const { setInboxHostFilter } = useMobileSession();
  const onHomeBack = useCallback(() => {
    const previous = backMobileHomeView(homeMode);
    if (previous === undefined) return false;
    setHomeMode(previous);
    return true;
  }, [homeMode]);
  useMobileHardwareBack(props.activeRoute, props.onSelectRoute, onHomeBack, threadReturnRoute);

  useEffect(() => {
    if (props.pendingDeepLinkRow === undefined) return;
    setThreadReturnRoute(mobileThreadReturnRouteForDeepLink(props.activeRoute));
    setSelectedThread(props.pendingDeepLinkRow);
    setInboxHostFilter(props.pendingDeepLinkRow.hostId);
    props.onSelectRoute("thread");
    props.onDeepLinkConsumed?.();
  }, [
    props.activeRoute,
    props.pendingDeepLinkRow,
    props.onDeepLinkConsumed,
    props.onSelectRoute,
    setInboxHostFilter,
  ]);

  return (
    <View style={shellStyles.shell} testID="octant-mobile-shell">
      {props.activeRoute === "home" ? (
        <InboxHomeScreen
          homeMode={homeMode}
          onSelectHomeMode={setHomeMode}
          onOpenAgents={(view) => {
            setAgentListView(view);
            props.onSelectRoute("agents");
          }}
          onAddWorkspace={() => {
            setHostEntryMode("add");
            props.onSelectRoute("hosts");
          }}
          onOpenHosts={() => {
            setHostEntryMode("manage");
            props.onSelectRoute("hosts");
          }}
          onOpenWorkspace={(hostId) => {
            setInboxHostFilter(hostId);
            setAgentListView("all");
            props.onSelectRoute("agents");
          }}
          onOpenThread={(row) => {
            setSelectedThread(row);
            setThreadReturnRoute("home");
            props.onSelectRoute("thread");
          }}
        />
      ) : null}
      {props.activeRoute === "agents" ? (
        <AgentsListScreen
          onBack={() => props.onSelectRoute("home")}
          onOpenThread={(row) => {
            setSelectedThread(row);
            setThreadReturnRoute("agents");
            props.onSelectRoute("thread");
          }}
          view={agentListView}
        />
      ) : null}
      {props.activeRoute === "thread" ? (
        <ThreadScreen
          onBack={() => props.onSelectRoute(threadReturnRoute)}
          selected={selectedThread}
        />
      ) : null}
      {props.activeRoute === "hosts" ? (
        <HostsBody
          entryMode={hostEntryMode}
          onBack={() => props.onSelectRoute("home")}
          onPaired={() => props.onSelectRoute("home")}
        />
      ) : null}
    </View>
  );
}
