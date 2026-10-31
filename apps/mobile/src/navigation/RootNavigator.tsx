import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { MobileInboxRow } from "@octant/client-runtime";
import { DeviceRevokePanel } from "../approvals/DeviceRevokePanel";
import { MOBILE_COPY, MOBILE_TAB_LABELS, mobileHostHealthLabel, type MobileRouteId } from "../copy";
import { AgentsListScreen, type AgentListView } from "../inbox/AgentsListScreen";
import { InboxHomeScreen } from "../inbox/InboxHomeScreen";
import { backMobileHomeView, type MobileHomeView } from "../inbox/homeView";
import { ThreadScreen } from "../inbox/ThreadScreen";
import { hostHealthTone } from "../hosts/hostHealthTone";
import { GuestHubPanel, GuestHubRefusals } from "../hosts/GuestHubPanel";
import { createExpoPhoneUnlockKey } from "../hosts/expoOwnerUnlockPorts";
import { OwnerAlertsPanel } from "../hosts/OwnerAlertsPanel";
import type { GuestSpokeRefusal } from "../hosts/hubGuestFlow";
import { PairingPanel } from "../hosts/PairingPanel";
import { RemoveHostPanel } from "../hosts/RemoveHostPanel";
import { forgetPhoneNotificationsForHost } from "../notifications/enablePhoneNotifications";
import { mobileNotificationPort } from "../notifications/mobileNotificationPort";
import { mobilePushRegistrationBook } from "../notifications/mobilePushRegistrationBook";
import { PushNotificationsPanel } from "../notifications/PushNotificationsPanel";
import { usePhoneNotificationRotation } from "../notifications/usePhoneNotificationRotation";
import { createUnavailableDeviceIntegrityPort } from "../security/deviceIntegrityPort";
import { mobileKeyStorageProtection, mobileScreenshotPrivacy } from "../security/deviceProtection";
import { createExpoBiometricAuthenticator } from "../security/expoBiometricAuthenticator";
import { PrivacySecurityPanel } from "../security/PrivacySecurityPanel";
import { AppearanceBackgroundPanel } from "../appearance/AppearanceBackgroundPanel";
import { useMobileSession } from "../session/MobileSessionContext";
import { createMobileHostRemover } from "../session/mobileSessionLifecycle";
import { mobileRadii, mobileSpacing, mobileTypography } from "../theme/tokens";
import { useTheme } from "../../design-system";
import { IconButton } from "../ui/IconButton";
import { useMobileHardwareBack } from "./useMobileHardwareBack";
import { mobileThreadReturnRouteForDeepLink } from "./navigationState";
import { deepLinkRefusal } from "./deepLinkNavigation";

export interface RootNavigatorProps {
  readonly activeRoute: MobileRouteId;
  readonly onSelectRoute: (route: MobileRouteId) => void;
  readonly pendingDeepLinkRow?: MobileInboxRow | undefined;
  readonly onDeepLinkConsumed?: (() => void) | undefined;
}

