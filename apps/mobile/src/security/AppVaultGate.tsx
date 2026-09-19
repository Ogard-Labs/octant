import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, AppState, Pressable, StyleSheet, Text, View } from "react-native";
import { GlassSurface, space, typography, useTheme } from "../../design-system";
import { unlockAppVault, type AppVaultUnlockResult, type DeviceAuthenticator } from "./AppVault";
import {
  createUnlockAttemptGuard,
  resolveUnlockCompletion,
  shouldPreserveVaultForAppState,
  shouldSuppressAutoUnlockAfterPrompt,
  type UnlockAppState,
} from "./unlockAttemptGuard";
import { isMobileHighRiskPromptActive } from "./mobileAuthPromptState";

export function AppVaultGate(props: {
  readonly authenticator: DeviceAuthenticator;
  readonly children: ReactNode;
}) {
  const { colors } = useTheme();
  const [state, setState] = useState<"locked" | "unlocking" | "unlocked">("locked");
  const [message, setMessage] = useState("Authenticate to load paired hosts and thread data.");
  const unlockGuard = useRef(createUnlockAttemptGuard()).current;
  const unlockInFlight = useRef(false);
  const suppressNextActiveUnlock = useRef(false);

  const pendingCompletion = useRef<
    { readonly attempt: number; readonly result: AppVaultUnlockResult } | undefined
  >(undefined);

  const completeUnlock = useCallback(
    (attempt: number, result: AppVaultUnlockResult, appState: UnlockAppState) => {
      const completion = resolveUnlockCompletion({
        appState,
        attemptCurrent: unlockGuard.isCurrent(attempt),
        resultStatus: result.status,
      });
      if (completion === "ignore") return;
      if (completion === "defer") {
        // iOS may resolve Face ID before emitting the active transition that dismisses it.
        pendingCompletion.current = { attempt, result };
        return;
      }
      if (completion === "unlock") {
        setState("unlocked");
        return;
      }
      setMessage(
        result.status === "locked"
          ? result.reason
          : "Authenticate to load paired hosts and thread data.",
      );
      setState("locked");
    },
    [unlockGuard],
  );

  const unlock = useCallback(async () => {
    const attempt = unlockGuard.begin();
    pendingCompletion.current = undefined;
    unlockInFlight.current = true;
    setState("unlocking");
    try {
      const result = await unlockAppVault(props.authenticator);
      completeUnlock(attempt, result, AppState.currentState);
    } finally {
      unlockInFlight.current = false;
    }
  }, [props.authenticator, completeUnlock, unlockGuard]);

  useEffect(() => {
    void unlock();
  }, [unlock]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") {
        const pending = pendingCompletion.current;
        if (pending !== undefined) {
          pendingCompletion.current = undefined;
          suppressNextActiveUnlock.current = false;
          completeUnlock(pending.attempt, pending.result, next);
          return;
        }
        if (suppressNextActiveUnlock.current) {
          suppressNextActiveUnlock.current = false;
          return;
        }
        if (unlockInFlight.current) return;
        void unlock();
        return;
      }
      if (
        shouldPreserveVaultForAppState({
          nextState: next,
          highRiskPromptInFlight: isMobileHighRiskPromptActive(),
          vaultUnlockInFlight: unlockInFlight.current,
        })
      ) {
        suppressNextActiveUnlock.current = true;
        return;
      }
      suppressNextActiveUnlock.current = shouldSuppressAutoUnlockAfterPrompt(
        unlockInFlight.current,
      );
      pendingCompletion.current = undefined;
      unlockGuard.invalidate();
      setMessage("Authenticate to load paired hosts and thread data.");
      setState("locked");
    });
    return () => {
      pendingCompletion.current = undefined;
      unlockGuard.invalidate();
      subscription.remove();
    };
  }, [unlock, unlockGuard, completeUnlock]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        shell: {
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          padding: space.lg,
          backgroundColor: colors.canvas,
        },
        card: {
          width: "100%",
          maxWidth: 420,
          gap: space.md,
          padding: space.lg,
        },
        eyebrow: {
          color: colors.accent,
          fontSize: typography.caption.fontSize,
          fontWeight: "500",
          letterSpacing: 1,
        },
        title: {
          color: colors.textPrimary,
          fontSize: 30,
          fontWeight: "500",
          letterSpacing: -0.7,
        },
        body: {
          color: colors.textSecondary,
          fontSize: typography.body.fontSize,
          lineHeight: 20,
        },
        button: {
          alignItems: "center",
          justifyContent: "center",
          minHeight: 48,
          borderRadius: 24,
          backgroundColor: colors.accent,
          paddingHorizontal: space.lg,
        },
        buttonLabel: {
          color: colors.sendLabel,
          fontSize: typography.body.fontSize,
          fontWeight: "500",
        },
      }),
    [colors],
  );

  if (state === "unlocked") return props.children;

  return (
    <View style={styles.shell} testID="mobile-vault-locked">
      <GlassSurface contentStyle={styles.card} material="regular">
        <Text style={styles.eyebrow}>Private workspace</Text>
        <Text style={styles.title}>Unlock Octant</Text>
        <Text selectable style={styles.body}>
          {message}
        </Text>
        <Pressable
          accessibilityRole="button"
          disabled={state === "unlocking"}
          onPress={() => void unlock()}
          style={styles.button}
          testID="mobile-vault-unlock"
        >
          {state === "unlocking" ? (
            <ActivityIndicator color={colors.sendLabel} />
          ) : (
            <Text style={styles.buttonLabel}>Unlock</Text>
          )}
        </Pressable>
      </GlassSurface>
    </View>
  );
}
