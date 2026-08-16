import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import {
  mergeFailureMessage,
  mergeMobilePullRequest,
  type MobileRemoteTransport,
} from "@octant/client-runtime";
import type {
  CodePullRequestMergeMethod,
  CodePullRequestMergePreview,
  CodePullRequestReviewObserved,
} from "@octant/contracts";
import { presentStaleHostSecurity, type HostSessionHealthKind } from "@octant/domain";
import {
  assertBiometricConfirmed,
  requireBiometricConfirmation,
  type BiometricAuthenticator,
} from "../security/BiometricGate";
import { formatScreenshotSafeLabel } from "../security/screenshotSafeLabel";
import { mobileSpacing, mobileTypography } from "../theme/tokens";
import { useTheme } from "../../design-system";

export interface MergeSheetProps {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  readonly checkoutId: string;
  readonly review: CodePullRequestReviewObserved;
  readonly authenticator: BiometricAuthenticator;
  readonly hostHealth: HostSessionHealthKind;
  readonly onMerged: () => void;
}

function defaultMethod(
  preview: CodePullRequestMergePreview | undefined,
): CodePullRequestMergeMethod | undefined {
  if (preview === undefined || preview.advertisedMergeMethods.length === 0) return undefined;
  if (preview.advertisedMergeMethods.includes("squash")) return "squash";
  return preview.advertisedMergeMethods[0];
}

export function MergeSheet(props: MergeSheetProps) {
  const { colors } = useTheme();
  const preview = props.review.mergePreview;
  const [method, setMethod] = useState<CodePullRequestMergeMethod | undefined>(
    defaultMethod(preview),
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>();

  const hostSecurity = useMemo(
    () => presentStaleHostSecurity(props.hostHealth),
    [props.hostHealth],
  );

  const canMerge = useMemo(() => {
    if (!hostSecurity.allowProductMutations) return false;
    if (preview === undefined || method === undefined) return false;
    if (props.review.pullRequestState !== "open") return false;
    if (preview.mergeable !== true) return false;
    if (!preview.requiredChecksPassing) return false;
    if (!preview.advertisedMergeMethods.includes(method)) return false;
    return true;
  }, [hostSecurity.allowProductMutations, method, preview, props.review.pullRequestState]);

  const blockedReason = useMemo(() => {
    if (!hostSecurity.allowProductMutations) return hostSecurity.message;
    if (preview === undefined) return "Host did not advertise merge facts. Refresh on desktop.";
    if (props.review.pullRequestState !== "open") return "Only open pull requests can be merged.";
    if (preview.mergeable === false) return "Conflicts must be resolved on the desktop host.";
    if (preview.mergeable === null) return "Mergeability is unknown. Refresh and try again.";
    if (!preview.requiredChecksPassing) return "Required checks are not passing.";
    if (method === undefined) return "No merge method is advertised for this repository.";
    return undefined;
  }, [hostSecurity, method, preview, props.review.pullRequestState]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        sheet: {
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
        meta: {
          ...mobileTypography.body,
          color: colors.textSecondary,
        },
        help: {
          ...mobileTypography.body,
          color: colors.textSecondary,
        },
        method: {
          paddingVertical: mobileSpacing.sm,
          paddingHorizontal: mobileSpacing.md,
          borderRadius: 8,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.border,
        },
        methodActive: {
          borderColor: colors.accent,
          backgroundColor: colors.surface,
        },
        methodLabel: {
          ...mobileTypography.body,
          color: colors.textPrimary,
        },
        button: {
          marginTop: mobileSpacing.sm,
          backgroundColor: colors.accent,
          paddingVertical: mobileSpacing.md,
          borderRadius: 8,
          alignItems: "center",
        },
        buttonDisabled: {
          opacity: 0.45,
        },
        buttonLabel: {
          ...mobileTypography.body,
          color: colors.sendLabel,
          fontWeight: "600",
        },
        message: {
          ...mobileTypography.body,
          color: colors.textPrimary,
        },
      }),
    [colors],
  );

  const merge = async () => {
    if (preview === undefined || method === undefined || !canMerge) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const biometric = await requireBiometricConfirmation({
        authenticator: props.authenticator,
        reason: "merge",
      });
      assertBiometricConfirmed(biometric, "Merge");
      const confirmation = {
        number: props.review.number,
        baseRepository: props.review.baseRepository,
        baseBranch: props.review.baseBranch,
        headBranch: props.review.headBranch,
        mergeMethod: method,
        expectedHeadSha: preview.headSha,
      };
      const result = await mergeMobilePullRequest({
        transport: props.transport,
        threadId: props.threadId,
        checkoutId: props.checkoutId,
        expectedHeadSha: preview.headSha,
        mergeMethod: method,
        confirmation,
        authorization: { kind: "full-access" },
        idempotencyKey: `mobile-merge:${props.review.number}:${preview.headSha}:${method}`,
      });
      setMessage(mergeFailureMessage(result));
      if (result.state === "merged") props.onMerged();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Merge failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.sheet} testID="mobile-merge-sheet">
      <Text style={styles.title}>Clean merge</Text>
      <Text style={styles.meta}>
        #{props.review.number} → {props.review.baseBranch}
      </Text>
      <Text style={styles.meta}>{formatScreenshotSafeLabel(props.review.title)}</Text>
      {preview !== undefined ? (
        <Text style={styles.meta}>
          checks {preview.requiredChecksPassing ? "passing" : "blocked"} · tip{" "}
          {preview.headSha.slice(0, 7)}
        </Text>
      ) : null}
      {preview?.advertisedMergeMethods.map((entry) => (
        <Pressable
          key={entry}
          onPress={() => setMethod(entry)}
          style={[styles.method, method === entry ? styles.methodActive : null]}
          testID={`mobile-merge-method-${entry}`}
        >
          <Text style={styles.methodLabel}>{entry}</Text>
        </Pressable>
      ))}
      {blockedReason !== undefined ? <Text style={styles.help}>{blockedReason}</Text> : null}
      <Pressable
        disabled={!canMerge || busy}
        onPress={() => void merge()}
        style={[styles.button, !canMerge || busy ? styles.buttonDisabled : null]}
        testID="mobile-merge-confirm"
      >
        {busy ? (
          <ActivityIndicator color={colors.sendLabel} />
        ) : (
          <Text style={styles.buttonLabel}>Merge with biometrics</Text>
        )}
      </Pressable>
      {message !== undefined ? <Text style={styles.message}>{message}</Text> : null}
    </View>
  );
}
