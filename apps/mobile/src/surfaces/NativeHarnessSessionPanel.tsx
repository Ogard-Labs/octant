import { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  activateMobileNativeHarnessFollowUp,
  loadMobileNativeHarnessSession,
  previewMobileNativeHarnessFollowUp,
  type MobileRemoteTransport,
} from "@octant/client-runtime";
import type { NativeHarnessFollowUpPreview, NativeHarnessSessionView } from "@octant/contracts";
import { GlassChip, useTheme } from "../../design-system";
import { mobileSpacing, mobileTypography } from "../theme/tokens";

export interface NativeHarnessSessionPanelProps {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  readonly refreshIntervalMs?: number;
}

/**
 * The thread's harness session on the phone: status, the lead's model, the
 * last routing decisions, what the advisor did, and the follow-ups the lead
 * suggested. A follow-up is previewed and confirmed here exactly as on the
 * desktop; the host records the activation and the prompt is shown for the
 * person to carry into the thread they create.
 */
export function NativeHarnessSessionPanel(props: NativeHarnessSessionPanelProps) {
  const { colors } = useTheme();
  const [view, setView] = useState<NativeHarnessSessionView | null>();
  const [preview, setPreview] = useState<NativeHarnessFollowUpPreview>();
  const [note, setNote] = useState<string>();

  const load = useCallback(async () => {
    try {
      setView(
        await loadMobileNativeHarnessSession({
          transport: props.transport,
          threadId: props.threadId,
        }),
      );
    } catch {
      setView(null);
    }
  }, [props.transport, props.threadId]);

  useEffect(() => {
    void load();
    const interval = setInterval(() => void load(), props.refreshIntervalMs ?? 8_000);
    return () => clearInterval(interval);
  }, [load, props.refreshIntervalMs]);

  if (view === undefined || view === null) return null;
  const lastRoute = view.routes.at(-1);
  const lastIntervention = view.interventions.at(-1);

  return (
    <View style={[styles.card, { borderColor: colors.border }]} testID="mobile-native-harness">
      <View style={styles.row}>
        <Text style={[mobileTypography.section, { color: colors.textPrimary }]}>
          Native harness
        </Text>
        <Text style={[mobileTypography.caption, { color: colors.textSecondary }]}>
          {view.session.status}
        </Text>
      </View>
      <Text style={[mobileTypography.caption, { color: colors.textSecondary }]}>
        {String(view.session.lead.modelId)} · {view.session.turnsRun} turns ·{" "}
        {view.session.cutovers} context cuts
      </Text>
      {view.session.detail === undefined ? null : (
        <Text style={[mobileTypography.caption, { color: colors.textSecondary }]}>
          {view.session.detail}
        </Text>
      )}
      {lastRoute === undefined ? null : (
        <Text style={[mobileTypography.caption, { color: colors.textSecondary }]}>
          {lastRoute.job} → {String(lastRoute.slotId)}: {lastRoute.kind}
        </Text>
      )}
      {lastIntervention === undefined ? null : (
        <Text style={[mobileTypography.caption, { color: colors.textSecondary }]}>
          advisor {lastIntervention.kind}:{" "}
          {lastIntervention.kind === "redirect"
            ? lastIntervention.instruction
            : lastIntervention.kind === "second-opinion"
              ? lastIntervention.answer
              : lastIntervention.reason}
        </Text>
      )}
      {view.followUps === undefined || view.followUps.suggestions.length === 0 ? null : (
        <View style={styles.chips}>
          {view.followUps.suggestions.map((suggestion) => (
            <GlassChip
              active={view.activatedFollowUpIds.includes(suggestion.id)}
              key={String(suggestion.id)}
              label={suggestion.title}
              onPress={() => {
                void previewMobileNativeHarnessFollowUp({
                  transport: props.transport,
                  threadId: props.threadId,
                  suggestionId: String(suggestion.id),
                }).then((result) => {
                  setPreview(result);
                  setNote(
                    result === undefined ? "The host could not preview this follow-up." : undefined,
                  );
                });
              }}
              testID={`mobile-native-harness-follow-up-${String(suggestion.id)}`}
            />
          ))}
        </View>
      )}
      {preview === undefined ? null : (
        <View style={styles.preview} testID="mobile-native-harness-preview">
          <Text style={[mobileTypography.section, { color: colors.textPrimary }]}>
            {preview.suggestion.title}
          </Text>
          <Text style={[mobileTypography.caption, { color: colors.textSecondary }]}>
            {preview.wouldCreate.kind === "same-thread"
              ? "Continues in this thread."
              : preview.wouldCreate.kind === "new-thread"
                ? `Starts a new ${preview.wouldCreate.mode} thread.`
                : "Starts a new Code thread on its own worktree."}
          </Text>
          <Text style={[mobileTypography.body, { color: colors.textPrimary }]}>
            {preview.suggestion.prompt}
          </Text>
          <View style={styles.row}>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                if (view.followUps === undefined) return;
                void activateMobileNativeHarnessFollowUp({
                  transport: props.transport,
                  threadId: props.threadId,
                  turnId: String(view.followUps.turnId),
                  suggestionId: String(preview.suggestion.id),
                }).then((result) => {
                  setNote(
                    result?.kind === "follow-up-activated"
                      ? "Activated. Paste the prompt into the thread you create."
                      : (result?.message ?? "The host refused the activation."),
                  );
                  setPreview(undefined);
                  void load();
                });
              }}
              style={[styles.button, { backgroundColor: colors.send }]}
              testID="mobile-native-harness-confirm"
            >
              <Text style={[mobileTypography.section, { color: colors.sendLabel }]}>Confirm</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => setPreview(undefined)}
              style={styles.button}
            >
              <Text style={[mobileTypography.section, { color: colors.textSecondary }]}>
                Cancel
              </Text>
            </Pressable>
          </View>
        </View>
      )}
      {note === undefined ? null : (
        <Text style={[mobileTypography.caption, { color: colors.textSecondary }]}>{note}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: mobileSpacing.md,
    marginBottom: mobileSpacing.sm,
    padding: mobileSpacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    gap: mobileSpacing.xs,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: mobileSpacing.sm,
  },
  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: mobileSpacing.xs,
    marginTop: mobileSpacing.xs,
  },
  preview: {
    marginTop: mobileSpacing.xs,
    gap: mobileSpacing.xs,
  },
  button: {
    paddingHorizontal: mobileSpacing.md,
    paddingVertical: mobileSpacing.xs,
    borderRadius: 999,
  },
});
