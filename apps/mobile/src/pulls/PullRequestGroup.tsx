import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { space, typography, useTheme } from "../../design-system";
import { PullRequestRow } from "./PullRequestRow";
import { pullRequestKey, type MobilePullRequest } from "./pullRequestPresentation";

/** Pull requests under a heading with a hairline to the edge, as thread groups are drawn. */
export function PullRequestGroup(props: {
  readonly label: string;
  readonly pullRequests: ReadonlyArray<MobilePullRequest>;
  /** Set when more than one computer is paired, so each row names its own. */
  readonly hostLabel: ((hostId: string) => string) | undefined;
  readonly onOpen: (pullRequest: MobilePullRequest) => void;
  readonly testID?: string;
}) {
  const { colors } = useTheme();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        heading: {
          minHeight: 40,
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          paddingHorizontal: space.md,
          marginTop: space.sm,
        },
        label: { color: colors.textSecondary, fontSize: typography.detail.fontSize },
        line: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.hairline },
      }),
    [colors],
  );
  return (
    <View testID={props.testID}>
      <View accessibilityRole="header" accessible style={styles.heading}>
        <Text style={styles.label}>{`${props.label} (${props.pullRequests.length})`}</Text>
        <View style={styles.line} />
      </View>
      {props.pullRequests.map((pullRequest, index) => (
        <PullRequestRow
          hostLabel={props.hostLabel?.(pullRequest.hostId)}
          key={pullRequestKey(pullRequest)}
          last={index === props.pullRequests.length - 1}
          onOpen={props.onOpen}
          pullRequest={pullRequest}
        />
      ))}
    </View>
  );
}
