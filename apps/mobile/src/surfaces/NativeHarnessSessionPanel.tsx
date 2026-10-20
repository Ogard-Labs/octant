import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  harnessRetryStatusText,
  nativeHarnessSessionHeld,
  nativeHarnessStatusLabel,
  nativeHarnessTaskLabel,
  sessionStatsInputOf,
  threadStatsLine,
} from "@octant/domain";
import * as Clipboard from "expo-clipboard";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import {
  activateMobileNativeHarnessFollowUp,
  answerMobileNativeHarnessQuestion,
  commandMobileNativeHarnessSession,
  decideMobileNativeHarnessApproval,
  loadMobileNativeHarnessSession,
  previewMobileNativeHarnessFollowUp,
  type MobileRemoteTransport,
} from "@octant/client-runtime";
import type { NativeHarnessFollowUpPreview, NativeHarnessSessionView } from "@octant/contracts";
import { GlassChip, useTheme } from "../../design-system";
import { ApprovalDecisionButtons } from "../approvals/ApprovalDecisionButtons";
import { MOBILE_COPY } from "../copy";
import { usePolledResource } from "../runtime/usePolledResource";
import {
  decideWithConfirmation,
  type BiometricAuthenticator,
  type ConfirmedSendResult,
} from "../security/BiometricGate";
import { createExpoBiometricAuthenticator } from "../security/expoBiometricAuthenticator";
import { OutsideContentNote } from "./OutsideContentNote";
import { mobileSpacing, mobileTypography } from "../theme/tokens";

export interface NativeHarnessSessionPanelProps {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  readonly refreshIntervalMs?: number;
  /** Confirms Allow on this phone; the device's own biometrics when absent. */
  readonly authenticator?: BiometricAuthenticator;
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
  const deviceAuthenticator = useMemo(() => createExpoBiometricAuthenticator(), []);
  const authenticator = props.authenticator ?? deviceAuthenticator;
  const [preview, setPreview] = useState<NativeHarnessFollowUpPreview>();
  const [note, setNote] = useState<string>();
  const [answer, setAnswer] = useState("");
  const [nowMs, setNowMs] = useState(() => Date.now());
  // Hosts ticked on a marked thread's command, for the approval they were ticked on.
  const [tickedHosts, setTickedHosts] = useState<{
    readonly approvalId: string;
    readonly keys: ReadonlySet<string>;
  }>();

  const lastView = useRef<NativeHarnessSessionView>(undefined);
  const [fast, setFast] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const load = useCallback(async () => {
    const next = await loadMobileNativeHarnessSession({
      transport: props.transport,
      threadId: props.threadId,
    });
    // The host answering "no session" for a thread we already show means the
    // read failed, not that the session ended; keep the last view.
    if (next === null && lastView.current !== undefined) throw new Error("session unavailable");
    lastView.current = next ?? undefined;
    return next;
  }, [props.transport, props.threadId]);

  // A running turn is read more often so a short retry is not missed.
  const resource = usePolledResource(load, {
    intervalMs: props.refreshIntervalMs ?? (fast ? 1_000 : 8_000),
  });
  const view = resource.value;
  const running = view?.session.status === "running";
  useEffect(() => setFast(running), [running]);

