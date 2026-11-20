import { memo } from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_THEME_SETTINGS } from "@octant/contracts/theme";
import { TurnActions } from "../transcript/TurnActions";
import { TurnTime } from "../transcript/TurnHeader";
import { ThemeSettingsProvider } from "./ThemeSettingsProvider";
import {
  formatClockTime,
  formatDateTime,
  readActiveTimestampFormat,
  timestampFormatHour12,
} from "./timestampFormat";

afterEach(() => {
  delete document.documentElement.dataset.octantTimestampFormat;
});

/**
 * Memoized wrapper so parent rerenders with unchanged props cannot mask a
 * missing context subscription in `TurnTime` or `TurnActions`.
 */
const StableTurnTimestamps = memo(function StableTurnTimestamps(props: { readonly at: string }) {
  return (
    <>
      <div data-testid="turn-time">
        <TurnTime at={props.at} />
      </div>
      <div data-testid="turn-actions">
        <TurnActions at={props.at} latest outcome="completed" />
      </div>
    </>
  );
});

describe("theme timestamp format", () => {
  it("formats clock times and dates as 12-hour or 24-hour and treats null as explicit locale default", () => {
    const afternoon = new Date(2026, 10, 19, 15, 7, 0);

    expect(readActiveTimestampFormat()).toBeUndefined();

    document.documentElement.dataset.octantTimestampFormat = "24h";
    expect(readActiveTimestampFormat()).toBe("24h");
    expect(timestampFormatHour12()).toBe(false);
    expect(timestampFormatHour12(null)).toBeUndefined();
    expect(formatClockTime(afternoon, { hour: "2-digit", minute: "2-digit" })).toBe(
      afternoon.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }),
    );
    expect(formatClockTime(afternoon, { hour: "2-digit", minute: "2-digit" }, null)).toBe(
      afternoon.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
    );
    expect(formatDateTime(afternoon, { dateStyle: "medium", timeStyle: "short" })).toBe(
      afternoon.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
        hour12: false,
      }),
    );

    document.documentElement.dataset.octantTimestampFormat = "12h";
    expect(readActiveTimestampFormat()).toBe("12h");
    expect(timestampFormatHour12()).toBe(true);
    expect(timestampFormatHour12(null)).toBeUndefined();
    expect(formatClockTime(afternoon, { hour: "2-digit", minute: "2-digit" })).toBe(
      afternoon.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      }),
    );
    expect(formatDateTime(afternoon, { dateStyle: "medium", timeStyle: "short" })).toBe(
      afternoon.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
        hour12: true,
      }),
    );
  });

  it("updates and clears rendered TurnTime and TurnActions timestamps reactively when theme timestampFormat changes", () => {
    const todayAfternoon = new Date();
    todayAfternoon.setHours(15, 7, 0, 0);
    const iso = todayAfternoon.toISOString();

    const expected24h = todayAfternoon.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const expected12h = todayAfternoon.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
    const expectedLocaleDefault = todayAfternoon.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });

    const view = render(
      <ThemeSettingsProvider
        settings={{ ...DEFAULT_THEME_SETTINGS, mode: "dark", timestampFormat: "24h" }}
      >
        <StableTurnTimestamps at={iso} />
      </ThemeSettingsProvider>,
    );

    expect(document.documentElement.dataset.octantTimestampFormat).toBe("24h");
    expect(screen.getByTestId("turn-time")).toHaveTextContent(expected24h);
    expect(screen.getByTestId("turn-actions")).toHaveTextContent(expected24h);

    view.rerender(
      <ThemeSettingsProvider
        settings={{ ...DEFAULT_THEME_SETTINGS, mode: "dark", timestampFormat: "12h" }}
      >
        <StableTurnTimestamps at={iso} />
      </ThemeSettingsProvider>,
    );

    expect(document.documentElement.dataset.octantTimestampFormat).toBe("12h");
    expect(screen.getByTestId("turn-time")).toHaveTextContent(expected12h);
    expect(screen.getByTestId("turn-actions")).toHaveTextContent(expected12h);

    // Clearing timestampFormat (e.g. importing a theme without one) must return
    // mounted components to the locale default during the same render, never
    // reading the stale `data-octant-timestamp-format` attribute.
    view.rerender(
      <ThemeSettingsProvider settings={{ ...DEFAULT_THEME_SETTINGS, mode: "dark" }}>
        <StableTurnTimestamps at={iso} />
      </ThemeSettingsProvider>,
    );

    expect(document.documentElement.dataset.octantTimestampFormat).toBeUndefined();
    expect(screen.getByTestId("turn-time")).toHaveTextContent(expectedLocaleDefault);
    expect(screen.getByTestId("turn-actions")).toHaveTextContent(expectedLocaleDefault);

    view.unmount();
    expect(document.documentElement.dataset.octantTimestampFormat).toBeUndefined();
  });
});
