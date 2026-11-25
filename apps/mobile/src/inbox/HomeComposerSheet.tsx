import { useMemo } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { radii, space, typography, useTheme } from "../../design-system";
import { MOBILE_COPY } from "../copy";
import { BottomSheet } from "../ui/BottomSheet";
import { SegmentedControl } from "../ui/NativeChrome";
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
  readonly placementLabel?: string | undefined;
  readonly projectLabel?: string | undefined;
  readonly busy?: boolean;
  readonly editable?: boolean;
  readonly error?: string | undefined;
  /** The Projects this computer offers the chosen mode; a Chat has none. */
  readonly projects?: ReadonlyArray<{ readonly id: string; readonly label: string }> | undefined;
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
}) {
  const { colors } = useTheme();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        sheet: {
          marginHorizontal: space.sm,
          marginBottom: process.env.EXPO_OS === "web" ? 48 : space.sm,
          borderBottomLeftRadius: radii.composer,
          borderBottomRightRadius: radii.composer,
        },
        content: {
          minHeight: 380,
          paddingHorizontal: space.md,
          paddingBottom: space.md,
          gap: space.md,
        },
        header: { minHeight: 44, flexDirection: "row", alignItems: "center" },
        cancel: { flex: 1 },
        cancelLabel: { color: colors.accent, fontSize: 17 },
        headerTitle: {
          color: colors.textPrimary,
          fontSize: typography.pageTitle.fontSize,
          fontWeight: typography.pageTitle.fontWeight,
          letterSpacing: typography.pageTitle.letterSpacing,
        },
        headerEnd: { flex: 1, alignItems: "flex-end" },
        context: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm },
        contextItem: {
          flexDirection: "row",
          alignItems: "center",
          gap: 5,
          minWidth: 0,
          maxWidth: "100%",
          flexShrink: 1,
        },
        contextText: {
          minWidth: 0,
          flexShrink: 1,
          color: colors.textSecondary,
          fontSize: typography.caption.fontSize,
          fontWeight: "500",
        },
        input: {
          flex: 1,
          minHeight: 120,
          color: colors.textPrimary,
          fontSize: 17,
          lineHeight: 23,
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
        toolbar: { flexDirection: "row", alignItems: "center", gap: space.sm },
        model: {
          flexShrink: 1,
          height: 32,
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          paddingHorizontal: 12,
          borderRadius: radii.pill,
          backgroundColor: colors.control,
        },
        modelPressed: { backgroundColor: colors.controlPressed },
        modelText: {
          flexShrink: 1,
          color: colors.textPrimary,
          fontSize: typography.detail.fontSize,
          fontWeight: "500",
        },
        spacer: { flex: 1 },
        projectScroll: { flexGrow: 0 },
        projects: { gap: space.sm },
        project: {
          height: 32,
          justifyContent: "center",
          paddingHorizontal: 12,
          borderRadius: radii.pill,
          backgroundColor: colors.control,
        },
        projectSelected: { backgroundColor: colors.accent },
        projectName: {
          color: colors.textPrimary,
          fontSize: typography.detail.fontSize,
          fontWeight: "500",
        },
        projectNameSelected: { color: colors.sendLabel },
      }),
    [colors],
  );

  const editable = props.editable !== false && props.busy !== true;
  const canSubmit = editable && props.prompt.trim().length > 0;
  const projectLabel =
    props.mode === "chat" ? "New conversation" : (props.projectLabel ?? "Choose on host");

  return (
    <BottomSheet
      contentStyle={styles.content}
      headerVisible={false}
      onClose={props.onClose}
      sheetStyle={styles.sheet}
      testID="mobile-home-composer-sheet"
      title="New thread"
      visible={props.visible}
    >
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          hitSlop={8}
          onPress={props.onClose}
          style={styles.cancel}
          testID="mobile-home-composer-cancel"
        >
          <Text style={styles.cancelLabel}>Cancel</Text>
        </Pressable>
        <Text accessibilityRole="header" style={styles.headerTitle}>
          New thread
        </Text>
        <View style={styles.headerEnd}>
          <IconButton
            accessibilityLabel={props.busy === true ? "Creating" : "Send"}
            disabled={!canSubmit}
            iconSize={18}
            name={props.busy === true ? "hourglass-outline" : "arrow-up"}
            onPress={props.onSubmit}
            size={32}
            testID="mobile-home-composer-submit"
            variant="send"
          />
        </View>
      </View>

      <SegmentedControl
        onSelect={props.onSelectMode}
        optionTestID={(id) => `mobile-home-composer-mode-${id}`}
        options={MOBILE_CREATE_MODES}
        selected={props.mode}
      />

      <View style={styles.context} testID="mobile-home-composer-context">
        <View style={styles.contextItem}>
          <Ionicons
            color={colors.textTertiary}
            name={
              props.mode === "code"
                ? "git-branch-outline"
                : props.mode === "work"
                  ? "briefcase-outline"
                  : "chatbubble-outline"
            }
            size={16}
          />
          <Text
            accessibilityLabel={projectLabel}
            numberOfLines={1}
            style={styles.contextText}
            testID="mobile-home-composer-project-label"
          >
            {projectLabel}
          </Text>
        </View>
        <View style={styles.contextItem}>
          <Ionicons color={colors.textTertiary} name="cloud-outline" size={16} />
          <Text
            accessibilityLabel={props.placementLabel ?? "No host"}
            numberOfLines={1}
            style={styles.contextText}
            testID="mobile-home-composer-host-label"
          >
            {props.placementLabel ?? "No host"}
          </Text>
        </View>
      </View>

      {props.projects === undefined || props.projects.length === 0 ? null : (
        <ScrollView
          contentContainerStyle={styles.projects}
          horizontal
          keyboardShouldPersistTaps="handled"
          showsHorizontalScrollIndicator={false}
          style={styles.projectScroll}
        >
          {props.projects.map((project) => {
            const selected = project.id === props.selectedProjectId;
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected }}
                key={project.id}
                onPress={() => props.onSelectProject?.(project.id)}
                style={[styles.project, selected ? styles.projectSelected : null]}
                testID={`mobile-home-project-${project.id}`}
              >
                <Text style={[styles.projectName, selected ? styles.projectNameSelected : null]}>
                  {project.label}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      )}

      {props.sourceLabel === undefined ? null : (
        <View style={styles.context} testID="mobile-home-composer-source">
          <View style={styles.contextItem}>
            <Ionicons color={colors.textTertiary} name="checkmark-circle-outline" size={16} />
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
                <Ionicons color={colors.textTertiary} name="close-circle" size={16} />
              </Pressable>
            )}
          </View>
        </View>
      )}

      {props.placementDisabledReason === undefined ? null : (
        <View>
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

      {props.error === undefined ? null : (
        <Text selectable style={styles.error}>
          {props.error}
        </Text>
      )}
      {/* The sheet is a modal over the floating composer, so a dictation
          refusal (microphone denied, allowance used) must be said here too. */}
      {props.voice?.notice === undefined ? null : (
        <Text style={styles.placementReason} testID="mobile-home-composer-voice-notice">
          {props.voice.notice}
        </Text>
      )}

      <View style={styles.toolbar}>
        <IconButton
          accessibilityLabel="Attachments unavailable"
          disabled
          name="add"
          size={32}
          variant="ghost"
        />
        <Pressable
          accessibilityLabel={`Choose model, ${props.modelLabel}`}
          accessibilityRole="button"
          onPress={props.onPressModel}
          style={({ pressed }) => [styles.model, pressed ? styles.modelPressed : null]}
          testID="mobile-home-composer-model"
        >
          <Text numberOfLines={1} style={styles.modelText}>
            {props.modelLabel}
          </Text>
          <Ionicons color={colors.textSecondary} name="chevron-down" size={13} />
        </Pressable>
        <View style={styles.spacer} />
        {props.voice === undefined ? null : <ComposerVoiceButton size={32} voice={props.voice} />}
      </View>
    </BottomSheet>
  );
}