  // Every host action goes through here: one at a time, a failure becomes a
  // note instead of a silent no-op, and the view is re-read either way.
  const run = async (action: () => Promise<string | undefined>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      setNote(await action());
    } catch {
      setNote(MOBILE_COPY.approvalSendFailed);
    } finally {
      busyRef.current = false;
      setBusy(false);
      void resource.reload();
    }
  };

  useEffect(() => {
    if (view?.retrying === undefined) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [view?.retrying]);

  if (view === undefined || view === null) return null;
  const pendingQuestion = view.questions.find((question) => question.status === "pending");
  const pendingApproval = view.approvals?.find((approval) => approval.status === "pending");
  const hostKey = (entry: { readonly host: string; readonly port: number }) =>
    `${entry.host}:${String(entry.port)}`;
  const listedHosts = pendingApproval?.commandHosts;
  const ticked =
    pendingApproval !== undefined && tickedHosts?.approvalId === String(pendingApproval.id)
      ? tickedHosts.keys
      : new Set((listedHosts ?? []).filter((entry) => entry.preselected).map(hostKey));
  const toggleHost = (key: string) => {
    if (pendingApproval === undefined) return;
    const keys = new Set(ticked);
    if (keys.has(key)) keys.delete(key);
    else keys.add(key);
    setTickedHosts({ approvalId: String(pendingApproval.id), keys });
  };
  const decide = (decision: "approve" | "approve-always" | "deny") => {
    if (pendingApproval === undefined) return;
    void run(async () => {
      const send = () =>
        decideMobileNativeHarnessApproval({
          transport: props.transport,
          threadId: props.threadId,
          approvalId: String(pendingApproval.id),
          decision,
          ...(listedHosts === undefined || decision !== "approve"
            ? {}
            : {
                commandHosts: listedHosts
                  .filter((entry) => ticked.has(hostKey(entry)))
                  .map((entry) => ({ host: entry.host, port: entry.port })),
              }),
        });
      // Denying is the safe direction, so only the two Allow answers ask the
      // person to confirm on this phone.
      const outcome: ConfirmedSendResult<Awaited<ReturnType<typeof send>>> =
        decision === "deny"
          ? { status: "sent", value: await send() }
          : await decideWithConfirmation({ authenticator, reason: "approve", send });
      if (outcome.status === "blocked") return outcome.message;
      const result = outcome.value;
      return result?.kind === "approval-decided"
        ? undefined
        : (result?.message ?? "The decision was refused.");
    });
  };
  const sendAnswer = (text: string) => {
    if (pendingQuestion === undefined || text.trim().length === 0) return;
    void run(async () => {
      const result = await answerMobileNativeHarnessQuestion({
        transport: props.transport,
        threadId: props.threadId,
        questionId: String(pendingQuestion.id),
        answer: text.trim(),
      });
      setAnswer("");
      return result?.kind === "question-answered"
        ? undefined
        : (result?.message ?? "The answer was refused.");
    });
  };
  // The same words the desktop composer and the terminal footer use, read-only.
  const stats = threadStatsLine(sessionStatsInputOf(view));
  const lastRoute = view.routes.at(-1);
  const lastIntervention = view.interventions.at(-1);

  return (
    <View style={[styles.card, { borderColor: colors.border }]} testID="mobile-native-harness">
      <View style={styles.row}>
        <Text style={[mobileTypography.section, { color: colors.textPrimary }]}>
          Native harness
        </Text>
        <Text style={[mobileTypography.caption, { color: colors.textSecondary }]}>
          {nativeHarnessStatusLabel(view.session.status)}
        </Text>
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          hitSlop={12}
          onPress={() => {
            const paused = nativeHarnessSessionHeld(view.session.status);
            void run(async () => {
              const result = await commandMobileNativeHarnessSession({
                transport: props.transport,
                threadId: props.threadId,
                kind: paused ? "resume-native-harness-session" : "pause-native-harness-session",
                sessionId: String(view.session.id),
                expectedVersion: view.session.version,
              });
              return result.ok ? undefined : (result.message ?? "The host refused that.");
            });
          }}
          testID="mobile-native-harness-pause"
        >
          <Text style={[mobileTypography.caption, { color: colors.textPrimary }]}>
            {nativeHarnessSessionHeld(view.session.status) ? "Resume" : "Pause"}
          </Text>
        </Pressable>
      </View>
      <Text style={[mobileTypography.caption, { color: colors.textSecondary }]}>
        {String(view.session.lead.modelId)} · {view.session.turnsRun} turns ·{" "}
        {view.session.cutovers} context cuts
      </Text>
      {stats.length === 0 ? null : (
        <Text
          style={[mobileTypography.caption, { color: colors.textSecondary }]}
          testID="mobile-native-harness-stats"
        >
          {stats}
        </Text>
      )}
      {view.session.detail === undefined ? null : (
        <Text style={[mobileTypography.caption, { color: colors.textSecondary }]}>
          {view.session.detail}
        </Text>
      )}
      {view.retrying === undefined ? null : (
        <Text
          style={[mobileTypography.caption, { color: colors.textSecondary }]}
          testID="mobile-native-harness-retry"
        >
          {harnessRetryStatusText(view.retrying, nowMs)}
        </Text>
      )}
      {pendingApproval === undefined ? null : (
        <View
          style={[styles.question, { borderColor: colors.border }]}
          testID="mobile-native-harness-approval"
        >
          {pendingApproval.source === undefined ? null : (
            <Text style={[mobileTypography.caption, { color: colors.textSecondary }]}>
              Child {String(pendingApproval.source.runId).slice(0, 8)} ·{" "}
              {pendingApproval.source.providerName ?? "Provider"} · {pendingApproval.source.modelId}
            </Text>
          )}
          <Text style={[mobileTypography.body, { color: colors.textPrimary }]}>
            {pendingApproval.toolName} · {pendingApproval.summary.replace(/^[a-z-]+: /, "")}
          </Text>
          <Text style={[mobileTypography.caption, { color: colors.textSecondary }]}>
            {pendingApproval.source === undefined
              ? MOBILE_COPY.approvalAskedPlain
              : MOBILE_COPY.approvalChildAsked}
          </Text>
          {pendingApproval.outsideContent === undefined ? null : (
            <OutsideContentNote outsideContent={pendingApproval.outsideContent} />
          )}
          {listedHosts === undefined ? null : (
            <>
              <Text style={[mobileTypography.caption, { color: colors.textSecondary }]}>
                {listedHosts.length === 0
                  ? "This command can reach no host: this thread and its Project allow none."
                  : "This command can reach only the hosts you select, and only while it runs."}
              </Text>
              {listedHosts.length === 0 ? null : (
                <View style={styles.chips} testID="mobile-native-harness-command-hosts">
                  {listedHosts.map((entry) => {
                    const key = hostKey(entry);
                    return (
                      <GlassChip
                        active={ticked.has(key)}
                        key={key}
                        label={entry.port === 443 ? entry.host : key}
                        onPress={() => toggleHost(key)}
                      />
                    );
                  })}
                </View>
              )}
            </>
          )}
          {/* A child request is never remembered, and neither is a call after
              the thread took in outside content. Offering the session choice
              there would describe a decision the host ignores. */}
          <ApprovalDecisionButtons
            busy={busy}
            onAllow={() => decide("approve")}
            onAllowSession={
              pendingApproval.source === undefined && pendingApproval.singleUse !== true
                ? () => decide("approve-always")
                : undefined
            }
            onDeny={() => decide("deny")}
          />
        </View>
      )}
      {pendingQuestion === undefined ? null : (
        <View
          style={[styles.question, { borderColor: colors.border }]}
          testID="mobile-native-harness-question"
        >
          <Text style={[mobileTypography.body, { color: colors.textPrimary }]}>
            {pendingQuestion.prompt}
          </Text>
          {pendingQuestion.options.length === 0 ? null : (
            <View style={styles.chips}>
              {pendingQuestion.options.map((option) => (
                <GlassChip
                  active={false}
                  key={option}
                  label={option}
                  onPress={() => sendAnswer(option)}
                />
              ))}
            </View>
          )}
          <View style={styles.row}>
            <TextInput
              accessibilityLabel="Answer"
              onChangeText={setAnswer}
              onSubmitEditing={() => sendAnswer(answer)}
              placeholder="Type an answer"
              placeholderTextColor={colors.textSecondary}
              style={[styles.input, { color: colors.textPrimary, borderColor: colors.border }]}
              value={answer}
            />
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              hitSlop={8}
              onPress={() => sendAnswer(answer)}
              style={[styles.button, { backgroundColor: colors.send }]}
              testID="mobile-native-harness-answer"
            >
              <Text style={[mobileTypography.section, { color: colors.sendLabel }]}>Send</Text>
            </Pressable>
          </View>
        </View>
      )}
      {(view.tasks ?? []).map((task, index) => (
        <Text
          key={index}
          style={[mobileTypography.caption, { color: colors.textSecondary }]}
          testID="mobile-native-harness-task"
        >
          {nativeHarnessTaskLabel(task.status)}: {task.title}
        </Text>
      ))}
      {lastRoute === undefined ? null : (
        <Text style={[mobileTypography.caption, { color: colors.textSecondary }]}>
          {lastRoute.job} →{" "}
          {lastRoute.kind === "inherited-parent" ? "parent" : String(lastRoute.slotId)}:{" "}
          {lastRoute.kind}
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
                void run(async () => {
                  const result = await previewMobileNativeHarnessFollowUp({
                    transport: props.transport,
                    threadId: props.threadId,
                    suggestionId: String(suggestion.id),
                  });
                  setPreview(result);
                  return result === undefined
                    ? "The host could not preview this follow-up."
                    : undefined;
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
              disabled={busy}
              hitSlop={8}
              onPress={() => {
                if (view.followUps === undefined) return;
                const followUps = view.followUps;
                void run(async () => {
                  const result = await activateMobileNativeHarnessFollowUp({
                    transport: props.transport,
                    threadId: props.threadId,
                    turnId: String(followUps.turnId),
                    suggestionId: String(preview.suggestion.id),
                  });
                  if (result?.kind !== "follow-up-activated") {
                    return result?.message ?? "The host did not activate this follow-up.";
                  }
                  // No composer to seed from here: the prompt rides the clipboard.
                  void Clipboard.setStringAsync(preview.suggestion.prompt).catch(() => undefined);
                  const created = result.created;
                  setPreview(undefined);
                  return created.kind === "same-thread"
                    ? "Activated. The prompt is on your clipboard for this thread."
                    : created.threadId === undefined
                      ? "Activated."
                      : `Created "${created.title}". The prompt is on your clipboard; paste it there.`;
                });
              }}
              style={[styles.button, { backgroundColor: colors.send }]}
              testID="mobile-native-harness-confirm"
            >
              <Text style={[mobileTypography.section, { color: colors.sendLabel }]}>Confirm</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              hitSlop={8}
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
      {resource.error === undefined ? null : (
        <Text
          style={[mobileTypography.caption, { color: colors.textSecondary }]}
          testID="mobile-native-harness-reconnecting"
        >
          {MOBILE_COPY.approvalReconnecting}
        </Text>
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
  question: {
    gap: mobileSpacing.xs,
    padding: mobileSpacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
  },
  input: {
    flex: 1,
    paddingHorizontal: mobileSpacing.sm,
    paddingVertical: mobileSpacing.xs,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
  },
});
