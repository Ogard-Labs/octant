import { LegendList } from "@legendapp/list/react-native";
import * as Clipboard from "expo-clipboard";
import { resolveTerminalColorProjection } from "@octant/theme";
import { memo, useMemo, useRef, useState } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type LayoutChangeEvent,
  type TextInputInstance,
} from "react-native";
import { fonts, radii, space, useTheme } from "../../design-system";
import { MOBILE_COPY } from "../copy";
import { terminalRunColours } from "./terminalColours";
import { controlCharacter, pastedText, terminalKeyData, type TerminalKey } from "./terminalInput";
import type { TerminalRow, TerminalSnapshot } from "./terminalScreen";

const FONT_SIZE = 12;
/** Measured across this many cells, so a fraction of a point per cell is not lost. */
const SAMPLE = "MMMMMMMMMMMMMMMMMMMM";
/**
 * Text that arrives at once past this length, or with a line break, is a
 * paste rather than typing that outran the field's clearing.
 */
const PASTE_LENGTH = 4;

export interface TerminalViewProps {
  readonly snapshot: TerminalSnapshot;
  /** Bytes for the shell: typed text, keys, and pastes. */
  readonly onInput: (data: string) => void;
  /** The whole cells that fit, each time the view's size changes. */
  readonly onSize: (columns: number, rows: number) => void;
  /** False once the shell has ended: output stays, typing stops. */
  readonly accepting: boolean;
  readonly testID?: string;
}

type Metrics = { readonly cellWidth: number; readonly lineHeight: number };

/**
 * A shell's screen in the system's own text, one row per line in the mono
 * face, coloured from the theme's terminal palette. Tapping it brings up the
 * keyboard; the key row above adds the keys a phone keyboard lacks.
 */
