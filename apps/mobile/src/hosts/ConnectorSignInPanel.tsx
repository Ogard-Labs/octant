import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Linking, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import {
  listMobileMcpConnections,
  mobileMcpServerSignIn,
  readRemoteSessionStanding,
  relayMobileMcpServerSignIn,
  type MobileRemoteTransport,
} from "@octant/client-runtime";
import type { McpServerConnection, McpServerSignInView } from "@octant/contracts/extension-rpc";
import { useTheme } from "../../design-system/theme";
import { space as mobileSpacing, typography as mobileTypography } from "../../design-system/tokens";

export interface ConnectorSignInPanelProps {
  readonly transport: MobileRemoteTransport | undefined;
  /** Override standing in tests; live callers read it from the host session. */
  readonly actsAsHostPerson?: boolean;
  /** Opens the external verification or authorization page in the phone's system browser. */
  readonly openExternalUrl?: (url: string) => Promise<unknown>;
  readonly pollIntervalMs?: number;
}

function connectorKey(server: Pick<McpServerConnection, "extensionId" | "componentId">): string {
  return `${String(server.extensionId)}:${String(server.componentId)}`;
}

/**
 * Hosted MCP connector sign-in for a person-paired phone. Uses device
 * authorization where the issuer advertises it, and otherwise relays the
 * one-time loopback callback URL over the signed device session.
 */