function HostsBody(props: {
  readonly entryMode: "manage" | "add" | "scan";
  readonly onBack: () => void;
  readonly onPaired: () => void;
  /** Why a link the person followed was not opened, if it was not. */
  readonly notice?: string | undefined;
}) {
  const { colors } = useTheme();
  const {
    environment,
    hosts,
    hostsError,
    health,
    registry,
    refreshHosts,
    resumeHost,
    bridge,
    deviceKeyStore,
    hub,
    guestHubStore,
    transportForHost,
    placementHostId,
    setPlacementHostId,
  } = useMobileSession();
  const [notAccepted, setNotAccepted] = useState<ReadonlyArray<GuestSpokeRefusal>>([]);
  useEffect(() => {
    // The computers on a joined hub that refused this phone are listed beside the hosts.
    void guestHubStore
      .load()
      .then((state) => setNotAccepted(state?.notAccepted ?? []))
      .catch(() => undefined);
  }, [guestHubStore, hosts]);
  const [keyNotDeleted, setKeyNotDeleted] = useState(false);
  const [removeFailed, setRemoveFailed] = useState(false);
  const [notificationKeyKept, setNotificationKeyKept] = useState(false);
  const removeMobileHostInTurn = useMemo(
    () => createMobileHostRemover({ registry, hub, deviceKeyStore }),
    [deviceKeyStore, hub, registry],
  );
  const notificationPermission = mobileNotificationPort;
  const pushRegistrations = mobilePushRegistrationBook();
  const removeHost = useCallback(
    (hostId: string) => {
      setRemoveFailed(false);
      setNotificationKeyKept(false);
      // The computer is asked to drop its registration while the connection
      // still stands, then notifications already shown for it go, and so does
      // the key that opens them, whether or not the rest of the removal lands.
      void forgetPhoneNotificationsForHost({
        hostId,
        permission: notificationPermission,
        book: pushRegistrations,
        transport: transportForHost(hostId),
      })
        .then((forgotten) => {
          // The record of the key stays, so the next time the app opens it
          // deletes the key again; the person is told it is not gone yet.
          if (!forgotten.keyForgotten) setNotificationKeyKept(true);
        })
        .catch(() => undefined)
        .then(() => removeMobileHostInTurn(hostId))
        .then((result) => {
          if (!result.localCredentialRemoved) setKeyNotDeleted(true);
          return refreshHosts();
        })
        .catch(() => setRemoveFailed(true));
    },
    [
      notificationPermission,
      pushRegistrations,
      refreshHosts,
      removeMobileHostInTurn,
      transportForHost,
    ],
  );
  const authenticator = useMemo(() => createExpoBiometricAuthenticator(), []);
  const unlockKey = useMemo(() => createExpoPhoneUnlockKey(), []);
  const deviceIntegrity = useMemo(() => createUnavailableDeviceIntegrityPort(), []);
  const healthTint = {
    neutral: colors.textSecondary,
    warning: colors.warning,
    danger: colors.danger,
  } as const;
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
          lineHeight: 20,
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
          fontWeight: "500",
        },
        hostRow: {
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.border,
          paddingVertical: mobileSpacing.sm,
        },
        hostLabel: {
          color: colors.textPrimary,
          fontWeight: "500",
        },
        hostOrigin: {
          color: colors.textSecondary,
          fontSize: mobileTypography.caption.fontSize,
        },
        hostHealthRow: {
          flexDirection: "row",
          alignItems: "center",
          gap: mobileSpacing.xs,
          marginTop: mobileSpacing.xs,
        },
        hostHealthDot: { width: 8, height: 8, borderRadius: 4 },
        hostHealth: {
          fontSize: mobileTypography.caption.fontSize,
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
          {props.entryMode === "manage" ? MOBILE_TAB_LABELS.hosts : "Add computer"}
        </Text>
        <View style={styles.hostsSpacer} />
      </View>
      <ScrollView contentContainerStyle={styles.body}>
        {props.entryMode !== "manage" ? (
          environment.kind === "mock" ? (
            <View style={styles.mockNotice} testID="mobile-hosts-mock-notice">
              <Text style={styles.mockTitle}>Pair a computer</Text>
              <Text selectable style={styles.sectionBody}>
                Pairing is off in mock mode. Use the live app to pair a computer.
              </Text>
            </View>
          ) : (
            <>
              <PairingPanel
                registry={registry}
                deviceKeyStore={deviceKeyStore}
                bridge={bridge}
                openScanner={props.entryMode === "scan"}
                onPaired={() => {
                  void refreshHosts();
                  props.onPaired();
                }}
              />
              {props.entryMode === "add" ? (
                <GuestHubPanel
                  registry={registry}
                  deviceKeyStore={deviceKeyStore}
                  guestHubStore={guestHubStore}
                  removeHost={removeMobileHostInTurn}
                  {...(unlockKey === undefined ? {} : { unlockKey })}
                  onJoined={() => {
                    void refreshHosts();
                  }}
                />
              ) : null}
            </>
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
            {props.notice !== undefined ? (
              <Text style={styles.sectionBody}>{props.notice}</Text>
            ) : null}
            {hostsError !== undefined ? <Text style={styles.sectionBody}>{hostsError}</Text> : null}
            {removeFailed ? (
              <Text style={styles.sectionBody}>{"Couldn't remove that computer. Try again."}</Text>
            ) : null}
            {notificationKeyKept ? (
              <Text style={styles.sectionBody} testID="mobile-notification-key-kept">
                {
                  "This phone could not delete its notification key for that computer. Octant will try again the next time it opens."
                }
              </Text>
            ) : null}
            {keyNotDeleted ? (
              <Text style={styles.sectionBody} testID="mobile-host-key-not-deleted">
                {MOBILE_COPY.hostKeyNotDeleted}
              </Text>
            ) : null}
            <GuestHubRefusals refused={notAccepted} />
            {unlockKey === undefined ? null : (
              <OwnerAlertsPanel
                deviceKeyStore={deviceKeyStore}
                guestHubStore={guestHubStore}
                unlockKey={unlockKey}
              />
            )}
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
                      <View style={styles.hostHealthRow}>
                        <View
                          style={[
                            styles.hostHealthDot,
                            { backgroundColor: healthTint[hostHealthTone(status?.kind ?? "idle")] },
                          ]}
                        />
                        <Text
                          style={[
                            styles.hostHealth,
                            { color: healthTint[hostHealthTone(status?.kind ?? "idle")] },
                          ]}
                          testID={`mobile-host-health-${host.hostId}`}
                        >
                          {mobileHostHealthLabel(status?.kind ?? "idle")}
                          {status?.detail !== undefined ? ` · ${status.detail}` : ""}
                        </Text>
                      </View>
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
                        {placementHostId === host.hostId
                          ? MOBILE_COPY.placementHere
                          : MOBILE_COPY.placementMakeHere}
                      </Text>
                    </Pressable>
                    {environment.kind === "live" && status?.kind === "ready" ? (
                      <>
                        <PushNotificationsPanel
                          hostKeyFingerprint={host.hostKeyFingerprint}
                          permission={notificationPermission}
                          transport={transportForHost(host.hostId)}
                          book={pushRegistrations}
                          resolveDeviceId={() =>
                            deviceKeyStore
                              .findByOrigin(host.origin)
                              .then((found) =>
                                found?.hostId === host.hostId ? found.deviceId : undefined,
                              )
                          }
                        />
                        <DeviceRevokePanel
                          authenticator={authenticator}
                          bridge={hub.bridgeForOrigin(host.origin) ?? bridge}
                          transport={transportForHost(host.hostId)}
                          onRevoked={() => {
                            removeHost(host.hostId);
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
                          removeHost(host.hostId);
                        }}
                      />
                    ) : null}
                    {environment.kind === "live" ? (
                      <RemoveHostPanel
                        hostLabel={host.label}
                        onRemove={() => removeHost(host.hostId)}
                        testIdSuffix={host.hostId}
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
              keyStorage={mobileKeyStorageProtection}
              screenshotPrivacy={mobileScreenshotPrivacy}
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
  const [hostEntryMode, setHostEntryMode] = useState<"manage" | "add" | "scan">("manage");
  const [agentListView, setAgentListView] = useState<AgentListView>("all");
  const [deepLinkNotice, setDeepLinkNotice] = useState<string | undefined>();
  const { setInboxHostFilter, hosts, hostsLoaded, hostsError, transportForHost, transports } =
    useMobileSession();
  usePhoneNotificationRotation({
    book: mobilePushRegistrationBook(),
    permission: mobileNotificationPort,
    transportForHost,
    transports,
  });
  const onHomeBack = useCallback(() => {
    const previous = backMobileHomeView(homeMode);
    if (previous === undefined) return false;
    setHomeMode(previous);
    return true;
  }, [homeMode]);
  useMobileHardwareBack(props.activeRoute, props.onSelectRoute, onHomeBack, threadReturnRoute);

  useEffect(() => {
    if (props.pendingDeepLinkRow === undefined) return;
    // On a cold open the paired list is still being read; deciding now would
    // call every computer unpaired.
    if (!hostsLoaded) return;
    const refusal = deepLinkRefusal(
      props.pendingDeepLinkRow,
      hosts.map((host) => host.hostId),
      hostsError !== undefined,
    );
    if (refusal !== undefined) {
      setDeepLinkNotice(refusal);
      setHostEntryMode("manage");
      props.onSelectRoute("hosts");
      props.onDeepLinkConsumed?.();
      return;
    }
    setDeepLinkNotice(undefined);
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
    hosts,
    hostsLoaded,
    hostsError,
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
          onScanToPair={() => {
            setHostEntryMode("scan");
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
          notice={deepLinkNotice}
        />
      ) : null}
    </View>
  );
}