export function TerminalView(props: TerminalViewProps) {
  const { scheme } = useTheme();
  const projection = useMemo(
    () => resolveTerminalColorProjection({ mode: scheme, tokens: {} }),
    [scheme],
  );
  const { palette, minimumContrastRatio } = projection;
  // An estimate for the mono face until the sample is measured, so the rows
  // draw at once; only a measured size is reported to the host.
  const [metrics, setMetrics] = useState<Metrics>();
  const drawn: Metrics = metrics ?? {
    cellWidth: FONT_SIZE * 0.6,
    lineHeight: Math.ceil(FONT_SIZE * 1.4),
  };
  // Both layouts can arrive in one batch, before either state lands, so the
  // size is worked out from the latest of each kept here.
  const latestMetrics = useRef<Metrics | undefined>(undefined);
  const latestFrame = useRef<{ width: number; height: number } | undefined>(undefined);
  const [control, setControl] = useState(false);
  const input = useRef<TextInputInstance>(null);
  const reported = useRef<string>("");
  const { onSize } = props;

  const report = () => {
    const next = latestMetrics.current;
    const box = latestFrame.current;
    if (next === undefined || box === undefined) return;
    const columns = Math.max(2, Math.floor((box.width - space.sm * 2) / next.cellWidth));
    const rows = Math.max(2, Math.floor((box.height - space.sm * 2) / next.lineHeight));
    const key = `${String(columns)}x${String(rows)}`;
    if (key === reported.current) return;
    reported.current = key;
    onSize(columns, rows);
  };

  const measured = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    if (width === 0) return;
    const next = { cellWidth: width / SAMPLE.length, lineHeight: Math.ceil(height) };
    latestMetrics.current = next;
    setMetrics(next);
    report();
  };
  const laidOut = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    latestFrame.current = { width, height };
    report();
  };

  const send = (data: string) => {
    if (props.accepting) props.onInput(data);
  };
  // The hidden field is emptied after every change, so what it holds is what
  // was just typed; Backspace arrives as a key press, which an empty field
  // still reports.
  const typed = (text: string) => {
    if (text.length === 0) return;
    input.current?.clear();
    if (text.length === 1) {
      send(control ? controlCharacter(text) : text);
      setControl(false);
    } else if (text.length >= PASTE_LENGTH || /[\r\n]/.test(text)) {
      send(pastedText(text, props.snapshot.modes));
    } else {
      send(text);
    }
  };

  const textStyle = {
    fontFamily: fonts.mono,
    fontSize: FONT_SIZE,
    letterSpacing: 0,
    lineHeight: drawn.lineHeight,
  } as const;
  const rows = props.snapshot.rows;
  const cursor = props.snapshot.cursor;

  return (
    <View style={styles.frame}>
      <Pressable
        accessibilityHint={props.accepting ? MOBILE_COPY.projectTerminalTypeHint : undefined}
        accessibilityLabel={MOBILE_COPY.projectTerminalOutput}
        onLayout={laidOut}
        onPress={() => input.current?.focus()}
        style={[
          styles.screen,
          { backgroundColor: palette.background, borderColor: palette.brightBlack },
        ]}
        testID={props.testID}
      >
        <Text
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          onLayout={measured}
          style={[textStyle, styles.sample]}
        >
          {SAMPLE}
        </Text>
        <View style={styles.rows} testID="mobile-terminal-rows">
          <LegendList
            alignItemsAtEnd
            contentContainerStyle={styles.content}
            data={rows}
            estimatedItemSize={drawn.lineHeight}
            // A row is one line of the grid; its height never changes.
            getFixedItemSize={() => drawn.lineHeight}
            initialScrollAtEnd
            keyExtractor={(row) => String(row.id)}
            maintainScrollAtEnd
            recycleItems
            renderItem={({ item, index }) => (
              <TerminalLine
                cellWidth={drawn.cellWidth}
                cursorColumn={cursor?.row === index ? cursor.column : undefined}
                minimumContrast={minimumContrastRatio}
                palette={palette}
                row={item}
                textStyle={textStyle}
              />
            )}
          />
        </View>
        <TextInput
          accessibilityLabel={MOBILE_COPY.projectTerminalLine}
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect={false}
          caretHidden
          contextMenuHidden
          editable={props.accepting}
          // Suggestions would rewrite what was typed after it was sent.
          keyboardType={Platform.OS === "android" ? "visible-password" : "ascii-capable"}
          onChangeText={typed}
          onKeyPress={(event) => {
            if (event.nativeEvent.key === "Backspace") send("\u007f");
          }}
          onSubmitEditing={() => send("\r")}
          ref={input}
          smartInsertDelete={false}
          spellCheck={false}
          style={styles.hiddenInput}
          submitBehavior="submit"
          testID="mobile-terminal-input"
        />
      </Pressable>
      {props.accepting ? (
        <KeyRow
          control={control}
          onControl={() => setControl((held) => !held)}
          onKey={(key) => send(terminalKeyData(key, props.snapshot.modes))}
          // The hidden field has no edit menu, so the row offers Paste itself.
          onPaste={() =>
            void Clipboard.getStringAsync().then((text) => {
              if (text.length > 0) send(pastedText(text, props.snapshot.modes));
            })
          }
          onText={send}
        />
      ) : null}
    </View>
  );
}

const TerminalLine = memo(
  function TerminalLine(props: {
    readonly row: TerminalRow;
    readonly palette: ReturnType<typeof resolveTerminalColorProjection>["palette"];
    readonly minimumContrast: number;
    readonly cursorColumn: number | undefined;
    readonly cellWidth: number;
    readonly textStyle: object;
  }) {
    const { palette } = props;
    return (
      <View>
        <Text numberOfLines={1} style={[props.textStyle, { color: palette.foreground }]}>
          {props.row.runs.map((run, index) => {
            const colours = terminalRunColours(run.style, palette, props.minimumContrast);
            return (
              <Text
                key={index}
                style={{
                  ...colours,
                  ...(run.style.bold === true ? { fontWeight: "700" as const } : {}),
                  ...(run.style.italic === true ? { fontStyle: "italic" as const } : {}),
                  ...(run.style.underline === true
                    ? { textDecorationLine: "underline" as const }
                    : {}),
                  ...(run.style.dim === true ? { opacity: 0.7 } : {}),
                }}
              >
                {run.text}
              </Text>
            );
          })}
          {/* An empty line still takes a line's height. */}
          {props.row.runs.length === 0 ? " " : null}
        </Text>
        {props.cursorColumn === undefined ? null : (
          <View
            pointerEvents="none"
            style={[
              styles.cursor,
              {
                left: props.cursorColumn * props.cellWidth,
                width: props.cellWidth,
                backgroundColor: palette.cursor,
              },
            ]}
          />
        )}
      </View>
    );
  },
  (before, after) =>
    before.row.id === after.row.id &&
    before.row.version === after.row.version &&
    before.cursorColumn === after.cursorColumn &&
    before.palette === after.palette &&
    before.cellWidth === after.cellWidth,
);