export function ConnectorSignInPanel(props: ConnectorSignInPanelProps) {
  const { colors } = useTheme();
  const [allowed, setAllowed] = useState(props.actsAsHostPerson === true);
  const [servers, setServers] = useState<ReadonlyArray<McpServerConnection>>([]);
  const [views, setViews] = useState<Readonly<Record<string, McpServerSignInView>>>({});
  const [busyKey, setBusyKey] = useState<string | undefined>();
  const [relayInputs, setRelayInputs] = useState<Readonly<Record<string, string>>>({});
  const [relayErrors, setRelayErrors] = useState<Readonly<Record<string, string>>>({});
  const [pollNonce, setPollNonce] = useState(0);
  const openUrl = props.openExternalUrl ?? ((url: string) => Linking.openURL(url));
  const pollTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const transport = props.transport;
    if (transport === undefined) {
      setAllowed(false);
      setServers([]);
      return;
    }
    let cancelled = false;
    const resolveStanding =
      props.actsAsHostPerson !== undefined
        ? Promise.resolve(props.actsAsHostPerson)
        : readRemoteSessionStanding(transport).then((standing) => standing.actsAsHostPerson);
    void resolveStanding.then(async (person) => {
      if (cancelled) return;
      setAllowed(person);
      if (!person) {
        setServers([]);
        return;
      }
      try {
        const listed = await listMobileMcpConnections({ transport });
        if (cancelled) return;
        const hosted = listed.servers.filter((server) => server.transport === "streamable-http");
        setServers(hosted);
        const statuses = await Promise.all(
          hosted.map(async (server) => {
            try {
              const view = await mobileMcpServerSignIn({
                transport,
                request: {
                  kind: "status",
                  extensionId: server.extensionId,
                  componentId: server.componentId,
                },
              });
              return [connectorKey(server), view] as const;
            } catch {
              return undefined;
            }
          }),
        );
        if (cancelled) return;
        const next: Record<string, McpServerSignInView> = {};
        for (const entry of statuses) {
          if (entry !== undefined && entry[1].kind !== "not-applicable") {
            next[entry[0]] = entry[1];
          }
        }
        setViews(next);
      } catch {
        if (!cancelled) setServers([]);
      }
    });
    return () => {
      cancelled = true;
      for (const timer of pollTimers.current.values()) clearTimeout(timer);
      pollTimers.current.clear();
    };
  }, [props.transport, props.actsAsHostPerson]);

  const sendSignIn = useCallback(
    async (
      server: McpServerConnection,
      kind: "begin" | "poll" | "sign-out" | "status",
      attemptId?: string,
      interactive = true,
    ) => {
      const transport = props.transport;
      if (transport === undefined) return;
      const key = connectorKey(server);
      if (interactive) {
        setBusyKey(key);
        setRelayErrors((current) => {
          const { [key]: _removed, ...rest } = current;
          return rest;
        });
      }
      try {
        const request =
          kind === "poll" && attemptId !== undefined
            ? {
                kind: "poll" as const,
                extensionId: server.extensionId,
                componentId: server.componentId,
                attemptId,
              }
            : {
                kind: kind === "poll" ? ("status" as const) : kind,
                extensionId: server.extensionId,
                componentId: server.componentId,
              };
        const next = await mobileMcpServerSignIn({ transport, request });
        if (!mounted.current) return;
        setViews((current) => ({ ...current, [key]: next }));
        if (next.kind !== "awaiting-consent") {
          setRelayInputs((current) => {
            const { [key]: _removed, ...rest } = current;
            return rest;
          });
        }
      } catch {
        if (!mounted.current) return;
        if (!interactive) {
          setPollNonce((count) => count + 1);
          return;
        }
        setViews((current) => {
          const existing = current[key];
          if (kind === "status" || kind === "poll") {
            return {
              ...current,
              [key]: {
                kind: "status-unavailable",
                message:
                  "Sign-in status is unavailable. Check sign-in or cancel this attempt when the host is available.",
              },
            };
          }
          if (
            kind === "sign-out" &&
            (existing?.kind === "signed-in" ||
              existing?.kind === "sign-in-again" ||
              existing?.kind === "sign-out-pending")
          ) {
            return {
              ...current,
              [key]: {
                kind: "sign-out-pending",
                message:
                  "Sign-out is not confirmed. Finish signing out when the host is available.",
              },
            };
          }
          if (
            kind === "sign-out" &&
            (existing?.kind === "awaiting-consent" ||
              existing?.kind === "awaiting-device-code" ||
              existing?.kind === "cancel-pending" ||
              existing?.kind === "status-unavailable")
          ) {
            return {
              ...current,
              [key]: {
                kind: "cancel-pending",
                message:
                  "Sign-in cancellation is not confirmed. Try Cancel sign-in again when the host is available.",
              },
            };
          }
          return {
            ...current,
            [key]: {
              kind: "refused",
              reason: "unavailable",
              message: "Sign-in is unavailable right now.",
            },
          };
        });
      } finally {
        if (interactive && mounted.current)
          setBusyKey((current) => (current === key ? undefined : current));
      }
    },
    [props.transport],
  );

  useEffect(() => {
    const interval = props.pollIntervalMs ?? 2_000;
    for (const timer of pollTimers.current.values()) clearTimeout(timer);
    pollTimers.current.clear();
    for (const server of servers) {
      const key = connectorKey(server);
      const view = views[key];
      if (view?.kind !== "awaiting-consent" && view?.kind !== "awaiting-device-code") continue;
      const attemptId = view.attemptId;
      const timer = setTimeout(() => {
        void sendSignIn(server, "poll", attemptId, false);
      }, interval);
      pollTimers.current.set(key, timer);
    }
    return () => {
      for (const timer of pollTimers.current.values()) clearTimeout(timer);
      pollTimers.current.clear();
    };
  }, [servers, views, pollNonce, sendSignIn, props.pollIntervalMs]);

  const submitRelay = useCallback(
    async (server: McpServerConnection, attemptId: string) => {
      const transport = props.transport;
      const key = connectorKey(server);
      const callbackUrl = (relayInputs[key] ?? "").trim();
      if (transport === undefined || callbackUrl.length === 0) return;
      setBusyKey(key);
      setRelayInputs((current) => {
        const { [key]: _removed, ...rest } = current;
        return rest;
      });
      setRelayErrors((current) => {
        const { [key]: _removed, ...rest } = current;
        return rest;
      });
      try {
        const result = await relayMobileMcpServerSignIn({
          transport,
          request: { attemptId, callbackUrl },
        });
        if (!mounted.current) return;
        if (result.kind === "retry") {
          setRelayErrors((current) => ({ ...current, [key]: result.message }));
          setPollNonce((count) => count + 1);
          return;
        }
        setViews((current) => ({ ...current, [key]: result }));
      } catch {
        if (!mounted.current) return;
        setRelayErrors((current) => ({
          ...current,
          [key]: "Could not send that callback address. Try again or cancel sign-in.",
        }));
        setPollNonce((count) => count + 1);
      } finally {
        if (mounted.current) setBusyKey((current) => (current === key ? undefined : current));
      }
    },
    [props.transport, relayInputs],
  );

  const styles = useMemo(
    () =>
      StyleSheet.create({
        panel: {
          marginTop: mobileSpacing.md,
          gap: mobileSpacing.sm,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: colors.border,
          paddingTop: mobileSpacing.md,
        },
        title: {
          ...mobileTypography.title,
          color: colors.textPrimary,
        },
        card: {
          gap: mobileSpacing.xs,
          padding: mobileSpacing.sm,
          borderRadius: 10,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.border,
          backgroundColor: colors.surface,
        },
        serverName: {
          ...mobileTypography.section,
          color: colors.textPrimary,
        },
        detail: {
          ...mobileTypography.detail,
          color: colors.textSecondary,
        },
        code: {
          ...mobileTypography.title,
          color: colors.textPrimary,
          letterSpacing: 1.5,
        },
        errorText: {
          ...mobileTypography.detail,
          color: colors.danger,
        },
        input: {
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.border,
          borderRadius: 8,
          paddingHorizontal: mobileSpacing.sm,
          paddingVertical: mobileSpacing.xs,
          color: colors.textPrimary,
          backgroundColor: colors.canvas,
        },
        actions: {
          flexDirection: "row",
          flexWrap: "wrap",
          gap: mobileSpacing.xs,
          marginTop: mobileSpacing.xs,
        },
        primaryButton: {
          backgroundColor: colors.accent,
          paddingHorizontal: mobileSpacing.md,
          paddingVertical: mobileSpacing.xs,
          borderRadius: 8,
          minHeight: 36,
          justifyContent: "center",
        },
        primaryButtonText: {
          ...mobileTypography.detail,
          color: colors.sendLabel,
          fontWeight: "600",
        },
        secondaryButton: {
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.border,
          paddingHorizontal: mobileSpacing.md,
          paddingVertical: mobileSpacing.xs,
          borderRadius: 8,
          minHeight: 36,
          justifyContent: "center",
        },
        secondaryButtonText: {
          ...mobileTypography.detail,
          color: colors.textPrimary,
        },
      }),
    [colors],
  );

  const visibleServers = servers.filter((server) => views[connectorKey(server)] !== undefined);
  if (!allowed || visibleServers.length === 0) return null;

  return (
    <View style={styles.panel} testID="mobile-connector-sign-in-panel">
      <Text style={styles.title}>Connector sign-ins</Text>
      {visibleServers.map((server) => {
        const key = connectorKey(server);
        const view = views[key];
        if (view === undefined) return null;
        const busy = busyKey === key;
        const relayValue = relayInputs[key] ?? "";
        const relayError = relayErrors[key];
        return (
          <View key={key} style={styles.card} testID={`mobile-connector-${server.componentId}`}>
            <Text style={styles.serverName}>{server.serverName}</Text>
            {view.kind === "signed-in" ? (
              <>
                <Text style={styles.detail}>Signed in through {view.issuer}</Text>
                <View style={styles.actions}>
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={() => void sendSignIn(server, "sign-out")}
                    style={styles.secondaryButton}
                  >
                    <Text style={styles.secondaryButtonText}>Sign out</Text>
                  </Pressable>
                </View>
              </>
            ) : view.kind === "awaiting-device-code" ? (
              <>
                <Text style={styles.detail}>
                  Confirm this code at {view.issuerHost} ({view.verificationUri}):
                </Text>
                <Text selectable style={styles.code} testID="mobile-connector-user-code">
                  {view.userCode}
                </Text>
                <View style={styles.actions}>
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={() =>
                      void openUrl(view.verificationUriComplete ?? view.verificationUri)
                    }
                    style={styles.primaryButton}
                    testID="mobile-connector-open-verify"
                  >
                    <Text style={styles.primaryButtonText}>Open verification page</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={() => void sendSignIn(server, "sign-out")}
                    style={styles.secondaryButton}
                  >
                    <Text style={styles.secondaryButtonText}>Cancel sign-in</Text>
                  </Pressable>
                </View>
              </>
            ) : view.kind === "awaiting-consent" ? (
              <>
                <Text style={styles.detail}>
                  {view.relayable === true
                    ? "Open the sign-in page, then copy the localhost callback address your browser lands on and paste it here."
                    : "Finish signing in in your browser."}
                </Text>
                <View style={styles.actions}>
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={() => void openUrl(view.authorizationUrl)}
                    style={styles.primaryButton}
                    testID="mobile-connector-open-auth"
                  >
                    <Text style={styles.primaryButtonText}>Open sign-in page</Text>
                  </Pressable>
                </View>
                {view.relayable === true ? (
                  <>
                    <TextInput
                      accessibilityLabel="Callback address"
                      autoCapitalize="none"
                      autoCorrect={false}
                      editable={!busy}
                      onChangeText={(value) =>
                        setRelayInputs((current) => ({ ...current, [key]: value }))
                      }
                      placeholder="http://127.0.0.1:.../oauth/callback?code=..."
                      placeholderTextColor={colors.textSecondary}
                      style={styles.input}
                      testID="mobile-connector-relay-input"
                      value={relayValue}
                    />
                    {relayError === undefined ? null : (
                      <Text style={styles.errorText} testID="mobile-connector-relay-error">
                        {relayError}
                      </Text>
                    )}
                    <View style={styles.actions}>
                      <Pressable
                        accessibilityRole="button"
                        disabled={busy || relayValue.trim().length === 0}
                        onPress={() => void submitRelay(server, view.attemptId)}
                        style={styles.primaryButton}
                        testID="mobile-connector-relay-submit"
                      >
                        <Text style={styles.primaryButtonText}>Finish sign-in</Text>
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        disabled={busy}
                        onPress={() => void sendSignIn(server, "sign-out")}
                        style={styles.secondaryButton}
                      >
                        <Text style={styles.secondaryButtonText}>Cancel sign-in</Text>
                      </Pressable>
                    </View>
                  </>
                ) : (
                  <View style={styles.actions}>
                    <Pressable
                      accessibilityRole="button"
                      disabled={busy}
                      onPress={() => void sendSignIn(server, "sign-out")}
                      style={styles.secondaryButton}
                    >
                      <Text style={styles.secondaryButtonText}>Cancel sign-in</Text>
                    </Pressable>
                  </View>
                )}
              </>
            ) : view.kind === "client-setup-required" ? (
              <Text style={styles.detail}>{view.message}</Text>
            ) : view.kind === "status-unavailable" ? (
              <>
                <Text style={styles.detail}>{view.message}</Text>
                <View style={styles.actions}>
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={() => void sendSignIn(server, "status")}
                    style={styles.primaryButton}
                    testID="mobile-connector-check-status"
                  >
                    <Text style={styles.primaryButtonText}>Check sign-in</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={() => void sendSignIn(server, "sign-out")}
                    style={styles.secondaryButton}
                    testID="mobile-connector-cancel"
                  >
                    <Text style={styles.secondaryButtonText}>Cancel sign-in</Text>
                  </Pressable>
                </View>
              </>
            ) : view.kind === "cancel-pending" || view.kind === "sign-out-pending" ? (
              <>
                <Text style={styles.detail}>{view.message}</Text>
                <View style={styles.actions}>
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={() => void sendSignIn(server, "sign-out")}
                    style={styles.secondaryButton}
                  >
                    <Text style={styles.secondaryButtonText}>
                      {view.kind === "cancel-pending" ? "Cancel sign-in" : "Finish signing out"}
                    </Text>
                  </Pressable>
                </View>
              </>
            ) : view.kind === "refused" && view.reason === "no-sign-in-offered" ? (
              <Text style={styles.detail}>{view.message}</Text>
            ) : (
              <>
                <Text style={styles.detail}>
                  {view.kind === "refused"
                    ? view.message
                    : view.kind === "sign-in-again"
                      ? "Sign in again to reconnect."
                      : "Not signed in"}
                </Text>
                <View style={styles.actions}>
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={() => void sendSignIn(server, "begin")}
                    style={styles.primaryButton}
                    testID={`mobile-connector-sign-in-${server.componentId}`}
                  >
                    <Text style={styles.primaryButtonText}>
                      {view.kind === "sign-in-again" ? "Sign in again" : "Sign in"}
                    </Text>
                  </Pressable>
                </View>
              </>
            )}
          </View>
        );
      })}
    </View>
  );
}
