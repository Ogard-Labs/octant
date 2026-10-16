import { useEffect, useState } from "react";
import type { DiagnosticsExportClient } from "@octant/client-runtime/diagnostics-export-client";
import type { JournalGrowth } from "@octant/contracts";
import { OctantAlert } from "../ui/base/OctantAlert";

/**
 * Journal events per aggregate kind over the last 14 days, with the journal's
 * row count and database size. It reads once when Settings opens and never on a
 * timer. It shows kind names and counts only; the host sends nothing else.
 */

type GrowthState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly growth: JournalGrowth }
  | { readonly kind: "error" };

export function JournalGrowthTable({ client }: { readonly client: DiagnosticsExportClient }) {
  const [state, setState] = useState<GrowthState>({ kind: "loading" });

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const growth = await client.readJournalGrowth();
        if (current) setState({ kind: "ready", growth });
      } catch {
        if (current) setState({ kind: "error" });
      }
    })();
    return () => {
      current = false;
    };
  }, [client]);

  if (state.kind === "loading") {
    return <p className="journal-growth__note">Reading journal growth…</p>;
  }
  if (state.kind === "error") {
    return <OctantAlert tone="warning">Journal growth could not be read.</OctantAlert>;
  }
  const { growth } = state;
  const firstDay = growth.days[0];
  const lastDay = growth.days[growth.days.length - 1];
  return (
    <div className="journal-growth">
      <p className="journal-growth__summary">
        {formatCount(growth.totalRows)} journal rows · {formatBytes(growth.databaseBytes)} database
      </p>
      {growth.kinds.length === 0 ? (
        <p className="journal-growth__note">No journal events in the last 14 days.</p>
      ) : (
        <table className="journal-growth__table">
          <caption className="journal-growth__caption">
            Events per kind, {firstDay} to {lastDay}
          </caption>
          <thead>
            <tr>
              <th scope="col">Kind</th>
              <th scope="col">14 days</th>
              <th scope="col">Events</th>
            </tr>
          </thead>
          <tbody>
            {growth.kinds.map((entry) => (
              <tr key={entry.kind}>
                <th scope="row">{entry.kind}</th>
                <td>
                  <Sparkline counts={entry.counts} />
                </td>
                <td>{formatCount(entry.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** A glance at the shape; the total beside it is the accessible number. */
function Sparkline({ counts }: { readonly counts: ReadonlyArray<number> }) {
  const width = 100;
  const height = 20;
  const pad = 2;
  const max = Math.max(1, ...counts);
  const points = counts
    .map((count, index) => {
      const x = counts.length <= 1 ? width / 2 : (index / (counts.length - 1)) * width;
      const y = height - pad - (count / max) * (height - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      aria-hidden="true"
      className="sparkline"
      preserveAspectRatio="none"
      viewBox={`0 0 ${String(width)} ${String(height)}`}
    >
      <polyline className="chart-line" points={points} />
    </svg>
  );
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024 * 1_024) return `${Math.max(1, Math.round(bytes / 1_024))} KB`;
  if (bytes < 1_024 * 1_024 * 1_024) return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
  return `${(bytes / (1_024 * 1_024 * 1_024)).toFixed(2)} GB`;
}
