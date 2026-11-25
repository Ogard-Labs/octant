import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { space, typography, useTheme } from "../../design-system";
import { useMobileThreads } from "./MobileThreadsContext";

/** What could not be read, and a Retry, above whichever list a place shows. */
export function ThreadReadFailures() {
  const { colors } = useTheme();
  const { error, failures, hostLabel, refresh } = useMobileThreads();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        row: { paddingBottom: space.sm },
        message: {
          color: colors.danger,
          fontSize: typography.detail.fontSize,
          lineHeight: 18,
          paddingHorizontal: space.md,
          marginBottom: space.sm,
        },
        retry: {
          color: colors.accent,
          fontSize: typography.detail.fontSize,
          fontWeight: "500",
          paddingHorizontal: space.md,
        },
      }),
    [colors],
  );
  return (
    <>
      {error === undefined ? null : (
        <Text style={styles.message} testID="mobile-inbox-error">
          {error}
        </Text>
      )}
      {failures.map((failure) => {
        const label = hostLabel(failure.hostId);
        return (
          <View
            key={failure.hostId}
            style={styles.row}
            testID={`mobile-inbox-failure-${failure.hostId}`}
          >
            <Text style={styles.message}>
              {failure.category === "incompatible"
                ? `${label} sent thread data this app version can't read. Update the app or the host.`
                : `${label}: ${failure.message}`}
            </Text>
            <Pressable
              onPress={() => void refresh()}
              testID={`mobile-inbox-retry-${failure.hostId}`}
            >
              <Text style={styles.retry}>Retry</Text>
            </Pressable>
          </View>
        );
      })}
    </>
  );
}
