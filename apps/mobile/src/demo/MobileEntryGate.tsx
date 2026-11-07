import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text } from "react-native";
import { GlassSurface, space, typography, useTheme } from "../../design-system";
import { createMobileHostRegistry, type MobileHostRegistryRead } from "../hosts/HostRegistry";
import { createExpoSecureStringStorage } from "../hosts/expoSecureStorage";

const readHosts = () =>
  createMobileHostRegistry(createExpoSecureStringStorage({ persistWeb: true })).list();

/** No session, device-key store or deep-link consumer mounts before this choice. */
export function MobileEntryGate(props: {
  readonly live: ReactNode;
  readonly demo: (leave: () => void) => ReactNode;
  readonly readHosts?: () => Promise<MobileHostRegistryRead>;
}) {
  const { colors } = useTheme();
  const [entry, setEntry] = useState<"checking" | "welcome" | "live" | "demo">("checking");
  useEffect(() => {
    let current = true;
    void Promise.resolve()
      .then(props.readHosts ?? readHosts)
      .then(
        (result) => {
          if (current)
            setEntry(result.kind === "ok" && result.hosts.length > 0 ? "live" : "welcome");
        },
        () => {
          if (current) setEntry("welcome");
        },
      );
    return () => {
      current = false;
    };
  }, [props.readHosts]);
  const styles = useMemo(
    () =>
      StyleSheet.create({
        shell: {
          flexGrow: 1,
          justifyContent: "center",
          alignItems: "center",
          padding: space.lg,
          backgroundColor: colors.canvas,
        },
        card: { width: "100%", maxWidth: 420, padding: space.lg, gap: space.md },
        title: { color: colors.textPrimary, fontSize: 30, fontWeight: "500", letterSpacing: -0.7 },
        body: { color: colors.textSecondary, fontSize: typography.body.fontSize, lineHeight: 22 },
        button: {
          minHeight: 48,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 24,
          paddingHorizontal: space.lg,
          backgroundColor: colors.accent,
        },
        secondary: {
          backgroundColor: colors.surfaceElevated,
          borderColor: colors.hairlineStrong,
          borderWidth: StyleSheet.hairlineWidth,
        },
        label: { color: colors.sendLabel, fontSize: typography.body.fontSize, fontWeight: "500" },
        secondaryLabel: { color: colors.textPrimary },
      }),
    [colors],
  );
  if (entry === "live") return props.live;
  if (entry === "demo") return props.demo(() => setEntry("welcome"));
  return (
    <ScrollView contentContainerStyle={styles.shell} testID="mobile-entry">
      {entry === "checking" ? (
        <ActivityIndicator color={colors.accent} accessibilityLabel="Checking paired computers" />
      ) : (
        <GlassSurface contentStyle={styles.card} material="regular">
          <Text style={styles.title}>Your workspace, on your phone</Text>
          <Text style={styles.body}>
            Connect to Octant on your own computer, or explore a sample workspace first. No Octant
            account is needed.
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => setEntry("live")}
            style={styles.button}
            testID="mobile-entry-connect"
          >
            <Text style={styles.label}>Connect a computer</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => setEntry("demo")}
            style={[styles.button, styles.secondary]}
            testID="mobile-entry-demo"
          >
            <Text style={[styles.label, styles.secondaryLabel]}>Explore offline demo</Text>
          </Pressable>
          <Text style={styles.body}>
            The demo uses sample data. It never connects to a computer or changes your accounts.
          </Text>
        </GlassSurface>
      )}
    </ScrollView>
  );
}
