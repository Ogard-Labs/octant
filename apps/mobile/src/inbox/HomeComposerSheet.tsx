import { useMemo, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Icon } from "../ui/Icon";
import { radii, space, typography, useTheme } from "../../design-system";
import { MOBILE_COPY } from "../copy";
import { BottomSheet } from "../ui/BottomSheet";
import { ChoicePill } from "../ui/ChoicePill";
import { ComposerSurface } from "../ui/ComposerSurface";
import { hapticSend } from "../ui/haptics";
import { hasProviderMark, ProviderMark } from "../ui/ProviderMark";
import { SegmentedControl } from "../ui/SegmentedControl";
import { ComposerVoiceButton } from "../ui/ComposerVoiceButton";
import { IconButton, type MobileIconName } from "../ui/IconButton";
import type { ComposerVoice } from "../voice/useVoiceDictation";
import type { MobileCreateMode } from "./createModePresentation";

const MOBILE_CREATE_MODES: ReadonlyArray<{
  readonly id: MobileCreateMode;
  readonly label: string;
  readonly icon: MobileIconName;
}> = [
  { id: "chat", label: "No folder", icon: "chatbubble-outline" },
  { id: "work", label: "In a folder", icon: "folder-outline" },
  { id: "code", label: "Code", icon: "code-slash" },
];

// The question is large already, and shares what the keyboard leaves with the
// message, which follows the system size as far as it goes.
const BAR_TEXT_SCALE = 1.2;
const QUESTION_TEXT_SCALE = 1.3;

function placeholderFor(mode: MobileCreateMode): string {
  if (mode === "work") return MOBILE_COPY.composerWork;
  if (mode === "code") return MOBILE_COPY.composerCode;
  return MOBILE_COPY.composerHome;
}

