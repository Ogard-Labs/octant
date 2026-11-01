import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  mobileRewindScopes,
  type MobileRewindFiles,
  type MobileRewindScope,
} from "@octant/client-runtime";
import { MOBILE_COPY } from "../copy";
import { mobileSpacing, mobileTypography } from "../theme/tokens";
import { radii, useTheme } from "../../design-system";
import { BottomSheet } from "./BottomSheet";

export type RewindSheetFiles = MobileRewindFiles | { readonly kind: "loading" };

export interface RewindSheetProps {
  readonly visible: boolean;
  readonly onClose: () => void;
  /** Turns the rewind removes; undefined while the host is asked. */
  readonly removedTurns: number | undefined;
  readonly files: RewindSheetFiles;
  /** How the conversation continues after it, when the host said. */
  readonly rollback?: "native" | "handoff";
  readonly busy: boolean;
  /** Why the preview or the rewind did not go through. */
  readonly message?: string;
  readonly onRewind: (scope: MobileRewindScope) => void;
}

const SCOPE_LABEL: Readonly<Record<MobileRewindScope, string>> = {
  both: MOBILE_COPY.rewindScopeBoth,
  conversation: MOBILE_COPY.rewindScopeConversation,
  files: MOBILE_COPY.rewindScopeFiles,
};

/** How many changed paths the sheet lists before it says "and N more". */
const LISTED_PATHS = 8;

/**
 * The one question before a rewind, as on the desktop: what leaves the
 * conversation and which files would be overwritten, before anything changes.
 * Files that cannot come back leave the conversation as the only choice, with
 * the reason beside it.
 */
export function RewindSheet(props: RewindSheetProps) {
  const { colors } = useTheme();
  const files = props.files;
  const scopes = files.kind === "loading" ? (["conversation"] as const) : mobileRewindScopes(files);
  const [scope, setScope] = useState<MobileRewindScope>("both");
  useEffect(() => {
    if (props.visible) setScope("both");
  }, [props.visible]);
  const chosen = scopes.includes(scope) ? scope : "conversation";
  const ready = props.removedTurns !== undefined && files.kind !== "loading";
  const takesFiles = chosen !== "conversation";
  const takesConversation = chosen !== "files";
  const styles = useMemo(
    () =>
      StyleSheet.create({
        body: { paddingHorizontal: mobileSpacing.md, gap: mobileSpacing.sm },
        text: {
          color: colors.textSecondary,
          fontSize: mobileTypography.body.fontSize,
          lineHeight: 20,
        },
        meta: { color: colors.textTertiary, fontSize: 12, lineHeight: 16 },
        section: {
          color: colors.textPrimary,
          fontSize: mobileTypography.caption.fontSize,
          fontWeight: "600",
        },
        path: { color: colors.textPrimary, fontSize: 13, lineHeight: 18 },
        error: { color: colors.danger, fontSize: 13, lineHeight: 18 },
        scopes: { flexDirection: "row", flexWrap: "wrap", gap: mobileSpacing.xs },
        scope: {
          paddingVertical: 8,
          paddingHorizontal: 12,
          borderRadius: radii.pill,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.glassStroke,
        },
        scopeOn: { backgroundColor: colors.send, borderColor: colors.send },
        scopeLabel: { color: colors.textPrimary, fontSize: 13, fontWeight: "500" },
        scopeLabelOn: { color: colors.sendLabel },
        actions: {
          flexDirection: "row",
          justifyContent: "flex-end",
          gap: mobileSpacing.sm,
          paddingTop: mobileSpacing.sm,
        },
        button: {
          paddingVertical: 10,
          paddingHorizontal: 16,
          borderRadius: radii.pill,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.glassStroke,
        },
        danger: { borderColor: colors.danger },
        buttonLabel: { color: colors.textPrimary, fontWeight: "600", fontSize: 14 },
        dangerLabel: { color: colors.danger },
        disabled: { opacity: 0.5 },
      }),
    [colors],
  );
  const removed = props.removedTurns;
  return (
    <BottomSheet
      onClose={() => {
        if (!props.busy) props.onClose();
      }}
      testID="mobile-rewind-sheet"
      title={MOBILE_COPY.rewindSheetTitle}
      visible={props.visible}
    >
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.text} testID="mobile-rewind-detail">
          {removed === undefined
            ? MOBILE_COPY.rewindReading
            : `This removes ${removed === 1 ? "this message and its reply" : `this message and the ${removed - 1} after it`} from the conversation. ${MOBILE_COPY.rewindComposerNote}`}
        </Text>
        {scopes.length > 1 ? (
          <View accessibilityRole="radiogroup" style={styles.scopes}>
            {scopes.map((candidate) => (
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ selected: candidate === chosen }}
                key={candidate}
                onPress={() => setScope(candidate)}
                style={[styles.scope, candidate === chosen ? styles.scopeOn : null]}
                testID={`mobile-rewind-scope-${candidate}`}
              >
                <Text
                  style={[styles.scopeLabel, candidate === chosen ? styles.scopeLabelOn : null]}
                >
                  {SCOPE_LABEL[candidate]}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        <Text style={styles.section}>{MOBILE_COPY.rewindFilesTitle}</Text>
        {files.kind === "loading" ? (
          <Text style={styles.text}>{MOBILE_COPY.rewindFilesComparing}</Text>
        ) : files.kind === "unchanged" ? (
          <Text style={styles.text}>{MOBILE_COPY.rewindFilesUnchanged}</Text>
        ) : files.kind === "unavailable" ? (
          <Text style={styles.text} testID="mobile-rewind-files-reason">
            {files.reason}
          </Text>
        ) : takesFiles ? (
          <>
            <Text style={styles.text}>
              {files.total === 1
                ? "This file goes back to how it was before this message:"
                : `These ${files.total} files go back to how they were before this message:`}
            </Text>
            {files.paths.slice(0, LISTED_PATHS).map((path) => (
              <Text key={path} style={styles.path}>
                {path}
              </Text>
            ))}
            {files.total > Math.min(files.paths.length, LISTED_PATHS) ? (
              <Text style={styles.meta}>
                and {files.total - Math.min(files.paths.length, LISTED_PATHS)} more
              </Text>
            ) : null}
            <Text style={styles.meta}>{MOBILE_COPY.rewindUndoNote}</Text>
          </>
        ) : (
          <Text style={styles.text}>{MOBILE_COPY.rewindFilesStay}</Text>
        )}
        {takesConversation && props.rollback !== undefined ? (
          <Text style={styles.meta}>
            {props.rollback === "native"
              ? MOBILE_COPY.rewindNativeNote
              : MOBILE_COPY.rewindHandoffNote}
          </Text>
        ) : null}
        {props.message === undefined ? null : (
          <Text accessibilityRole="alert" style={styles.error} testID="mobile-rewind-message">
            {props.message}
          </Text>
        )}
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            disabled={props.busy}
            onPress={props.onClose}
            style={[styles.button, props.busy ? styles.disabled : null]}
            testID="mobile-rewind-cancel"
          >
            <Text style={styles.buttonLabel}>{MOBILE_COPY.rewindCancel}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={props.busy || !ready}
            onPress={() => props.onRewind(chosen)}
            style={[styles.button, styles.danger, props.busy || !ready ? styles.disabled : null]}
            testID="mobile-rewind-confirm"
          >
            <Text style={[styles.buttonLabel, styles.dangerLabel]}>
              {props.busy
                ? MOBILE_COPY.rewindBusy
                : takesFiles
                  ? MOBILE_COPY.rewindConfirmFiles
                  : MOBILE_COPY.rewindConfirm}
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </BottomSheet>
  );
}
