import type { RightUtilityDockSurfaceId } from "./rightUtilityDockModel";

export interface RightUtilityDockSummaryItem {
  readonly id: "context" | "project-memory" | "navigator";
  readonly label: string;
  readonly value: string;
}

export function RightUtilityDockSummary(props: {
  readonly items: ReadonlyArray<RightUtilityDockSummaryItem>;
  readonly onOpen: (surface: RightUtilityDockSurfaceId, opener: HTMLButtonElement) => void;
}) {
  return (
    <section aria-label="Active thread summary" className="right-utility-dock-summary">
      {props.items.map((item) => (
        <button
          className="right-utility-dock-summary__item window-no-drag"
          key={item.id}
          onClick={(event) => props.onOpen(item.id, event.currentTarget)}
          type="button"
        >
          <span>{item.label}</span>
          <span>{item.value}</span>
        </button>
      ))}
    </section>
  );
}
