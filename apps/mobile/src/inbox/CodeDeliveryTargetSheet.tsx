import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import {
  decodeCodeDeliveryTarget,
  type CodeDeliveryOutcomeKind,
  type CodeDeliveryTarget,
} from "@octant/contracts";
import type { MobileCodeDeliveryTargetProposal } from "@octant/client-runtime";
import { BottomSheet } from "../ui/BottomSheet";
import { mobileSpacing, mobileTypography } from "../theme/tokens";
import { useTheme } from "../../design-system";
import { validateCodeDeliveryTargetFields } from "./codeDeliveryTargetValidation";

const OUTCOME_OPTIONS: ReadonlyArray<CodeDeliveryOutcomeKind> = [
  "investigation-result",
  "local-implementation",
  "opened-pr",
  "merged-pr",
];

function outcomeLabel(kind: CodeDeliveryOutcomeKind): string {
  if (kind === "investigation-result") return "Investigation result";
  if (kind === "local-implementation") return "Local implementation";
  if (kind === "opened-pr") return "Opened pull request";
  return "Merged pull request";
}

export interface CodeDeliveryTargetSheetProps {
  readonly proposal: MobileCodeDeliveryTargetProposal | undefined;
  readonly onClose: () => void;
  readonly onConfirm: (target: CodeDeliveryTarget) => void;
}

export function CodeDeliveryTargetSheet(props: CodeDeliveryTargetSheetProps) {
  const { colors } = useTheme();
  const [branchIntent, setBranchIntent] = useState("");
  const [remoteName, setRemoteName] = useState("");
  const [baseRepository, setBaseRepository] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [outcomeKind, setOutcomeKind] = useState<CodeDeliveryOutcomeKind>("local-implementation");
  const [validationError, setValidationError] = useState<string | undefined>();

  useEffect(() => {
    if (props.proposal === undefined) return;
    setBranchIntent(props.proposal.branchIntent);
    setRemoteName(props.proposal.remoteName);
    setBaseRepository(props.proposal.proposedBaseRepository);
    setBaseBranch(props.proposal.proposedBaseBranch);
    setOutcomeKind(props.proposal.suggestedOutcomeKind);
    setValidationError(undefined);
  }, [props.proposal]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        content: { paddingHorizontal: mobileSpacing.md, gap: mobileSpacing.sm },
        intro: { color: colors.textSecondary, ...mobileTypography.body, lineHeight: 21 },
        label: {
          color: colors.textSecondary,
          ...mobileTypography.caption,
          fontWeight: "700",
          textTransform: "uppercase",
        },
        input: {
          color: colors.textPrimary,
          ...mobileTypography.body,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.border,
          borderRadius: 10,
          paddingHorizontal: mobileSpacing.md,
          paddingVertical: mobileSpacing.sm,
        },
        outcomeList: { gap: mobileSpacing.xs },
        outcome: {
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.border,
          borderRadius: 10,
          paddingHorizontal: mobileSpacing.md,
          paddingVertical: mobileSpacing.sm,
        },
        outcomeSelected: {
          borderColor: colors.accent,
          backgroundColor: colors.surface,
        },
        outcomeText: { color: colors.textPrimary, ...mobileTypography.body },
        outcomeTextSelected: { color: colors.accent, fontWeight: "700" },
        validationError: { color: colors.danger, ...mobileTypography.caption, lineHeight: 18 },
        confirm: {
          alignItems: "center",
          backgroundColor: colors.accent,
          borderRadius: 10,
          marginTop: mobileSpacing.sm,
          paddingVertical: mobileSpacing.md,
        },
        confirmDisabled: { opacity: 0.45 },
        confirmText: { color: colors.sendLabel, ...mobileTypography.body, fontWeight: "700" },
      }),
    [colors],
  );

  if (props.proposal === undefined) return null;
  const canConfirm = [branchIntent, remoteName, baseRepository, baseBranch].every(
    (value) => value.trim().length > 0,
  );

  return (
    <BottomSheet
      onClose={props.onClose}
      title="Confirm Code delivery"
      visible={props.proposal !== undefined}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.intro}>
          {props.proposal.workspace === "managed-worktree"
            ? `This thread will start in a managed worktree Octant creates from ${props.proposal.boundRoot}.`
            : `This thread will bind the current checkout at ${props.proposal.boundRoot}.`}{" "}
          Confirm the repository, branch, remote, and outcome Octant will work toward. Nothing is
          created until you confirm this target.
        </Text>
        <Text style={styles.label}>Delivery branch</Text>
        <TextInput
          autoCapitalize="none"
          onChangeText={(value) => {
            setBranchIntent(value);
            setValidationError(undefined);
          }}
          style={styles.input}
          testID="mobile-code-delivery-branch"
          value={branchIntent}
        />
        <Text style={styles.label}>Remote</Text>
        <TextInput
          autoCapitalize="none"
          onChangeText={(value) => {
            setRemoteName(value);
            setValidationError(undefined);
          }}
          style={styles.input}
          testID="mobile-code-delivery-remote"
          value={remoteName}
        />
        <Text style={styles.label}>Base repository</Text>
        <TextInput
          autoCapitalize="none"
          onChangeText={(value) => {
            setBaseRepository(value);
            setValidationError(undefined);
          }}
          placeholder="owner/repository"
          style={styles.input}
          testID="mobile-code-delivery-base-repository"
          value={baseRepository}
        />
        <Text style={styles.label}>Base branch</Text>
        <TextInput
          autoCapitalize="none"
          onChangeText={(value) => {
            setBaseBranch(value);
            setValidationError(undefined);
          }}
          style={styles.input}
          testID="mobile-code-delivery-base-branch"
          value={baseBranch}
        />
        <Text style={styles.label}>Outcome</Text>
        <View style={styles.outcomeList}>
          {OUTCOME_OPTIONS.map((option) => {
            const selected = outcomeKind === option;
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected }}
                key={option}
                onPress={() => setOutcomeKind(option)}
                style={[styles.outcome, selected ? styles.outcomeSelected : null]}
                testID={`mobile-code-delivery-outcome-${option}`}
              >
                <Text style={[styles.outcomeText, selected ? styles.outcomeTextSelected : null]}>
                  {outcomeLabel(option)}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {validationError !== undefined ? (
          <Text style={styles.validationError} testID="mobile-code-delivery-error">
            {validationError}
          </Text>
        ) : null}
        <Pressable
          accessibilityRole="button"
          disabled={!canConfirm}
          onPress={() => {
            if (!canConfirm) return;
            const fields = {
              branchIntent: branchIntent.trim(),
              remoteName: remoteName.trim(),
              proposedBaseRepository: baseRepository.trim(),
              proposedBaseBranch: baseBranch.trim(),
            };
            const fieldError = validateCodeDeliveryTargetFields(fields);
            if (fieldError !== undefined) {
              setValidationError(fieldError);
              return;
            }
            try {
              props.onConfirm(
                decodeCodeDeliveryTarget({
                  ...fields,
                  outcomeKind,
                  confirmedAt: new Date().toISOString(),
                }),
              );
            } catch {
              setValidationError("Enter a valid delivery target before confirming.");
            }
          }}
          style={[styles.confirm, !canConfirm ? styles.confirmDisabled : null]}
          testID="mobile-code-delivery-confirm"
        >
          <Text style={styles.confirmText}>Confirm delivery target</Text>
        </Pressable>
      </ScrollView>
    </BottomSheet>
  );
}
