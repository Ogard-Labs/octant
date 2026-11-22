import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import {
  importMobileCanvasHtml,
  mobileChatCanvasHtmlImport,
  type MobileRemoteTransport,
} from "@octant/client-runtime";
import { CANVAS_HTML_IMPORT_MAX_BYTES, type CanvasHtmlImportResult } from "@octant/contracts";
import { SegmentedControl } from "../ui/NativeChrome";
import { useTheme } from "../../design-system";
import { MOBILE_COPY } from "../copy";
import { BottomSheet } from "../ui/BottomSheet";
import { mobileSpacing, mobileTypography } from "../theme/tokens";
import { pickHtmlPage, type PickedHtmlPage } from "./pickHtmlPage";
import { importDropLines } from "./projectToolsPresentation";
import { ToolButton } from "./ProjectToolSheets";

type Imported = Extract<CanvasHtmlImportResult, { readonly kind: "imported" }>;
type Source = "file" | "paste";

export interface CanvasHtmlImportSheetProps {
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  /** The Chat thread's Project, or undefined for a thread in none. */
  readonly projectId: string | undefined;
  /** Picks and reads a file; the phone's document picker when absent. */
  readonly pickFile?: () => Promise<PickedHtmlPage>;
}

const TOO_LARGE = MOBILE_COPY.canvasImportTooLarge(CANVAS_HTML_IMPORT_MAX_BYTES / 1024);

/**
 * Brings one HTML page into a new Canvas from a Chat thread, as the paired
 * browser's Import HTML does: a file from the phone or pasted markup, and a
 * title. The host decides everything that matters (the size bound, the frame
 * the page is drawn in, what is taken out, and whether this device may create
 * the Canvas at all) and journals the import as this device; the sheet reads
 * the file and reports back what was removed.
 */
