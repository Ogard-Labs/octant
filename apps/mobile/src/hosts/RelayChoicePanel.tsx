import { useEffect, useMemo, useState } from "react";
import { StyleSheet, Switch, Text, View } from "react-native";
import type { PairedHostRelayChoice } from "@octant/client-runtime";
import { mobileSpacing, mobileTypography } from "../theme/tokens";
import { useTheme } from "../../design-system";
import type { RelayChoiceStore } from "./relayChoiceStore";

export interface RelayChoicePanelProps {
  readonly hostLabel: string;
  readonly origin: string;
  readonly choices: Pick<RelayChoiceStore, "read" | "setEnabled" | "subscribe">;
  readonly testIdSuffix: string;
}

/**
 * This phone's own choice to reach one computer through its hub when away.
 * Off until the person turns it on; the phone then relays only when it
 * cannot reach the computer directly, and only once the computer told it
 * where the hub's relay is while the phone was at home.
 */
export function RelayChoicePanel(props: RelayChoicePanelProps) {
  const { colors } = useTheme();
  const [choice, setChoice] = useState<PairedHostRelayChoice | undefined>();
  const { choices, origin } = props;
  useEffect(() => {
    let current = true;
    const show = (): void => {
      void choices
        .read(origin)
        .then((read) => {
          if (current) setChoice(read);
        })
        .catch(() => undefined);
    };
    show();
    const unsubscribe = choices.subscribe(show);
    return () => {
      current = false;
      unsubscribe();
    };
  }, [choices, origin]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        panel: { marginTop: mobileSpacing.lg, gap: mobileSpacing.sm },
        row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
        label: { ...mobileTypography.body, color: colors.textPrimary, flex: 1 },
        help: { ...mobileTypography.body, color: colors.textSecondary },
      }),
    [colors],
  );

  const enabled = choice?.enabled === true;
  const change = (next: boolean): void => {
    setChoice((current) => ({ ...current, enabled: next }));
    void choices.setEnabled(origin, next).catch(() => {
      setChoice((current) => ({ ...current, enabled: !next }));
    });
  };

  return (
    <View style={styles.panel} testID={`mobile-host-relay-${props.testIdSuffix}`}>
      <View style={styles.row}>
        <Text style={styles.label}>Reach this computer through the hub when away</Text>
        <Switch
          accessibilityLabel={`Reach ${props.hostLabel} through the hub when away`}
          onValueChange={change}
          testID={`mobile-host-relay-switch-${props.testIdSuffix}`}
          value={enabled}
        />
      </View>
      {enabled ? (
        <Text style={styles.help}>
          {choice?.address === undefined
            ? "It hasn't told this phone where its hub is yet. Open it once on the same network."
            : "Away from its network, this phone reaches it through its hub. The hub sees only encrypted traffic."}
        </Text>
      ) : null}
    </View>
  );
}
