import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import {
  setMobileThreadRest,
  type MobileInboxRow,
  type MobileRemoteTransport,
  type MobileThreadRestAction,
} from "@octant/client-runtime";
import {
  decideCompleteThread,
  decideSnoozeThread,
  resolveSnoozePresets,
  type RestingThreadLifecycle,
} from "@octant/domain/thread-completion-policy";
import { space, typography, useTheme } from "../../design-system";
import { formatScreenshotSafeLabel } from "../security/screenshotSafeLabel";
import { BottomSheet } from "../ui/BottomSheet";
import { ListNote, ListRow, ListSection } from "../ui/NativeChrome";
import { mobileThreadShelf } from "./threadArrangement";

const REFUSAL: Readonly<Record<string, string>> = {
  archived: "This thread is archived.",
  executing: "A turn is running. Put it away when it finishes.",
  "awaiting-input": "The agent is waiting on you. Answer it first.",
  "wake-time-not-in-future": "Pick a later time.",
};

/**
 * A thread row's actions on the phone: the desktop row menu's Snooze, Wake,
 * Put away, Reopen, and (Code only) Pin. Each option the host would refuse is
 * shown with the reason instead of being offered.
 */
export function ThreadRowActionsSheet(props: {
  readonly row: MobileInboxRow | undefined;
  readonly transport: MobileRemoteTransport | undefined;
  readonly onClose: () => void;
  readonly onChanged: () => void;
}) {
  const { colors } = useTheme();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  const row = props.row;
  const now = new Date();
  const lifecycle = (row?.status ?? "active") as RestingThreadLifecycle;
  const signals = {
    executing: row?.live === "working",
    awaitingInput: row?.live === "needs-input",
  };
  const shelf = row === undefined ? "active" : mobileThreadShelf(row, now);
  const complete = decideCompleteThread({ ...signals, lifecycle });
  const snoozeAllowed = decideSnoozeThread({
    lifecycle,
    awaitingInput: signals.awaitingInput,
    until: new Date(now.getTime() + 3_600_000).toISOString(),
    now: now.toISOString(),
  });

  const run = async (action: MobileThreadRestAction) => {
    if (row === undefined || props.transport === undefined) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await setMobileThreadRest({ transport: props.transport, row, action });
      if (result.status === "refused") {
        setMessage(result.message);
        return;
      }
      props.onChanged();
      props.onClose();
    } catch {
      setMessage("The host could not be reached. Nothing changed.");
    } finally {
      setBusy(false);
    }
  };
  const styles = StyleSheet.create({
    message: {
      color: colors.danger,
      fontSize: typography.detail.fontSize,
      paddingHorizontal: space.md,
      paddingBottom: space.sm,
    },
    body: { paddingBottom: space.lg },
  });

  return (
    <BottomSheet
      onClose={props.onClose}
      testID="mobile-thread-row-actions"
      title={row === undefined ? "" : formatScreenshotSafeLabel(row.title)}
      visible={row !== undefined}
    >
      <View style={styles.body}>
        {message === undefined ? null : <Text style={styles.message}>{message}</Text>}
        {row?.snooze !== undefined && shelf === "snoozed" ? (
          <ListSection>
            <ListRow
              icon="alarm-outline"
              label="Wake now"
              last
              onPress={busy ? undefined : () => void run({ kind: "wake" })}
              testID="mobile-thread-action-wake"
            />
          </ListSection>
        ) : (
          <ListSection title="Snooze">
            {snoozeAllowed.status === "refused" ? (
              <ListNote
                last
                text={REFUSAL[snoozeAllowed.reason] ?? "This thread cannot be snoozed."}
                tone={colors.textSecondary}
              />
            ) : (
              resolveSnoozePresets(now).map((preset, index, all) => (
                <ListRow
                  icon="time-outline"
                  key={preset.id}
                  label={preset.label}
                  last={index === all.length - 1}
                  onPress={
                    busy ? undefined : () => void run({ kind: "snooze", until: preset.until })
                  }
                  testID={`mobile-thread-action-snooze-${preset.id}`}
                  value={preset.whenLabel}
                />
              ))
            )}
          </ListSection>
        )}
        <ListSection>
          {shelf === "completed" ? (
            <ListRow
              icon="arrow-undo-outline"
              label="Reopen"
              last={row?.mode !== "code"}
              onPress={busy ? undefined : () => void run({ kind: "reopen" })}
              testID="mobile-thread-action-reopen"
            />
          ) : complete.status === "refused" ? (
            <ListRow
              detail={REFUSAL[complete.reason]}
              icon="checkmark-done-outline"
              label="Put away"
              last={row?.mode !== "code"}
              testID="mobile-thread-action-put-away"
            />
          ) : (
            <ListRow
              icon="checkmark-done-outline"
              label="Put away"
              last={row?.mode !== "code"}
              onPress={busy ? undefined : () => void run({ kind: "put-away" })}
              testID="mobile-thread-action-put-away"
            />
          )}
          {row?.mode === "code" ? (
            <ListRow
              icon={row.pinned === true ? "pin" : "pin-outline"}
              label={row.pinned === true ? "Unpin" : "Pin"}
              last
              onPress={
                busy ? undefined : () => void run({ kind: "pin", pinned: row.pinned !== true })
              }
              testID="mobile-thread-action-pin"
            />
          ) : null}
        </ListSection>
      </View>
    </BottomSheet>
  );
}
