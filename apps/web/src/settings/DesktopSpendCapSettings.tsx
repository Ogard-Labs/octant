import type { DesktopPaneClient } from "@octant/client-runtime/desktop-pane-client";
import type { DesktopSpendSummary } from "@octant/contracts/desktop-lease";
import { useEffect, useState } from "react";
import { desktopDollars } from "../desktop/desktopPaneModel";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantFieldError } from "../ui/base/OctantField";
import { OctantInput } from "../ui/base/OctantInput";
import { SettingRow, SettingsSection } from "./primitives";

type Loaded =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly summary: DesktopSpendSummary }
  /** The host answers only a person at a local window. */
  | { readonly status: "local-only" }
  | { readonly status: "failed" };

/** Whole dollars and cents as typed (`50`, `$12.50`), in cents, or undefined. */
function capCentsOf(typed: string): number | undefined {
  const match = /^\$?\s*(\d{1,6})(?:\.(\d{1,2}))?$/.exec(typed.trim());
  if (match === null) return undefined;
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

/**
 * Settings › Computer use › the monthly cap for disposable desktops that bill
 * the person. Billed desktops stay off until a cap is set; the host refuses
 * any lease whose estimate would pass it, and only a person at a local
 * window may read or change it.
 */
export function DesktopSpendCapSettings(props: {
  readonly client: Pick<DesktopPaneClient, "request">;
  readonly focusedSetting?: string | undefined;
}) {
  const { client } = props;
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();

  function show(answer: Awaited<ReturnType<DesktopPaneClient["request"]>>): void {
    if (answer.status === "spend") {
      setLoaded({ status: "loaded", summary: answer.summary });
      const cap = answer.summary.monthlyCapUsdCents;
      setTyped(cap === undefined ? "" : (cap / 100).toFixed(2));
    } else if (answer.status === "refused" && answer.reason === "spend-cap-local-only") {
      setLoaded({ status: "local-only" });
    } else {
      setLoaded({ status: "failed" });
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    client.request({ kind: "spend" }, controller.signal).then(
      (answer) => {
        if (!controller.signal.aborted) show(answer);
      },
      () => {
        if (!controller.signal.aborted) setLoaded({ status: "failed" });
      },
    );
    return () => controller.abort();
  }, [client]);

  async function save(monthlyCapUsdCents: number | undefined): Promise<void> {
    setBusy(true);
    setProblem(undefined);
    try {
      show(
        await client.request(
          monthlyCapUsdCents === undefined
            ? { kind: "set-spend-cap" }
            : { kind: "set-spend-cap", monthlyCapUsdCents },
        ),
      );
    } catch {
      setProblem("The host didn't take the cap. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const summary = loaded.status === "loaded" ? loaded.summary : undefined;
  const typedCents = capCentsOf(typed);
  const invalid = typed.trim() !== "" && typedCents === undefined;
  const unchanged = typedCents === summary?.monthlyCapUsdCents;
  const status =
    loaded.status === "loading"
      ? "Checking this month's spending…"
      : loaded.status === "local-only"
        ? "Set on the computer Octant runs on."
        : loaded.status === "failed"
          ? "This window can't ask the host about desktop spending."
          : summary?.monthlyCapUsdCents === undefined
            ? `Off. ${desktopDollars(summary?.spentUsdCents ?? 0)} counted this month.`
            : `${desktopDollars(summary.spentUsdCents)} of ${desktopDollars(summary.monthlyCapUsdCents)} counted this month (UTC).`;

  return (
    <SettingsSection
      title="Desktops that bill you"
      description="Disposable desktops in your own cloud account cost you money while they run."
    >
      <div className="setgroup">
        <SettingRow
          settingId="desktop-spend-cap"
          label="Monthly cap"
          description="No desktop that bills you starts until you set one. Before each starts, Octant estimates its most from the recipe's cost per hour and refuses it if this month's total would pass the cap. Desktops already running keep running."
          scope="host"
          focused={props.focusedSetting === "desktop-spend-cap"}
        >
          <div className="settings-view__actions">
            <OctantInput
              aria-label="Monthly cap in US dollars"
              disabled={busy || summary === undefined}
              inputMode="decimal"
              onChange={(event) => setTyped(event.currentTarget.value)}
              placeholder="50.00"
              value={typed}
            />
            <OctantButton
              type="button"
              size="sm"
              variant="secondary"
              disabled={busy || summary === undefined || typedCents === undefined || unchanged}
              onClick={() => void save(typedCents)}
            >
              Set cap
            </OctantButton>
            {summary?.monthlyCapUsdCents === undefined ? null : (
              <OctantButton
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void save(undefined)}
              >
                Turn off
              </OctantButton>
            )}
          </div>
        </SettingRow>
      </div>
      <p className="provider-settings__field-guidance" role="status">
        {status}
      </p>
      {invalid ? <OctantFieldError>Enter the cap in dollars, such as 50.</OctantFieldError> : null}
      {problem === undefined ? null : <OctantFieldError>{problem}</OctantFieldError>}
    </SettingsSection>
  );
}
