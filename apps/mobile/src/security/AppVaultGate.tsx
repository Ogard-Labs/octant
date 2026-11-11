import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, AppState, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { radii, space, useTheme } from "../../design-system";
import { unlockAppVault, type AppVaultUnlockResult, type DeviceAuthenticator } from "./AppVault";
import {
  createUnlockAttemptGuard,
  resolveUnlockCompletion,
  shouldPreserveVaultForAppState,
  shouldSuppressAutoUnlockAfterPrompt,
  type UnlockAppState,
} from "./unlockAttemptGuard";
import { isMobileHighRiskPromptActive } from "./mobileAuthPromptState";

const UNLOCK_MESSAGE = "Unlock to open Octant.";

export function AppVaultGate(props: {
  readonly authenticator: DeviceAuthenticator;
  readonly children: ReactNode;
}) {
  const { colors } = useTheme();
  const [state, setState] = useState<"locked" | "unlocking" | "unlocked">("locked");
  const [message, setMessage] = useState(UNLOCK_MESSAGE);
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
      setMessage(result.status === "locked" ? result.reason : UNLOCK_MESSAGE);
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
      setMessage(UNLOCK_MESSAGE);
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
        // The system lock screen's shape: a centred lock, a title and one
        // sentence, and the unlock action at the bottom within thumb reach.
        shell: {
          flex: 1,
          justifyContent: "space-between",
          paddingHorizontal: space.lg,
          paddingTop: space.xxl * 2,
          paddingBottom: space.xl,
          backgroundColor: colors.canvas,
        },
        intro: {
          alignItems: "center",
          gap: space.md,
          width: "100%",
          maxWidth: 420,
          alignSelf: "center",
        },
        title: {
          color: colors.textPrimary,
          fontSize: 28,
          fontWeight: "700",
          letterSpacing: -0.7,
          textAlign: "center",
        },
        body: {
          color: colors.textSecondary,
          fontSize: 17,
          lineHeight: 24,
          textAlign: "center",
        },
        button: {
          width: "100%",
          maxWidth: 420,
          alignSelf: "center",
          alignItems: "center",
          justifyContent: "center",
          height: 50,
          borderRadius: radii.md,
          backgroundColor: colors.accent,
          paddingHorizontal: space.lg,
        },
        buttonLabel: {
          color: colors.sendLabel,
          fontSize: 17,
          fontWeight: "600",
        },
      }),
    [colors],
  );

  if (state === "unlocked") return props.children;

  return (
    <View style={styles.shell} testID="mobile-vault-locked">
      <View style={styles.intro}>
        <Ionicons color={colors.accent} name="lock-closed" size={44} />
        <Text accessibilityRole="header" style={styles.title}>
          Unlock Octant
        </Text>
        <Text selectable style={styles.body}>
          {message}
        </Text>
      </View>
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
    </View>
  );
}
