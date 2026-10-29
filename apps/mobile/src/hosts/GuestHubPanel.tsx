import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  joinHubAsGuest,
  type GuestJoinRefusal,
  type RemoteDeviceKeyStore,
} from "@octant/client-runtime";
import { mobilePinnedListenerTransport } from "../runtime/mobilePinnedListenerTransport";
import { MOBILE_PRODUCT_NAME } from "../copy";
import { useTheme } from "../../design-system";
import { mobileRadii, mobileSpacing, mobileTypography } from "../theme/tokens";
import { PairingCodeScanner } from "./PairingCodeScanner";
import type { MobileHostRegistry } from "./HostRegistry";
import {
  finishGuestJoin,
  type GuestHubState,
  type GuestHubStore,
  type GuestSpokeRefusal,
} from "./hubGuestFlow";
import type { PhoneUnlockKey, UnlockKeyIdentity } from "./ownerUnlockKey";

const POLL_MS = 3_000;

// Defined here because the shared copy file is owned elsewhere in this change.
const GUEST_JOIN_REFUSAL: Readonly<Record<GuestJoinRefusal, string>> = {
  "refused-code": "That code was refused.",
  "hub-declined": "The hub declined this phone.",
  "hub-refused-join": "The hub refused this phone.",
  "hub-answer-invalid": "The hub's answer did not check out, so nothing was saved.",
  "device-key-lost": "This phone lost the key it paired with. Try again.",
  "hub-unreachable": "Couldn't reach the hub. Check that you are on the same private network.",
};

export const NOT_ACCEPTED_COPY = "Not accepted on that computer";

type GuestPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "working" }
  | {
      readonly kind: "comparing";
      readonly hubName: string;
      readonly comparisonCode: string;
      readonly finish: () => ReturnType<Parameters<typeof finishGuestJoin>[0]["finish"]>;
      readonly unlock?: UnlockKeyIdentity;
    }
  | {
      readonly kind: "joined";
      readonly state: GuestHubState;
      readonly unlock?: UnlockKeyIdentity;
    }
  | { readonly kind: "failed"; readonly message: string };

export interface GuestHubPanelProps {
  readonly registry: MobileHostRegistry;
  readonly deviceKeyStore: RemoteDeviceKeyStore;
  readonly guestHubStore: GuestHubStore;
  readonly removeHost: (hostId: string) => Promise<unknown>;
  readonly deviceLabel?: string;
  /** Present on a build that can hold an unlock key; without it the phone joins as a plain guest. */
  readonly unlockKey?: PhoneUnlockKey;
  /** Called once the spokes that admitted the phone are in the host list. */
  readonly onJoined: () => void;
}

