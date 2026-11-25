import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { AppearanceBackgroundPanel } from "../appearance/AppearanceBackgroundPanel";
import { DeviceRevokePanel } from "../approvals/DeviceRevokePanel";
import { MOBILE_COPY, MOBILE_SCREEN_TITLES, mobileHostHealthLabel } from "../copy";
import { useTheme } from "../../design-system";
import { ScreenHeader } from "../navigation/ScreenHeader";
import { forgetPhoneNotificationsForHost } from "../notifications/enablePhoneNotifications";
import { mobileNotificationPort } from "../notifications/mobileNotificationPort";
import { mobilePushRegistrationBook } from "../notifications/mobilePushRegistrationBook";
import { PushNotificationsPanel } from "../notifications/PushNotificationsPanel";
import { createUnavailableDeviceIntegrityPort } from "../security/deviceIntegrityPort";
import { mobileKeyStorageProtection, mobileScreenshotPrivacy } from "../security/deviceProtection";
import { createExpoBiometricAuthenticator } from "../security/expoBiometricAuthenticator";
import { PrivacySecurityPanel } from "../security/PrivacySecurityPanel";
import { useMobileSession } from "../session/MobileSessionContext";
import { createMobileHostRemover } from "../session/mobileSessionLifecycle";
import { mobileSpacing, mobileTypography } from "../theme/tokens";
import { ListRow, ListSection } from "../ui/NativeChrome";
import { ConnectorSignInPanel } from "./ConnectorSignInPanel";
import { createExpoPhoneUnlockKey } from "./expoOwnerUnlockPorts";
import { GuestHubPanel, GuestHubRefusals } from "./GuestHubPanel";
import { hostHealthTone } from "./hostHealthTone";
import type { GuestSpokeRefusal } from "./hubGuestFlow";
import { NewDevicesPanel } from "./NewDevicesPanel";
import { OwnerAlertsPanel } from "./OwnerAlertsPanel";
import { OwnerMovesPanel } from "./OwnerMovesPanel";
import { PairingPanel } from "./PairingPanel";
import { RemoveHostPanel } from "./RemoveHostPanel";

/** Settings, and the Add computer screen pushed from it or from Home. */
export function HostsScreen(props: {
  readonly entryMode: "manage" | "add" | "scan";
  readonly onPaired: () => void;
  /** Why a link the person followed was not opened, if it was not. */
  readonly notice?: string | undefined;
  /** Counts the new-device links followed here, so the list reads again on each. */
  readonly newDevicesRefreshKey: number;
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
    transports,
    placementHostId,
    setPlacementHostId,
  } = useMobileSession();
  const offlineDemo = environment.kind === "mock" && environment.offlineDemo;
  const pairedHostIds = useMemo(() => hosts.map((host) => host.hostId), [hosts]);
  const computerName = useCallback(
    (hostId: string) => hosts.find((host) => host.hostId === hostId)?.label ?? "A paired computer",
    [hosts],
  );
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
      <ScreenHeader
        title={
          props.entryMode === "manage" ? MOBILE_SCREEN_TITLES.settings : MOBILE_COPY.addWorkspace
        }
      />
      <ScrollView contentContainerStyle={styles.body} contentInsetAdjustmentBehavior="automatic">
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
              {offlineDemo ? null : (
                <NewDevicesPanel
                  computerName={computerName}
                  hostIds={pairedHostIds}
                  refreshKey={props.newDevicesRefreshKey}
                  transports={transports}
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
                              <ConnectorSignInPanel transport={transportForHost(host.hostId)} />
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
