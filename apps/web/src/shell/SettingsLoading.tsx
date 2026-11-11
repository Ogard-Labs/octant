export interface SettingsLoadingProps {
  readonly narrow: boolean;
  readonly sheet: boolean;
}

const RAIL_ROWS = ["first", "second", "third", "fourth", "fifth", "sixth"] as const;
const PAGE_ROWS = ["first", "second", "third", "fourth"] as const;

/**
 * The shape of Settings while it loads: the rail of sections and a page with
 * its title and a few rows. A spinner and two lines in the middle of the sheet
 * gave way to a rail and a page, and everything moved. The words stay for
 * assistive technology, which cannot see the shape.
 *
 * It is drawn from classes of its own (dock.css), never Settings' own: those
 * are in the stylesheet that loads with Settings, which is what this waits for.
 */
export function SettingsLoading(props: SettingsLoadingProps) {
  const presentation = props.narrow ? "narrow" : props.sheet ? "sheet" : "page";
  return (
    <div
      aria-label="Opening Settings"
      className="settings-loading"
      data-presentation={presentation}
      role="status"
    >
      <span className="sr-only">Opening Settings</span>
      {props.narrow ? null : (
        <div aria-hidden="true" className="settings-loading__rail">
          <span className="skeleton settings-loading__title" />
          {RAIL_ROWS.map((row) => (
            <span className="skeleton settings-loading__rail-row" key={row} />
          ))}
        </div>
      )}
      <div aria-hidden="true" className="settings-loading__page">
        <span className="skeleton settings-loading__title" />
        {PAGE_ROWS.map((row) => (
          <span className="skeleton settings-loading__page-row" key={row} />
        ))}
      </div>
    </div>
  );
}
