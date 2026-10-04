import { decodeAggregateVersion, decodeProjectId } from "@octant/contracts";
import type { SpendCeilingSnapshot } from "@octant/contracts";
import type { SpendCeilingClient } from "@octant/client-runtime/spend-ceiling-client";
import { useEffect, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { spendCeilingLimits, spendCeilingRemainingPhrases } from "./spendCeilingLimits";
import { OctantAlert } from "../ui/base/OctantAlert";

type CalendarPeriod = "day" | "week" | "month";

const PERIOD_OPTIONS = [
  { id: "day", label: "Each day" },
  { id: "week", label: "Each week" },
  { id: "month", label: "Each month" },
] as const;

function isCalendarPeriod(value: string): value is CalendarPeriod {
  return value === "day" || value === "week" || value === "month";
}

export function ProjectSpendCeilingSection(props: {
  readonly client: SpendCeilingClient;
  readonly projectId: string;
}) {
  const [snapshot, setSnapshot] = useState<SpendCeilingSnapshot | undefined>(undefined);
  const [budget, setBudget] = useState("");
  const [turns, setTurns] = useState("");
  const [hours, setHours] = useState("");
  const [period, setPeriod] = useState<CalendarPeriod>("month");
  const [message, setMessage] = useState<string | undefined>(undefined);
  const scope = { kind: "project" as const, projectId: decodeProjectId(props.projectId) };

  useEffect(() => {
    let cancelled = false;
    void props.client
      .snapshot({ projectId: props.projectId })
      .then((next) => {
        if (!cancelled) setSnapshot(next);
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setMessage(error instanceof Error ? error.message : "Spend ceiling is unavailable.");
      });
    return () => {
      cancelled = true;
    };
  }, [props.client, props.projectId]);

  const remaining = snapshot?.projectRemaining;
  const ceilingSet = snapshot?.project !== undefined;
  const version = snapshot?.project?.version ?? 0;
  const window = remaining?.window;
  const windowPeriod = window?.kind === "calendar" ? window.period : period;

  async function submit(kind: "set" | "raise" | "clear"): Promise<void> {
    const limits = spendCeilingLimits({ tokens: budget, turns, hours });
    const expectedVersion = decodeAggregateVersion(version);
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const command =
      kind === "clear"
        ? { kind: "clear-spend-ceiling" as const, scope, expectedVersion }
        : kind === "raise"
          ? {
              kind: "raise-spend-ceiling" as const,
              scope,
              expectedVersion,
              ...limits,
            }
          : {
              kind: "set-spend-ceiling" as const,
              scope,
              expectedVersion,
              policy: limits,
              window: { kind: "calendar" as const, period, timeZone },
            };
    try {
      const result = await props.client.execute(command);
      if (result.kind === "refused") {
        setMessage(result.refusal.message);
        return;
      }
      setMessage(undefined);
      setSnapshot(await props.client.snapshot({ projectId: props.projectId }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Spend ceiling could not be changed.");
    }
  }

  return (
    <section aria-label="Project spend ceiling" className="project-overview__ceiling">
      <h3>Spend ceiling</h3>
      {remaining === undefined ? (
        <p role="note">
          No spend ceiling is set on this Project. A turn must also stay under any thread ceiling.
          Setting one is a host owner command. Tokens, turns, and total agent run time each count
          over the calendar window you choose.
        </p>
      ) : (
        <p role="status">
          {spendCeilingRemainingPhrases([remaining])
            .map((phrase) => `${phrase} this ${windowPeriod}`)
            .join(" · ")}
        </p>
      )}
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit(ceilingSet ? "raise" : "set");
        }}
      >
        <OctantInput
          aria-label="Project token spend ceiling"
          inputMode="numeric"
          onChange={(event) => setBudget(event.target.value)}
          placeholder="Tokens"
          value={budget}
        />
        <OctantInput
          aria-label="Project turn ceiling"
          inputMode="numeric"
          onChange={(event) => setTurns(event.target.value)}
          placeholder="Turns"
          value={turns}
        />
        <OctantInput
          aria-label="Project agent run time ceiling in hours"
          inputMode="decimal"
          onChange={(event) => setHours(event.target.value)}
          placeholder="Hours of agent run time"
          value={hours}
        />
        {ceilingSet ? null : (
          <OctantSelectField
            aria-label="Project ceiling window"
            onValueChange={(value) => {
              if (isCalendarPeriod(value)) setPeriod(value);
            }}
            options={PERIOD_OPTIONS}
            value={period}
          />
        )}
        <OctantButton type="submit" variant="outline">
          {ceilingSet ? "Raise Project ceiling" : "Set Project ceiling"}
        </OctantButton>
        {ceilingSet ? (
          <OctantButton onClick={() => void submit("clear")} type="button" variant="ghost">
            Clear Project ceiling
          </OctantButton>
        ) : null}
      </form>
      {message === undefined ? null : <OctantAlert tone="warning">{message}</OctantAlert>}
    </section>
  );
}