export function CanvasHtmlImportSheet(props: CanvasHtmlImportSheetProps) {
  const { colors } = useTheme();
  const [source, setSource] = useState<Source>("file");
  const [file, setFile] = useState<{ readonly html: string; readonly fileName?: string }>();
  const [pasted, setPasted] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [imported, setImported] = useState<Imported>();

  const reset = () => {
    setFile(undefined);
    setPasted("");
    setTitle("");
    setProblem(undefined);
    setImported(undefined);
  };
  useEffect(() => {
    if (props.visible) reset();
  }, [props.visible, props.threadId]);

  const html = source === "file" ? file?.html : pasted;
  const ready = html !== undefined && html.trim().length > 0;

  const chooseFile = async () => {
    setProblem(undefined);
    try {
      const picked = await (props.pickFile ?? pickHtmlPage)();
      if (picked.status === "too-large") setProblem(TOO_LARGE);
      else if (picked.status === "picked") {
        setFile({
          html: picked.html,
          ...(picked.fileName === undefined ? {} : { fileName: picked.fileName }),
        });
      }
    } catch {
      setProblem(MOBILE_COPY.canvasImportFailed);
    }
  };

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setProblem(undefined);
    try {
      const result = await importMobileCanvasHtml(
        props.transport,
        mobileChatCanvasHtmlImport({
          requestId: globalThis.crypto.randomUUID(),
          threadId: props.threadId,
          projectId: props.projectId,
          source,
          html,
          title,
          fileName: source === "file" ? file?.fileName : undefined,
        }),
      );
      if (result.kind === "imported") setImported(result);
      else setProblem(result.message);
    } catch {
      setProblem(MOBILE_COPY.canvasImportFailed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <BottomSheet
      onClose={props.onClose}
      sheetStyle={styles.sheet}
      testID="mobile-canvas-import"
      title={MOBILE_COPY.canvasImportTitle}
      visible={props.visible}
    >
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {imported !== undefined ? (
          <View style={styles.result} testID="mobile-canvas-import-result">
            <Text style={[mobileTypography.section, { color: colors.textPrimary }]}>
              {MOBILE_COPY.canvasImportReady(imported.card.title)}
            </Text>
            <Text style={[mobileTypography.body, { color: colors.textPrimary }]}>
              {imported.frame === "running"
                ? MOBILE_COPY.canvasImportRunning
                : MOBILE_COPY.canvasImportStatic}
            </Text>
            <Text style={[mobileTypography.caption, { color: colors.textSecondary }]}>
              {imported.dropped.length === 0
                ? MOBILE_COPY.canvasImportNothingTaken
                : MOBILE_COPY.canvasImportTakenOut}
            </Text>
            {importDropLines(imported.dropped).map((line) => (
              <Text
                key={line}
                style={[mobileTypography.caption, { color: colors.textSecondary }]}
              >{`• ${line}`}</Text>
            ))}
            <ToolButton
              label={MOBILE_COPY.canvasImportAnother}
              onPress={reset}
              testID="mobile-canvas-import-another"
            />
          </View>
        ) : (
          <>
            <Text style={[mobileTypography.caption, { color: colors.textSecondary }]}>
              {MOBILE_COPY.canvasImportHelp}
            </Text>
            <SegmentedControl
              onSelect={setSource}
              optionTestID={(id) => `mobile-canvas-import-source-${id}`}
              options={[
                { id: "file", label: MOBILE_COPY.canvasImportFromFile },
                { id: "paste", label: MOBILE_COPY.canvasImportFromPaste },
              ]}
              selected={source}
              testID="mobile-canvas-import-source"
            />
            {source === "file" ? (
              <View style={styles.row}>
                <ToolButton
                  disabled={busy}
                  label={MOBILE_COPY.canvasImportChooseFile}
                  onPress={() => void chooseFile()}
                  testID="mobile-canvas-import-choose"
                />
                {file === undefined ? null : (
                  <Text
                    numberOfLines={1}
                    style={[styles.grow, mobileTypography.caption, { color: colors.textSecondary }]}
                  >
                    {file.fileName ?? MOBILE_COPY.canvasImportFromFile}
                  </Text>
                )}
              </View>
            ) : (
              <TextInput
                accessibilityLabel={MOBILE_COPY.canvasImportPasteLabel}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!busy}
                multiline
                onChangeText={setPasted}
                placeholder="<!doctype html>…"
                placeholderTextColor={colors.textSecondary}
                spellCheck={false}
                style={[
                  styles.input,
                  styles.paste,
                  mobileTypography.mono,
                  {
                    color: colors.textPrimary,
                    borderColor: colors.hairlineStrong,
                    backgroundColor: colors.control,
                  },
                ]}
                testID="mobile-canvas-import-paste"
                value={pasted}
              />
            )}
            <TextInput
              accessibilityLabel={MOBILE_COPY.canvasImportTitleLabel}
              editable={!busy}
              onChangeText={setTitle}
              placeholder={MOBILE_COPY.canvasImportTitleLabel}
              placeholderTextColor={colors.textSecondary}
              style={[
                styles.input,
                {
                  color: colors.textPrimary,
                  borderColor: colors.hairlineStrong,
                  backgroundColor: colors.control,
                },
              ]}
              testID="mobile-canvas-import-title"
              value={title}
            />
            {problem === undefined ? null : (
              <Text
                accessibilityLiveRegion="polite"
                style={[mobileTypography.body, { color: colors.textPrimary }]}
                testID="mobile-canvas-import-problem"
              >
                {problem}
              </Text>
            )}
            <ToolButton
              disabled={busy || !ready}
              label={busy ? MOBILE_COPY.canvasImportBusy : MOBILE_COPY.canvasImportSubmit}
              onPress={() => void submit()}
              primary
              testID="mobile-canvas-import-submit"
            />
          </>
        )}
      </ScrollView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  sheet: { maxHeight: "90%", minHeight: "60%" },
  body: { paddingHorizontal: mobileSpacing.md, gap: mobileSpacing.sm },
  row: { flexDirection: "row", alignItems: "center", gap: mobileSpacing.sm },
  grow: { flex: 1 },
  result: { gap: mobileSpacing.sm },
  input: {
    minHeight: 44,
    paddingHorizontal: mobileSpacing.sm,
    paddingVertical: mobileSpacing.xs,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
  },
  paste: { minHeight: 140, textAlignVertical: "top" },
});
