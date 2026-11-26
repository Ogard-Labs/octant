import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  fetchMobileProviderCatalog,
  mobileUsageAccounts,
  normalizeMobileProviderDirectory,
  readMobileProviderUsageLimits,
  type MobileRemoteTransport,
  type MobileUsageAccount,
  type MobileUsageWindowRow,
} from "@octant/client-runtime";
import { useTheme } from "../../design-system";
import { MOBILE_COPY, MOBILE_SCREEN_TITLES } from "../copy";
import { ScreenHeader } from "../navigation/ScreenHeader";
import { useMobileSession } from "../session/MobileSessionContext";
import { mobileSpacing, mobileTypography } from "../theme/tokens";
import { ListSection } from "../ui/NativeChrome";
import { usageResetLabel, usageShareLabel } from "./usagePresentation";

type ComputerUsage =
  | { readonly status: "loading" }
  | {
      readonly status: "read";
      readonly accounts: ReadonlyArray<MobileUsageAccount>;
      readonly names: ReadonlyMap<string, string>;
    }
  | { readonly status: "refused" }
  | { readonly status: "unavailable"; readonly message: string };

const NEUTRAL_ACCOUNT_NAME = "Provider account";

async function readComputerUsage(
  transport: MobileRemoteTransport,
  refresh: boolean,
): Promise<ComputerUsage> {
  const [usage, directory] = await Promise.all([
    readMobileProviderUsageLimits(transport, { refresh }),
    // Names are a nicety: without them an account keeps a neutral label.
    fetchMobileProviderCatalog(transport)
      .then(normalizeMobileProviderDirectory)
      .catch(() => []),
  ]);
  if (usage.status !== "read") return usage;
  return {
    status: "read",
    accounts: mobileUsageAccounts(usage.snapshot, Date.now()),
    names: new Map(directory.map((entry) => [entry.providerInstanceId, entry.displayName])),
  };
}

