import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import type { MobileInboxRow } from "@octant/client-runtime";
import { DeviceRevokePanel } from "../approvals/DeviceRevokePanel";
import { LargeTitle, ListRow, ListSection, NavBar } from "../ui/NativeChrome";
import { TabBar, type MobileTabId } from "../ui/TabBar";
import { MOBILE_COPY, MOBILE_TAB_LABELS, mobileHostHealthLabel, type MobileRouteId } from "../copy";
import { AgentsListScreen, type AgentListView } from "../inbox/AgentsListScreen";
import { InboxHomeScreen } from "../inbox/InboxHomeScreen";
import { backMobileHomeView, type MobileHomeView } from "../inbox/homeView";
import { ThreadScreen } from "../inbox/ThreadScreen";
import { hostHealthTone } from "../hosts/hostHealthTone";
import { GuestHubPanel, GuestHubRefusals } from "../hosts/GuestHubPanel";
import { createExpoPhoneUnlockKey } from "../hosts/expoOwnerUnlockPorts";
import { OwnerAlertsPanel } from "../hosts/OwnerAlertsPanel";
import { OwnerMovesPanel } from "../hosts/OwnerMovesPanel";
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
import { mobileSpacing, mobileTypography } from "../theme/tokens";
import { useTheme } from "../../design-system";
import { useMobileHardwareBack } from "./useMobileHardwareBack";
import { mobileThreadReturnRouteForDeepLink } from "./navigationState";
import { deepLinkRefusal, movesLinkOpening } from "./deepLinkNavigation";
import type { MobileMovesDeepLinkTarget } from "../notifications/deepLinks";