export function HomeComposerSheet(props: {
  readonly visible: boolean;
  readonly mode: MobileCreateMode;
  readonly prompt: string;
  readonly modelLabel: string;
  readonly modelDriverKind?: string | undefined;
  readonly placementLabel?: string | undefined;
  readonly projectLabel?: string | undefined;
  readonly busy?: boolean;
  readonly editable?: boolean;
  readonly error?: string | undefined;
  /** The Projects this computer offers the chosen mode; a Chat has none. */
  readonly projects?: ReadonlyArray<{ readonly id: string; readonly label: string }> | undefined;
  /** The paired computers a new thread may go to. */
  readonly hosts?: ReadonlyArray<{ readonly id: string; readonly label: string }> | undefined;
  readonly selectedHostId?: string | undefined;
  readonly onSelectHost?: ((hostId: string) => void) | undefined;
  readonly selectedProjectId?: string | undefined;
  readonly onSelectProject?: ((projectId: string) => void) | undefined;
  readonly onChangePrompt: (value: string) => void;
  readonly onClose: () => void;
  readonly onPressModel: () => void;
  readonly onSelectMode: (mode: MobileCreateMode) => void;
  readonly onSubmit: () => void;
  readonly placementDisabledReason?: string | undefined;
  readonly onRefreshHost?: (() => void) | undefined;
  /** Dictation through the host; absent while the host is not ready for it. */
  readonly voice?: ComposerVoice | undefined;
  /** Where the draft came from ("From to-do"); removing it leaves an ordinary draft. */
  readonly sourceLabel?: string | undefined;
  readonly onRemoveSource?: (() => void) | undefined;
  /** Sheets shown over this one, which the system stacks only from inside it. */
  readonly over?: ReactNode;
}) {
  const { colors } = useTheme();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        content: {
          minHeight: 420,
          paddingHorizontal: space.md,
          paddingBottom: space.sm,
          gap: space.sm,
        },
        header: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 12 },
        headerTitle: {
          color: colors.textPrimary,
          fontSize: 20,
          fontWeight: "700",
          letterSpacing: -0.3,
        },
        question: {
          flex: 1,
          overflow: "hidden",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
        },
        headline: {
          color: colors.textPrimary,
          fontSize: 24,
          fontWeight: "600",
          letterSpacing: -0.3,
          textAlign: "center",
        },
        contextText: {
          flexShrink: 1,
          color: colors.textSecondary,
          fontSize: typography.detail.fontSize,
        },
        notice: { alignItems: "center", gap: 4, paddingTop: space.sm },
        source: { flexDirection: "row", alignItems: "center", gap: 6 },
        composer: {
          flexDirection: "row",
          alignItems: "flex-end",
          gap: 2,
          paddingLeft: 14,
          paddingRight: 6,
          paddingVertical: 6,
        },
        input: {
          flex: 1,
          minHeight: 24,
          maxHeight: 160,
          marginVertical: 5,
          color: colors.textPrimary,
          fontSize: 17,
          lineHeight: 23,
          paddingVertical: 0,
          textAlignVertical: "top",
          outlineColor: "transparent",
          outlineStyle: "solid",
          outlineWidth: 0,
        },
        disabled: { opacity: 0.45 },
        placementReason: {
          color: colors.textSecondary,
          fontSize: typography.caption.fontSize,
          lineHeight: 18,
        },
        refresh: {
          color: colors.accent,
          fontSize: typography.caption.fontSize,
          fontWeight: "500",
        },
        error: { color: colors.danger, fontSize: typography.caption.fontSize, lineHeight: 18 },
        model: {
          height: 34,
          maxWidth: 120,
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          paddingHorizontal: 8,
          borderRadius: radii.pill,
        },
        modelPressed: { backgroundColor: colors.controlPressed },
        modelText: {
          flexShrink: 1,
          color: colors.textPrimary,
          fontSize: typography.detail.fontSize,
          fontWeight: "500",
        },
      }),
    [colors],
  );

  const editable = props.editable !== false && props.busy !== true;
  const canSubmit = editable && props.prompt.trim().length > 0;
  const projectLabel =
    props.mode === "chat" ? MOBILE_COPY.newConversation : (props.projectLabel ?? "Choose on host");

  const choices = props.projects ?? [];
  const hosts = props.hosts ?? [];
  return (
    <BottomSheet
      contentStyle={styles.content}
      headerVisible={false}
      onClose={props.onClose}
      size="full"
      testID="mobile-home-composer-sheet"
      title={MOBILE_COPY.newThread}
      visible={props.visible}
    >
      <View style={styles.header}>
        <IconButton
          accessibilityLabel="Cancel"
          iconSize={18}
          name="close"
          onPress={props.onClose}
          size={40}
          testID="mobile-home-composer-cancel"
        />
        <Text
          accessibilityRole="header"
          maxFontSizeMultiplier={BAR_TEXT_SCALE}
          style={styles.headerTitle}
        >
          {MOBILE_COPY.newThread}
        </Text>
      </View>

      <View style={styles.question} testID="mobile-home-composer-context">
        {props.mode === "chat" ? (
          <Text
            accessibilityLabel={projectLabel}
            maxFontSizeMultiplier={QUESTION_TEXT_SCALE}
            style={styles.headline}
            testID="mobile-home-composer-project-label"
          >
            {projectLabel}
          </Text>
        ) : (
          <>
            <Text maxFontSizeMultiplier={QUESTION_TEXT_SCALE} style={styles.headline}>
              {props.mode === "code" ? MOBILE_COPY.newCodeQuestion : MOBILE_COPY.newWorkQuestion}
            </Text>
            {choices.length === 0 || props.selectedProjectId === undefined ? (
              <Text
                maxFontSizeMultiplier={QUESTION_TEXT_SCALE}
                style={styles.headline}
                testID="mobile-home-composer-project-label"
              >
                {projectLabel}
              </Text>
            ) : (
              <ChoicePill
                look="title"
                onSelect={(id) => props.onSelectProject?.(id)}
                options={choices}
                selected={props.selectedProjectId}
                testID="mobile-home-composer-project-label"
                title={MOBILE_COPY.projects}
              />
            )}
          </>
        )}
        {hosts.length > 1 && props.selectedHostId !== undefined ? (
          <ChoicePill
            look="quiet"
            onSelect={(id) => props.onSelectHost?.(id)}
            options={hosts}
            selected={props.selectedHostId}
            testID="mobile-home-composer-host-label"
            title={MOBILE_COPY.workspaces}
          />
        ) : (
          <Text
            accessibilityLabel={props.placementLabel ?? "No host"}
            numberOfLines={1}
            style={styles.contextText}
            testID="mobile-home-composer-host-label"
          >
            {props.placementLabel ?? "No host"}
          </Text>
        )}
        {props.placementDisabledReason === undefined ? null : (
          <View style={styles.notice}>
            <Text selectable style={styles.placementReason}>
              {props.placementDisabledReason}
            </Text>
            {props.onRefreshHost === undefined ? null : (
              <Pressable onPress={props.onRefreshHost} testID="mobile-home-composer-refresh-host">
                <Text style={styles.refresh}>Refresh host</Text>
              </Pressable>
            )}
          </View>
        )}
      </View>

      {props.sourceLabel === undefined ? null : (
        <View style={styles.source} testID="mobile-home-composer-source">
          <Icon color={colors.textTertiary} name="checkmark-circle-outline" size={16} />
          <Text numberOfLines={1} style={styles.contextText}>
            {props.sourceLabel}
          </Text>
          {props.onRemoveSource === undefined ? null : (
            <Pressable
              accessibilityLabel={`Remove ${props.sourceLabel}`}
              accessibilityRole="button"
              hitSlop={10}
              onPress={props.onRemoveSource}
              testID="mobile-home-composer-source-remove"
            >
              <Icon color={colors.textTertiary} name="close-circle" size={16} />
            </Pressable>
          )}
        </View>
      )}
      {props.error === undefined ? null : (
        <Text selectable style={styles.error}>
          {props.error}
        </Text>
      )}
      {/* The sheet is a modal over the thread's composer, so a dictation
          refusal (microphone denied, allowance used) must be said here too. */}
      {props.voice?.notice === undefined ? null : (
        <Text style={styles.placementReason} testID="mobile-home-composer-voice-notice">
          {props.voice.notice}
        </Text>
      )}

      <SegmentedControl
        onSelect={props.onSelectMode}
        optionTestID={(id) => `mobile-home-composer-mode-${id}`}
        options={MOBILE_CREATE_MODES}
        selected={props.mode}
      />
      <ComposerSurface contentStyle={styles.composer}>
        <TextInput
          autoFocus
          editable={editable}
          multiline
          onChangeText={props.onChangePrompt}
          placeholder={placeholderFor(props.mode)}
          placeholderTextColor={colors.textTertiary}
          style={[styles.input, !editable ? styles.disabled : null]}
          testID="mobile-home-composer-input"
          value={props.prompt}
        />
        <Pressable
          accessibilityLabel={`Choose model, ${props.modelLabel}`}
          accessibilityRole="button"
          hitSlop={6}
          onPress={props.onPressModel}
          style={({ pressed }) => [styles.model, pressed ? styles.modelPressed : null]}
          testID="mobile-home-composer-model"
        >
          {props.modelDriverKind !== undefined && hasProviderMark(props.modelDriverKind) ? (
            <ProviderMark driverKind={props.modelDriverKind} size={18} />
          ) : (
            <Text maxFontSizeMultiplier={1.3} numberOfLines={1} style={styles.modelText}>
              {props.modelLabel}
            </Text>
          )}
          <Icon color={colors.textSecondary} name="chevron-down" size={12} />
        </Pressable>
        {props.voice === undefined ? null : <ComposerVoiceButton size={34} voice={props.voice} />}
        <IconButton
          accessibilityLabel={props.busy === true ? "Creating" : "Send"}
          disabled={!canSubmit}
          iconSize={18}
          name={props.busy === true ? "hourglass-outline" : "arrow-up"}
          onPress={() => {
            hapticSend();
            props.onSubmit();
          }}
          size={34}
          testID="mobile-home-composer-submit"
          variant="send"
        />
      </ComposerSurface>
      {props.over}
    </BottomSheet>
  );
}