/** Plan usage for each provider account on each paired computer. Read-only. */
export function UsageScreen() {
  const { colors } = useTheme();
  const { hosts, transportForHost } = useMobileSession();
  const [usage, setUsage] = useState<ReadonlyMap<string, ComputerUsage>>(new Map());
  const [refreshing, setRefreshing] = useState(false);

  // Each read belongs to one generation: an answer from a read the screen has
  // since replaced (a reconnect, a pairing made again) is dropped, so a slow
  // old answer never overwrites a newer one.
  const generation = useRef(0);
  const load = useCallback(
    async (refresh: boolean) => {
      generation.current += 1;
      const mine = generation.current;
      // Each computer answers on its own, so a slow one holds up no other.
      await Promise.all(
        hosts.map(async (host) => {
          const transport = transportForHost(host.hostId);
          const answer: ComputerUsage =
            transport === undefined
              ? { status: "unavailable", message: MOBILE_COPY.usageUnreachable }
              : await readComputerUsage(transport, refresh);
          if (generation.current !== mine) return;
          setUsage((previous) => new Map(previous).set(host.hostId, answer));
        }),
      );
    },
    [hosts, transportForHost],
  );

  useEffect(() => {
    void load(false);
    return () => {
      generation.current += 1;
    };
  }, [load]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        shell: { flex: 1 },
        body: { paddingTop: mobileSpacing.sm, paddingBottom: mobileSpacing.xl },
        note: {
          color: colors.textSecondary,
          fontSize: mobileTypography.detail.fontSize,
          paddingHorizontal: mobileSpacing.md + mobileSpacing.md,
          paddingVertical: mobileSpacing.sm,
        },
        account: {
          paddingHorizontal: mobileSpacing.md,
          paddingVertical: mobileSpacing.sm,
          gap: mobileSpacing.sm,
        },
        accountName: {
          color: colors.textPrimary,
          fontSize: mobileTypography.rowLabel.fontSize,
          fontWeight: mobileTypography.rowLabel.fontWeight,
        },
        secondary: { color: colors.textSecondary, fontSize: mobileTypography.detail.fontSize },
        windowRow: { gap: 4 },
        windowHead: {
          flexDirection: "row",
          flexWrap: "wrap",
          justifyContent: "space-between",
          columnGap: mobileSpacing.sm,
        },
        windowName: { color: colors.textPrimary, fontSize: mobileTypography.detail.fontSize },
        track: {
          height: 6,
          borderRadius: 3,
          overflow: "hidden",
          backgroundColor: colors.controlHover,
        },
      }),
    [colors],
  );

  const barColor = (level: MobileUsageWindowRow["level"]) =>
    level === "spent" ? colors.danger : level === "near" ? colors.warning : colors.accent;

  const windowRow = (computerId: string, accountId: string, row: MobileUsageWindowRow) => {
    const resetLabel =
      row.resetsAt === undefined ? undefined : usageResetLabel(row.resetsAt, new Date());
    return (
      <View
        key={row.window}
        style={styles.windowRow}
        testID={`mobile-usage-window-${computerId}-${accountId}-${row.window}`}
      >
        <View style={styles.windowHead}>
          <Text style={styles.windowName}>
            {row.old === true ? `${row.name} (${MOBILE_COPY.usageOld})` : row.name}
          </Text>
          <Text
            style={[
              styles.windowName,
              { color: row.level === "ok" ? colors.textSecondary : barColor(row.level) },
            ]}
          >
            {usageShareLabel(row)}
          </Text>
        </View>
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={styles.track}
        >
          <View
            style={{
              height: 6,
              width: `${Math.max(2, row.usedPercent)}%`,
              backgroundColor: barColor(row.level),
              opacity: row.old === true ? 0.5 : 1,
            }}
          />
        </View>
        {resetLabel === undefined ? null : <Text style={styles.secondary}>{resetLabel}</Text>}
      </View>
    );
  };

  const accountBlock = (
    computerId: string,
    account: MobileUsageAccount,
    names: ReadonlyMap<string, string>,
  ) => (
    <View
      key={account.providerInstanceId}
      style={styles.account}
      testID={`mobile-usage-account-${computerId}-${account.providerInstanceId}`}
    >
      <Text accessibilityRole="header" style={styles.accountName}>
        {names.get(account.providerInstanceId) ?? NEUTRAL_ACCOUNT_NAME}
      </Text>
      {account.state === "windows" ? (
        account.rows.map((row) => windowRow(computerId, account.providerInstanceId, row))
      ) : account.state === "unavailable" ? (
        <Text style={styles.secondary}>{account.reason}</Text>
      ) : (
        <>
          <Text style={styles.secondary}>{account.message}</Text>
          {account.staleRows.map((row) => windowRow(computerId, account.providerInstanceId, row))}
        </>
      )}
    </View>
  );

  return (
    <View style={styles.shell} testID="mobile-usage">
      <ScreenHeader title={MOBILE_SCREEN_TITLES.usage} />
      <ScrollView
        contentContainerStyle={styles.body}
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={
          <RefreshControl
            onRefresh={() => {
              setRefreshing(true);
              void load(true).finally(() => setRefreshing(false));
            }}
            refreshing={refreshing}
          />
        }
      >
        {hosts.length === 0 ? (
          <Text style={styles.note} testID="mobile-usage-no-computer">
            {MOBILE_COPY.usageNoComputer}
          </Text>
        ) : (
          hosts.map((host) => {
            const computer = usage.get(host.hostId) ?? { status: "loading" as const };
            return (
              <ListSection
                key={host.hostId}
                testID={`mobile-usage-computer-${host.hostId}`}
                title={host.label}
              >
                {computer.status === "loading" ? (
                  <Text style={styles.note}>{MOBILE_COPY.usageLoading}</Text>
                ) : computer.status === "refused" ? (
                  <Text style={styles.note}>{MOBILE_COPY.usageRefused}</Text>
                ) : computer.status === "unavailable" ? (
                  <Text style={styles.note}>{computer.message}</Text>
                ) : computer.accounts.length === 0 ? (
                  <Text style={styles.note}>{MOBILE_COPY.usageNoAccounts}</Text>
                ) : (
                  computer.accounts.map((account) =>
                    accountBlock(host.hostId, account, computer.names),
                  )
                )}
              </ListSection>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}
