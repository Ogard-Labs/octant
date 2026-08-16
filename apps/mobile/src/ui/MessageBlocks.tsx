import { useMemo, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Ionicons } from "@expo/vector-icons";
import { fonts, radii, space, typography, useTheme } from "../../design-system";
import { parseMarkdownBlocks, type MarkdownBlock } from "./messageDocument";

export interface MessageBlocksProps {
  readonly text: string;
  readonly tone: "user" | "assistant";
  readonly testID?: string;
}

/** Render markdown-ish blocks inside a bubble (headings, lists, fenced code). */
export function MessageBlocks(props: MessageBlocksProps) {
  const { colors } = useTheme();
  const blocks = useMemo(() => parseMarkdownBlocks(props.text), [props.text]);
  const user = props.tone === "user";
  const textColor = user ? colors.userBubbleText : colors.textPrimary;
  const muted = user ? "rgba(247,247,244,0.72)" : colors.textSecondary;
  const codeBg = user ? "rgba(247,247,244,0.12)" : colors.surfaceSolid;
  const codeBorder = user ? "rgba(247,247,244,0.18)" : colors.glassStroke;

  const styles = useMemo(
    () =>
      StyleSheet.create({
        stack: { gap: space.sm },
        paragraph: {
          color: textColor,
          fontSize: typography.body.fontSize,
          lineHeight: 24,
          letterSpacing: typography.body.letterSpacing,
        },
        heading: {
          color: textColor,
          fontWeight: "600",
          letterSpacing: -0.3,
        },
        listItem: {
          color: textColor,
          fontSize: typography.body.fontSize,
          lineHeight: 24,
        },
        codeWrap: {
          borderRadius: radii.sm,
          backgroundColor: codeBg,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: codeBorder,
          overflow: "hidden",
        },
        codeHeader: {
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: space.sm,
          paddingVertical: 6,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: codeBorder,
          gap: space.sm,
        },
        codeLang: {
          flex: 1,
          color: muted,
          fontSize: 11,
          fontWeight: "600",
          fontFamily: fonts.mono,
          textTransform: "lowercase",
        },
        codeBody: {
          color: textColor,
          fontFamily: fonts.mono,
          fontSize: 12,
          lineHeight: 18,
          padding: space.sm,
        },
        inlineCode: {
          fontFamily: fonts.mono,
          fontSize: typography.mono.fontSize + 1,
          color: textColor,
          backgroundColor: "rgba(127,127,127,0.18)",
          borderRadius: 4,
        },
      }),
    [codeBg, codeBorder, muted, textColor],
  );

  return (
    <View style={styles.stack} testID={props.testID ?? "mobile-message-blocks"}>
      {blocks.map((block, index) => (
        <BlockView
          block={block}
          key={`${block.type}:${index}`}
          styles={styles}
          tertiary={colors.textTertiary}
        />
      ))}
    </View>
  );
}

function BlockView(props: {
  readonly block: MarkdownBlock;
  readonly styles: {
    readonly paragraph: object;
    readonly heading: object;
    readonly listItem: object;
    readonly codeWrap: object;
    readonly codeHeader: object;
    readonly codeLang: object;
    readonly codeBody: object;
    readonly inlineCode: object;
  };
  readonly tertiary: string;
}) {
  const { block, styles } = props;
  switch (block.type) {
    case "heading":
      return (
        <Text
          style={[
            styles.heading,
            { fontSize: block.level === 1 ? 22 : block.level === 2 ? 18 : 16 },
          ]}
        >
          {block.text}
        </Text>
      );
    case "list":
      return (
        <View style={{ gap: 4 }}>
          {block.items.map((item, index) => (
            <Text key={`${index}:${item.slice(0, 12)}`} style={styles.listItem}>
              {block.ordered ? `${index + 1}. ` : "• "}
              {item}
            </Text>
          ))}
        </View>
      );
    case "code":
      return (
        <View style={styles.codeWrap} testID="mobile-message-code-block">
          <View style={styles.codeHeader}>
            <Text style={styles.codeLang}>{block.language ?? "code"}</Text>
            <Pressable
              accessibilityLabel="Copy code"
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => {
                void Clipboard.setStringAsync(block.code);
              }}
              testID="mobile-message-code-copy"
            >
              <Ionicons color={props.tertiary} name="copy-outline" size={14} />
            </Pressable>
          </View>
          <Text selectable style={styles.codeBody}>
            {block.code}
          </Text>
        </View>
      );
    case "paragraph":
      return <Text style={styles.paragraph}>{renderInline(block.text, styles.inlineCode)}</Text>;
  }
}

function renderInline(text: string, inlineCodeStyle: object): ReactNode {
  const chunks = text.split(/(`[^`]+`)/g);
  if (chunks.length === 1) return text;
  return chunks.map((chunk, index) => {
    if (chunk.startsWith("`") && chunk.endsWith("`") && chunk.length > 2) {
      return (
        <Text key={`c:${index}`} style={inlineCodeStyle}>
          {chunk.slice(1, -1)}
        </Text>
      );
    }
    return <Text key={`t:${index}`}>{chunk}</Text>;
  });
}
