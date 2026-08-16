import type { UsageActivityCell, UsageActivityState } from "@octant/contracts";
import "./usageWorkspace.css";

export interface UsageActivityHeatmapProps {
  readonly cells: ReadonlyArray<UsageActivityCell>;
  readonly truncated: boolean;
  readonly timeZone: string;
}

/** Glyphs carry the measurement state so it never depends on colour alone. */
const STATE_GLYPH: Readonly<Record<UsageActivityState, string>> = {
  "no-activity": "·",
  measured: "■",
  "partially-unavailable": "◪",
  unavailable: "?",
};

const STATE_WORDS: Readonly<Record<UsageActivityState, string>> = {
  "no-activity": "no activity",
  measured: "measured",
  "partially-unavailable": "partly unavailable",
  unavailable: "usage unavailable",
};

/**
 * Accessible activity heatmap for the usage dashboard.
 *
 * Each day is focusable and names its own facts, and the same series is always
 * present as a table, so the visualization is an accelerator rather than the
 * only way to read the data. Intensity is a presentation bucket over totals the
 * host already computed — the renderer never derives usage — and every cell
 * states its measurement state in words as well as colour, because a day with
 * no activity and a day whose usage the provider never reported must not look
 * the same.
 */
export function UsageActivityHeatmap(props: UsageActivityHeatmapProps) {
  if (props.cells.length === 0) {
    return (
      <section aria-label="Activity" className="usage-heatmap">
        <p className="usage-heatmap__empty" role="note">
          No activity has been recorded in this range.
        </p>
      </section>
    );
  }

  const peak = props.cells.reduce(
    (highest, cell) => Math.max(highest, cell.inputTokens + cell.outputTokens),
    0,
  );
  const leadingBlanks = weekdayIndex(props.cells[0]!.date);

  return (
    <section aria-label="Activity" className="usage-heatmap">
      <p className="usage-heatmap__caption">
        Daily activity in {props.timeZone}
        {props.truncated ? " · showing the most recent 371 days" : ""}
      </p>

      <ul className="usage-heatmap__legend">
        {(["measured", "partially-unavailable", "unavailable", "no-activity"] as const).map(
          (state) => (
            <li key={state}>
              <span aria-hidden="true" className="usage-heatmap__glyph" data-state={state}>
                {STATE_GLYPH[state]}
              </span>
              {STATE_WORDS[state]}
            </li>
          ),
        )}
      </ul>

      <div className="usage-heatmap__grid" role="group" aria-label="Activity heatmap by day">
        {Array.from({ length: leadingBlanks }, (_unused, index) => (
          <span aria-hidden="true" className="usage-heatmap__blank" key={`blank-${index}`} />
        ))}
        {props.cells.map((cell) => (
          <span
            className="usage-heatmap__cell"
            data-level={intensityLevel(cell, peak)}
            data-state={cell.state}
            key={cell.date}
            role="img"
            aria-label={cellLabel(cell)}
            tabIndex={0}
            title={cellLabel(cell)}
          >
            <span aria-hidden="true">{STATE_GLYPH[cell.state]}</span>
          </span>
        ))}
      </div>

      <details className="usage-heatmap__table-toggle">
        <summary>Activity as a table</summary>
        <div className="usage-table-scroll">
          <table className="usage-table">
            <caption className="sr-only">Daily usage activity</caption>
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col">Input tokens</th>
                <th scope="col">Output tokens</th>
                <th scope="col">Requests</th>
                <th scope="col">Requests without usage</th>
                <th scope="col">Measurement</th>
              </tr>
            </thead>
            <tbody>
              {props.cells.map((cell) => (
                <tr key={cell.date}>
                  <th scope="row">{cell.date}</th>
                  <td>{cell.state === "no-activity" ? "—" : cell.inputTokens.toLocaleString()}</td>
                  <td>{cell.state === "no-activity" ? "—" : cell.outputTokens.toLocaleString()}</td>
                  <td>{cell.requestCount}</td>
                  <td>{cell.unavailableRequestCount}</td>
                  <td>{STATE_WORDS[cell.state]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

function cellLabel(cell: UsageActivityCell): string {
  if (cell.state === "no-activity") return `${cell.date}: no activity`;
  if (cell.state === "unavailable") {
    return `${cell.date}: ${cell.requestCount} request${cell.requestCount === 1 ? "" : "s"}, usage unavailable`;
  }
  const tokens = cell.inputTokens + cell.outputTokens;
  const suffix =
    cell.state === "partially-unavailable"
      ? `, ${cell.unavailableRequestCount} without reported usage`
      : "";
  return `${cell.date}: ${tokens.toLocaleString()} tokens across ${cell.requestCount} request${
    cell.requestCount === 1 ? "" : "s"
  }${suffix}`;
}

/**
 * Bucket a day into one of four visual intensities. The exact totals stay in
 * the cell label and the table, so the bucket only accelerates scanning.
 */
function intensityLevel(cell: UsageActivityCell, peak: number): number {
  if (cell.state === "no-activity") return 0;
  const tokens = cell.inputTokens + cell.outputTokens;
  if (peak <= 0 || tokens <= 0) return 1;
  return Math.min(4, Math.max(1, Math.ceil((tokens / peak) * 4)));
}

function weekdayIndex(date: string): number {
  const parsed = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed)) return 0;
  const day = new Date(parsed).getUTCDay();
  return day === 0 ? 6 : day - 1;
}
