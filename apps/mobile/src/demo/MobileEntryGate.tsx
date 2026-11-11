import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { radii, space, typography, useTheme } from "../../design-system";
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
    let settled = false;
    const finish = (next: "welcome" | "live") => {
      if (!current || settled) return;
      settled = true;
      clearTimeout(deadline);
      setEntry(next);
    };
    // Secure-storage trouble must not block the public offline path. Once
    // offered, a late catalogue read cannot replace the person's demo choice.
    const deadline = setTimeout(() => finish("welcome"), 3000);
    void Promise.resolve()
      .then(props.readHosts ?? readHosts)
      .then(
        (result) => finish(result.kind === "ok" && result.hosts.length > 0 ? "live" : "welcome"),
        () => finish("welcome"),
      );
    return () => {
      current = false;
      clearTimeout(deadline);
    };
  }, [props.readHosts]);
  const styles = useMemo(
    () =>
      StyleSheet.create({
        // A native welcome: the words at the top, the two choices at the
        // bottom within thumb reach, and no card framing the whole screen.
        shell: {
          flexGrow: 1,
          justifyContent: "space-between",
          paddingHorizontal: space.lg,
          paddingTop: space.xxl * 2,
          paddingBottom: space.xl,
          backgroundColor: colors.canvas,
        },
        checking: { flexGrow: 1, justifyContent: "center", alignItems: "center" },
        intro: { gap: space.md, width: "100%", maxWidth: 420, alignSelf: "center" },
        actions: { gap: space.sm, width: "100%", maxWidth: 420, alignSelf: "center" },
        title: {
          color: colors.textPrimary,
          fontSize: 34,
          fontWeight: "700",
          letterSpacing: -0.9,
          lineHeight: 40,
        },
        body: { color: colors.textSecondary, fontSize: 17, lineHeight: 24 },
        button: {
          height: 50,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: radii.md,
          paddingHorizontal: space.lg,
          backgroundColor: colors.accent,
        },
        secondary: { backgroundColor: "transparent" },
        label: { color: colors.sendLabel, fontSize: 17, fontWeight: "600" },
        secondaryLabel: { color: colors.accent },
        note: {
          color: colors.textTertiary,
          fontSize: typography.meta.fontSize,
          lineHeight: 16,
          textAlign: "center",
          marginTop: space.xs,
        },
      }),
    [colors],
  );
  if (entry === "live") return props.live;
  if (entry === "demo") return props.demo(() => setEntry("welcome"));
  return (
    <ScrollView
      contentContainerStyle={entry === "checking" ? [styles.shell, styles.checking] : styles.shell}
      testID="mobile-entry"
    >
      {entry === "checking" ? (
        <ActivityIndicator color={colors.accent} accessibilityLabel="Checking paired computers" />
      ) : (
        <>
          <View style={styles.intro}>
            <Text accessibilityRole="header" style={styles.title}>
              Your workspace, on your phone
            </Text>
            <Text style={styles.body}>
              Connect to Octant on your own computer, or explore a sample workspace first. No Octant
              account is needed.
            </Text>
          </View>
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              onPress={() => setEntry("live")}
              style={({ pressed }) => [styles.button, pressed ? { opacity: 0.85 } : null]}
              testID="mobile-entry-connect"
            >
              <Text style={styles.label}>Connect a computer</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => setEntry("demo")}
              style={({ pressed }) => [
                styles.button,
                styles.secondary,
                pressed ? { opacity: 0.5 } : null,
              ]}
              testID="mobile-entry-demo"
            >
              <Text style={[styles.label, styles.secondaryLabel]}>Explore offline demo</Text>
            </Pressable>
            <Text style={styles.note}>
              The demo uses sample data. It never connects to a computer or changes your accounts.
            </Text>
          </View>
        </>
      )}
    </ScrollView>
  );
}
