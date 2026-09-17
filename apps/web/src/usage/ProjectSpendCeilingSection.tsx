import { decodeAggregateVersion, decodeProjectId } from "@octant/contracts";
import type { SpendCeilingSnapshot } from "@octant/contracts";
import type { SpendCeilingClient } from "@octant/client-runtime/spend-ceiling-client";
import { useEffect, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";

export function ProjectSpendCeilingSection(props: {
  readonly client: SpendCeilingClient;
  readonly projectId: string;
}) {
  const [snapshot, setSnapshot] = useState<SpendCeilingSnapshot | undefined>(undefined);
  const [budget, setBudget] = useState("");
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

  async function submit(kind: "set" | "raise" | "clear"): Promise<void> {
    const tokenBudget = Number.parseInt(budget, 10);
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
              tokenBudget,
            }
          : {
              kind: "set-spend-ceiling" as const,
              scope,
              expectedVersion,
              policy: { tokenBudget },
              window: { kind: "calendar" as const, period: "month" as const, timeZone },
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
      <h3>Token spend ceiling</h3>
      {remaining === undefined ? (
        <p role="note">
          No token ceiling is set on this Project. A turn must also stay under any thread ceiling.
          Setting one is a host owner command. The window is this calendar month.
        </p>
      ) : (
        <p role="status">
          {remaining.remainingTokens.toLocaleString()} of {remaining.ceilingTokens.toLocaleString()}{" "}
          tokens remaining this month
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
          value={budget}
        />
        <OctantButton type="submit" variant="outline">
          {ceilingSet ? "Raise Project token ceiling" : "Set Project token ceiling"}
        </OctantButton>
        {ceilingSet ? (
          <OctantButton onClick={() => void submit("clear")} type="button" variant="ghost">
            Clear Project ceiling
          </OctantButton>
        ) : null}
      </form>
      {message === undefined ? null : <p role="alert">{message}</p>}
    </section>
  );
}