export interface RootNavigatorProps {
  readonly activeRoute: MobileRouteId;
  readonly onSelectRoute: (route: MobileRouteId) => void;
  readonly pendingDeepLinkRow?: MobileInboxRow | undefined;
  /** A tapped notification that a move waits for this phone. */
  readonly pendingMovesLink?: MobileMovesDeepLinkTarget | undefined;
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
  const offlineDemo = environment.kind === "mock" && environment.offlineDemo;
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
        body: {
          paddingTop: mobileSpacing.sm,
          paddingBottom: mobileSpacing.xl,
        },
        sectionBody: {
          color: colors.textSecondary,
          fontSize: mobileTypography.detail.fontSize,
          lineHeight: 18,
          paddingHorizontal: mobileSpacing.md + mobileSpacing.md,
          marginBottom: mobileSpacing.md,
        },
        gutter: { gap: mobileSpacing.md, paddingHorizontal: mobileSpacing.md },
        hostPanels: { gap: mobileSpacing.sm, paddingHorizontal: mobileSpacing.md },
        hostPanelsTitle: {
          color: colors.textSecondary,
          fontSize: mobileTypography.section.fontSize,
          fontWeight: mobileTypography.section.fontWeight,
        },
      }),
    [colors],
  );

  return (
    <View style={styles.hostsShell}>
      {props.entryMode === "manage" ? (
        <LargeTitle title={MOBILE_TAB_LABELS.hosts} />
      ) : (
        <NavBar
          backLabel={MOBILE_TAB_LABELS.home}
          backTestID="mobile-hosts-back"
          onBack={props.onBack}
          title="Add computer"
        />
      )}
      <ScrollView contentContainerStyle={styles.body}>
        {props.entryMode !== "manage" ? (
          environment.kind === "mock" ? (
            <ListSection
              footer="Pairing is off in this sample workspace. Leave it to connect a computer."
              testID="mobile-hosts-mock-notice"
            >
              <ListRow
                icon="qr-code-outline"
                iconTone={colors.paletteBlue}
                label="Pair a computer"
                last
              />
            </ListSection>
          ) : (
            <View style={styles.gutter}>
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
            </View>
          )
        ) : (
          <>
            {environment.kind === "mock" ? (
              <ListSection
                footer="Hosts, credentials, and actions stay in memory and never connect to a real listener."
                testID="mobile-hosts-mock-notice"
              >
                <ListRow
                  detail={environment.label}
                  icon="flask-outline"
                  iconTone={colors.paletteTeal}
                  label="Sample workspace"
                  last
                />
              </ListSection>
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
            {/* These panels draw their own layout; the gutter keeps them off the
                screen edge now that the page itself has none for grouped lists. */}
            <View style={styles.gutter}>
              <GuestHubRefusals refused={notAccepted} />
              {offlineDemo || unlockKey === undefined ? null : (
                <OwnerMovesPanel
                  deviceKeyStore={deviceKeyStore}
                  guestHubStore={guestHubStore}
                  unlockKey={unlockKey}
                />
              )}
              {offlineDemo || unlockKey === undefined ? null : (
                <OwnerAlertsPanel
                  deviceKeyStore={deviceKeyStore}
                  guestHubStore={guestHubStore}
                  unlockKey={unlockKey}
                />
              )}
            </View>
            {hosts.length === 0 ? (
              <Text style={styles.sectionBody}>{MOBILE_COPY.hostsEmpty}</Text>
            ) : (
              <>
                <ListSection title={MOBILE_COPY.workspaces}>
                  {hosts.map((host, index) => {
                    const status = healthByHostId.get(host.hostId);
                    const tone = hostHealthTone(status?.kind ?? "idle");
                    return (
                      <ListRow
                        detail={`${mobileHostHealthLabel(status?.kind ?? "idle")}${
                          status?.detail !== undefined ? ` · ${status.detail}` : ""
                        }`}
                        detailTone={tone === "neutral" ? undefined : healthTint[tone]}
                        icon="desktop-outline"
                        iconTone={tone === "neutral" ? colors.paletteBlue : healthTint[tone]}
                        key={host.hostId}
                        label={host.label}
                        last={index === hosts.length - 1}
                        onPress={
                          environment.kind === "mock" ? undefined : () => resumeHost(host.origin)
                        }
                        testID={`mobile-host-${host.hostId}`}
                      />
                    );
                  })}
                </ListSection>
                <ListSection
                  footer={MOBILE_COPY.placementHint}
                  title={MOBILE_COPY.placementSection}
                >
                  {hosts.map((host, index) => (
                    <ListRow
                      accessory={placementHostId === host.hostId ? "check" : "none"}
                      accessibilityLabel={`${host.label}${
                        placementHostId === host.hostId ? `, ${MOBILE_COPY.placementHere}` : ""
                      }`}
                      key={host.hostId}
                      label={host.label}
                      last={index === hosts.length - 1}
                      onPress={() => setPlacementHostId(host.hostId)}
                      testID={`mobile-placement-${host.hostId}`}
                    />
                  ))}
                </ListSection>
                {environment.kind === "live"
                  ? hosts.map((host) => {
                      const status = healthByHostId.get(host.hostId);
                      return (
                        <View key={host.hostId} style={styles.hostPanels}>
                          <Text style={styles.hostPanelsTitle}>{host.label}</Text>
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
                  : null}
              </>
            )}
            {!offlineDemo ? (
              <>
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
            ) : null}
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
  const {
    environment,
    setInboxHostFilter,
    hosts,
    hostsLoaded,
    hostsError,
    transportForHost,
    transports,
  } = useMobileSession();
  usePhoneNotificationRotation({
    enabled: environment.kind === "live",
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

  useEffect(() => {
    if (props.pendingMovesLink === undefined) return;
    // As for a thread link, the paired list must be read before a computer
    // can be called unpaired.
    if (!hostsLoaded) return;
    const opening = movesLinkOpening(
      props.pendingMovesLink,
      hosts.map((host) => host.hostId),
      hostsError !== undefined,
    );
    setDeepLinkNotice(opening.notice);
    setHostEntryMode(opening.entryMode);
    props.onSelectRoute(opening.route);
    props.onDeepLinkConsumed?.();
  }, [
    props.pendingMovesLink,
    props.onDeepLinkConsumed,
    props.onSelectRoute,
    hosts,
    hostsLoaded,
    hostsError,
  ]);

  // The tab bar stands on each place's root screen and steps aside for a
  // pushed screen (a list, a thread, pairing), as the system's own apps do.
  const activeTab: MobileTabId | undefined =
    props.activeRoute === "home"
      ? homeMode
      : props.activeRoute === "hosts" && hostEntryMode === "manage"
        ? "settings"
        : undefined;

  return (
    <View style={shellStyles.shell} testID="octant-mobile-shell">
      {props.activeRoute === "home" ? (
        <InboxHomeScreen
          homeMode={homeMode}
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
          onOpenThread={setSelectedThread}
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
      {activeTab === undefined ? null : (
        <TabBar
          active={activeTab}
          onSelect={(tab) => {
            if (tab === "settings") {
              setHostEntryMode("manage");
              props.onSelectRoute("hosts");
              return;
            }
            setHomeMode(tab);
            props.onSelectRoute("home");
          }}
        />
      )}
    </View>
  );
}
