import "./rail-usage-card.css";

export interface RailUsageCardWindow {
  readonly id: string;
  readonly name: string;
  readonly percent: number;
  readonly level: "ok" | "near" | "spent";
  /** "Resets in 2h 52m", when the provider said. */
  readonly reset?: string;
}

export interface RailUsageCardProps {
  readonly title: string;
  /** "Last read 5h ago", for a reading made hours ago. */
  readonly age?: string;
  readonly windows: ReadonlyArray<RailUsageCardWindow>;
}

/** Every window of one account's plan: what is left of it and when it resets. */
export function RailUsageCard(props: RailUsageCardProps) {
  return (
    <div className="rail-usage-card">
      <div>
        <p className="rail-usage-card__title">{props.title}</p>
        {props.age === undefined ? null : <span className="oct-meta">{props.age}</span>}
      </div>
      {props.windows.map((window) => (
        <div className="rail-usage-card__window" data-level={window.level} key={window.id}>
          <div className="rail-usage-card__head">
            <span className="oct-row-label">{window.name}</span>
            <span className="rail-usage-card__left">{window.percent}% left</span>
          </div>
          <span aria-hidden="true" className="rail-usage-card__bar">
            <span style={{ width: `${String(window.percent)}%` }} />
          </span>
          {window.reset === undefined ? null : <span className="oct-meta">{window.reset}</span>}
        </div>
      ))}
    </div>
  );
}
