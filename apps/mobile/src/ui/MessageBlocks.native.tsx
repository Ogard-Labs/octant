import { useMemo } from "react";
import * as Clipboard from "expo-clipboard";
import { Alert, Linking, StyleSheet, View } from "react-native";
import { MOBILE_COPY } from "../copy";
import { EnrichedMarkdownText, type MarkdownStyle } from "react-native-enriched-markdown";
import { fonts, radii, space, typography, useTheme } from "../../design-system";
import { PlainBlocks, ReplyCode, type MessageBlocksProps } from "./PlainBlocks";
import { replySegments } from "./replyMarkdown";

/**
 * Asks first, with the address written out: a reply can name one place and
 * lead to another, and opening it tells that place whatever the address holds.
 */
function offerLink(url: string): void {
  if (!/^https?:\/\//i.test(url)) return;
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    return;
  }
  Alert.alert(MOBILE_COPY.linkOpen(host), url, [
    { text: "Cancel", style: "cancel" },
    { text: MOBILE_COPY.linkCopy, onPress: () => void Clipboard.setStringAsync(url) },
    { text: MOBILE_COPY.linkOpenAction, onPress: () => void Linking.openURL(url) },
  ]);
}

/** A reply as the system's own text: selection, the edit menu, links and tables. */
export function MessageBlocks(props: MessageBlocksProps) {
  return props.tone === "user" ? <PlainBlocks {...props} /> : <Reply {...props} />;
}

function Reply(props: MessageBlocksProps) {
  const { colors } = useTheme();
  const segments = useMemo(() => replySegments(props.text), [props.text]);
  const markdownStyle = useMemo<MarkdownStyle>(() => {
    const body = { color: colors.textPrimary, fontSize: typography.body.fontSize };
    // A heading inside a reply is a label, not a page's title.
    const label = { ...body, fontWeight: "600", marginTop: 10, marginBottom: 4 } as const;
    return {
      paragraph: { ...body, lineHeight: 23, marginTop: 0, marginBottom: 10 },
      h1: { ...label, fontSize: 19 },
      h2: { ...label, fontSize: 18 },
      h3: { ...label, fontSize: 17 },
      h4: label,
      h5: label,
      h6: label,
      list: {
        ...body,
        lineHeight: 23,
        bulletColor: colors.textTertiary,
        markerColor: colors.textSecondary,
        itemSpacing: 4,
        marginBottom: 10,
      },
      strong: { color: colors.textPrimary },
      link: { color: colors.accent, underline: false },
      code: {
        fontFamily: fonts.mono,
        fontSize: typography.body.fontSize - 1,
        color: colors.textSecondary,
        backgroundColor: "transparent",
        borderColor: "transparent",
      },
      blockquote: {
        ...body,
        color: colors.textSecondary,
        borderColor: colors.hairlineStrong,
        borderWidth: 2,
        gapWidth: 12,
        backgroundColor: "transparent",
        marginBottom: 10,
      },
      thematicBreak: {
        color: colors.hairlineStrong,
        height: StyleSheet.hairlineWidth,
        marginTop: 8,
        marginBottom: 16,
      },
      table: {
        fontSize: typography.detail.fontSize + 1,
        color: colors.textPrimary,
        headerTextColor: colors.textPrimary,
        headerBackgroundColor: colors.control,
        rowEvenBackgroundColor: "transparent",
        rowOddBackgroundColor: "transparent",
        borderColor: colors.hairline,
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: radii.sm,
        cellPaddingHorizontal: 12,
        cellPaddingVertical: 8,
        marginBottom: 10,
      },
    };
  }, [colors]);
  return (
    <View style={{ gap: space.xs }} testID={props.testID ?? "mobile-message-blocks"}>
      {segments.map((segment, index) =>
        segment.kind === "code" ? (
          <ReplyCode
            code={segment.code}
            key={index}
            {...(segment.language === undefined ? {} : { language: segment.language })}
          />
        ) : (
          <EnrichedMarkdownText
            enableBlockContextMenu
            // A long press would load the page to preview it.
            enableLinkPreview={false}
            enableTaskListItemToggle={false}
            flavor="github"
            key={index}
            markdown={segment.markdown}
            markdownStyle={markdownStyle}
            onLinkLongPress={({ url }) => offerLink(url)}
            onLinkPress={({ url }) => offerLink(url)}
            // The parser is given no picture; this is what it would be answered.
            resolveImageSource={() => ({ uri: "" })}
            selectable
          />
        ),
      )}
    </View>
  );
}