/** Joins a hub as a guest with the hub's join code, then adds every spoke that admits the phone. */
export function GuestHubPanel(props: GuestHubPanelProps) {
  const { colors } = useTheme();
  const [code, setCode] = useState("");
  const [scanning, setScanning] = useState(false);
  const [asOwner, setAsOwner] = useState(false);
  const [phase, setPhase] = useState<GuestPhase>({ kind: "idle" });
  const deviceLabel = props.deviceLabel ?? `${MOBILE_PRODUCT_NAME} Mobile`;
  const lifetime = useRef(new AbortController());
  useEffect(() => {
    const current = new AbortController();
    lifetime.current = current;
    return () => current.abort();
  }, []);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        panel: { gap: mobileSpacing.md },
        title: {
          color: colors.textPrimary,
          fontSize: mobileTypography.title.fontSize,
          fontWeight: mobileTypography.title.fontWeight,
        },
        help: {
          color: colors.textSecondary,
          fontSize: mobileTypography.caption.fontSize,
          lineHeight: 18,
        },
        input: {
          backgroundColor: colors.surfaceElevated,
          borderRadius: mobileRadii.sm,
          paddingHorizontal: mobileSpacing.md,
          paddingVertical: 12,
          color: colors.textPrimary,
          fontSize: mobileTypography.body.fontSize,
        },
        button: {
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.accent,
          paddingVertical: mobileSpacing.sm,
          alignItems: "center",
          borderRadius: mobileRadii.pill,
        },
        buttonLabel: { color: colors.accent, fontWeight: "500" },
        box: {
          gap: mobileSpacing.sm,
          padding: mobileSpacing.md,
          backgroundColor: colors.surface,
          borderRadius: mobileRadii.md,
        },
        boxTitle: { color: colors.textPrimary, fontWeight: "500" },
        body: { color: colors.textSecondary },
        mono: { color: colors.textSecondary, fontFamily: "Menlo", fontSize: 11 },
        switchRow: {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
        },
        error: { color: colors.danger },
      }),
    [colors],
  );

  const begin = async (hubCode: string) => {
    setPhase({ kind: "working" });
    try {
      // Making the key asks for nothing; it is only used, after an unlock, to answer a computer's challenge.
      const unlock = asOwner ? await props.unlockKey?.ensure() : undefined;
      const started = await joinHubAsGuest({
        code: hubCode,
        deviceLabel,
        transport: mobilePinnedListenerTransport,
        webBuildVersion: `${MOBILE_PRODUCT_NAME}-mobile/0.1.0`,
        deviceKeyStore: props.deviceKeyStore,
        ...(unlock === undefined ? {} : { ownerUnlockPublicKey: unlock.publicKey }),
      });
      if (started.status !== "awaiting-approval") {
        setPhase({ kind: "failed", message: started.message });
        return;
      }
      setPhase({
        kind: "comparing",
        hubName: started.hubName,
        comparisonCode: started.comparisonCode,
        finish: started.finish,
        ...(unlock === undefined ? {} : { unlock }),
      });
    } catch {
      setPhase({ kind: "failed", message: "Couldn't reach the hub." });
    }
  };

  const check = useCallback(
    async (current: Extract<GuestPhase, { kind: "comparing" }>) => {
      const signal = lifetime.current.signal;
      try {
        const outcome = await finishGuestJoin({
          finish: current.finish,
          deviceLabel,
          owner: current.unlock !== undefined,
          store: props.guestHubStore,
          transport: mobilePinnedListenerTransport,
          deviceKeyStore: props.deviceKeyStore,
          registry: props.registry,
          removeHost: props.removeHost,
        });
        if (signal.aborted) return;
        if (outcome.status === "waiting") {
          setPhase({ ...current });
          return;
        }
        if (outcome.status === "refused") {
          setPhase({ kind: "failed", message: GUEST_JOIN_REFUSAL[outcome.kind] });
          return;
        }
        setPhase({
          kind: "joined",
          state: outcome.state,
          ...(current.unlock === undefined ? {} : { unlock: current.unlock }),
        });
        props.onJoined();
      } catch {
        if (!signal.aborted) setPhase({ ...current });
      }
    },
    [deviceLabel, props],
  );

  // Each check that finds the hub still waiting replaces the phase, which re-arms this timer.
  useEffect(() => {
    if (phase.kind !== "comparing") return;
    const timer = setTimeout(() => void check(phase), POLL_MS);
    return () => clearTimeout(timer);
  }, [phase, check]);

  return (
    <View style={styles.panel} testID="mobile-guest-hub-panel">
      <Text style={styles.title}>Join a hub as a guest</Text>
      {phase.kind === "idle" ? (
        <>
          <Text style={styles.help}>
            A guest runs no agents. Each computer on the hub decides whether to let this phone in.
            Paste or scan the hub's join code.
          </Text>
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={setCode}
            placeholder="Hub join code"
            placeholderTextColor={colors.textTertiary}
            style={styles.input}
            testID="mobile-guest-hub-code"
            value={code}
          />
          {props.unlockKey === undefined ? null : (
            <View style={styles.switchRow}>
              <Text style={styles.body}>This is an owner code</Text>
              <Switch
                accessibilityLabel="This is an owner code"
                onValueChange={setAsOwner}
                testID="mobile-guest-hub-owner"
                value={asOwner}
              />
            </View>
          )}
          {props.unlockKey !== undefined && asOwner ? (
            <Text style={styles.help}>
              The phone makes an unlock key. Its private half stays in this phone's secure storage
              and opens only after Face ID, a fingerprint, or your passcode.
            </Text>
          ) : null}
          <Pressable
            accessibilityRole="button"
            onPress={() => setScanning(true)}
            style={styles.button}
            testID="mobile-guest-hub-scan"
          >
            <Text style={styles.buttonLabel}>Scan the hub's QR code</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={code.trim().length === 0}
            onPress={() => void begin(code.trim())}
            style={styles.button}
            testID="mobile-guest-hub-start"
          >
            <Text style={styles.buttonLabel}>Join the hub</Text>
          </Pressable>
        </>
      ) : null}
      {phase.kind === "working" ? (
        <View style={styles.box}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.body}>Contacting the hub…</Text>
        </View>
      ) : null}
      {phase.kind === "comparing" ? (
        <View style={styles.box} testID="mobile-guest-hub-comparing">
          <Text style={styles.boxTitle}>Approve on the hub</Text>
          <Text style={styles.body}>
            Comparison code {phase.comparisonCode} · {phase.hubName}. Approve only if the hub shows
            the same code.
          </Text>
        </View>
      ) : null}
      {phase.kind === "joined" ? (
        <View style={styles.box} testID="mobile-guest-hub-joined">
          <Text style={styles.boxTitle}>Joined the hub</Text>
          <Text style={styles.body}>
            {phase.state.spokes.length === 1
              ? "1 computer let this phone in."
              : `${phase.state.spokes.length} computers let this phone in.`}
          </Text>
          <GuestHubRefusals refused={phase.state.notAccepted} />
          {phase.unlock === undefined ? null : (
            <View testID="mobile-guest-hub-unlock-key">
              <Text style={styles.help}>
                To make this phone an owner on a computer, open that computer's Settings, Hub, and
                confirm this key by its fingerprint.
              </Text>
              <Text selectable style={styles.mono}>
                {phase.unlock.fingerprint}
              </Text>
              <Text selectable style={styles.mono}>
                {phase.unlock.publicKey}
              </Text>
            </View>
          )}
        </View>
      ) : null}
      {phase.kind === "failed" ? (
        <View style={styles.box}>
          <Text style={styles.error} testID="mobile-guest-hub-failed">
            {phase.message}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => setPhase({ kind: "idle" })}
            style={styles.button}
            testID="mobile-guest-hub-retry"
          >
            <Text style={styles.buttonLabel}>Try again</Text>
          </Pressable>
        </View>
      ) : null}
      <PairingCodeScanner
        onClose={() => setScanning(false)}
        onScanned={(scanned) => {
          setScanning(false);
          setCode(scanned);
          void begin(scanned);
        }}
        visible={scanning}
      />
    </View>
  );
}

/** Spokes that refused the phone: named, with no action. */
export function GuestHubRefusals(props: { readonly refused: ReadonlyArray<GuestSpokeRefusal> }) {
  const { colors } = useTheme();
  if (props.refused.length === 0) return null;
  return (
    <View testID="mobile-guest-hub-refusals">
      {props.refused.map((spoke) => (
        <Text
          key={spoke.memberId}
          style={{
            color: colors.textSecondary,
            fontSize: mobileTypography.caption.fontSize,
            paddingVertical: mobileSpacing.xs,
          }}
        >
          {spoke.name} · {NOT_ACCEPTED_COPY}
        </Text>
      ))}
    </View>
  );
}