const KEYS: ReadonlyArray<{
  readonly label: string;
  readonly spoken: string;
  readonly key: TerminalKey;
}> = [
  { label: "esc", spoken: "Escape", key: "escape" },
  { label: "tab", spoken: "Tab", key: "tab" },
  { label: "←", spoken: "Left", key: "left" },
  { label: "↑", spoken: "Up", key: "up" },
  { label: "↓", spoken: "Down", key: "down" },
  { label: "→", spoken: "Right", key: "right" },
];

const CHARACTERS = ["|", "~", "/", "-", "*", "$"] as const;

/** The keys a phone keyboard lacks, in one row that scrolls sideways when narrow. */
function KeyRow(props: {
  readonly control: boolean;
  readonly onControl: () => void;
  readonly onKey: (key: TerminalKey) => void;
  readonly onPaste: () => void;
  readonly onText: (text: string) => void;
}) {
  const { colors } = useTheme();
  const keyStyle = [styles.key, { backgroundColor: colors.control, borderColor: colors.hairline }];
  const label = [styles.keyLabel, { color: colors.textPrimary }];
  return (
    <ScrollView
      contentContainerStyle={styles.keys}
      horizontal
      keyboardShouldPersistTaps="always"
      showsHorizontalScrollIndicator={false}
      testID="mobile-terminal-keys"
    >
      <Pressable
        accessibilityLabel={MOBILE_COPY.projectTerminalControlKey}
        accessibilityRole="togglebutton"
        accessibilityState={{ checked: props.control }}
        onPress={props.onControl}
        style={[keyStyle, props.control ? { backgroundColor: colors.primary } : null]}
        testID="mobile-terminal-key-control"
      >
        <Text style={[label, props.control ? { color: colors.primaryForeground } : null]}>
          ctrl
        </Text>
      </Pressable>
      <Pressable
        accessibilityLabel={MOBILE_COPY.projectTerminalInterruptLabel}
        accessibilityRole="button"
        onPress={() => props.onText("\u0003")}
        style={keyStyle}
        testID="mobile-project-terminal-interrupt"
      >
        <Text style={label}>⌃C</Text>
      </Pressable>
      <Pressable
        accessibilityLabel={MOBILE_COPY.projectTerminalPaste}
        accessibilityRole="button"
        onPress={props.onPaste}
        style={keyStyle}
        testID="mobile-terminal-key-paste"
      >
        <Text style={label}>{MOBILE_COPY.projectTerminalPaste}</Text>
      </Pressable>
      {KEYS.map((key) => (
        <Pressable
          accessibilityLabel={key.spoken}
          accessibilityRole="button"
          key={key.key}
          onPress={() => props.onKey(key.key)}
          style={keyStyle}
          testID={`mobile-terminal-key-${key.key}`}
        >
          <Text style={label}>{key.label}</Text>
        </Pressable>
      ))}
      {CHARACTERS.map((character) => (
        <Pressable
          accessibilityLabel={character}
          accessibilityRole="button"
          key={character}
          onPress={() => props.onText(character)}
          style={keyStyle}
        >
          <Text style={label}>{character}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  frame: { flex: 1, gap: space.xs },
  screen: {
    flex: 1,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  rows: { flex: 1 },
  content: { padding: space.sm },
  sample: { position: "absolute", opacity: 0, top: 0, left: 0 },
  cursor: { position: "absolute", top: 0, bottom: 0, opacity: 0.55 },
  hiddenInput: { position: "absolute", width: 1, height: 1, opacity: 0, bottom: 0, left: 0 },
  keys: { gap: space.xs, paddingVertical: 2 },
  key: {
    minWidth: 44,
    minHeight: 36,
    paddingHorizontal: space.sm,
    borderRadius: radii.sm,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  keyLabel: { fontFamily: fonts.mono, fontSize: 14 },
});
