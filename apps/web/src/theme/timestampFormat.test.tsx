import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_THEME_SETTINGS } from "@octant/contracts/theme";
import { TurnTime } from "../transcript/TurnHeader";
import { ThemeSettingsProvider } from "./ThemeSettingsProvider";
import { formatClockTime, formatDateTime, readActiveTimestampFormat } from "./timestampFormat";

afterEach(() => {
  delete document.documentElement.dataset.octantTimestampFormat;
});

describe("theme timestamp format", () => {
  it("formats clock times and dates as 12-hour or 24-hour from the document root preference", () => {
    const afternoon = new Date(2026, 10, 19, 15, 7, 0);

    expect(readActiveTimestampFormat()).toBeUndefined();

    document.documentElement.dataset.octantTimestampFormat = "24h";
    expect(readActiveTimestampFormat()).toBe("24h");
    expect(formatClockTime(afternoon, { hour: "2-digit", minute: "2-digit" })).toBe(
      afternoon.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }),
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
    expect(formatClockTime(afternoon, { hour: "2-digit", minute: "2-digit" })).toBe(
      afternoon.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: true }),
    );
    expect(formatDateTime(afternoon, { dateStyle: "medium", timeStyle: "short" })).toBe(
      afternoon.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
        hour12: true,
      }),
    );
  });

  it("updates rendered turn timestamps when ThemeSettingsProvider changes timestampFormat", () => {
    const todayAfternoon = new Date();
    todayAfternoon.setHours(15, 7, 0, 0);
    const iso = todayAfternoon.toISOString();

    const view = render(
      <ThemeSettingsProvider
        settings={{ ...DEFAULT_THEME_SETTINGS, mode: "dark", timestampFormat: "24h" }}
      >
        <TurnTime at={iso} />
      </ThemeSettingsProvider>,
    );

    const expected24h = todayAfternoon.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    expect(document.documentElement.dataset.octantTimestampFormat).toBe("24h");
    expect(screen.getByText(expected24h)).toBeInTheDocument();

    view.rerender(
      <ThemeSettingsProvider
        settings={{ ...DEFAULT_THEME_SETTINGS, mode: "dark", timestampFormat: "12h" }}
      >
        <TurnTime at={iso} />
      </ThemeSettingsProvider>,
    );

    const expected12h = todayAfternoon.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
    expect(document.documentElement.dataset.octantTimestampFormat).toBe("12h");
    expect(screen.getByText(expected12h)).toBeInTheDocument();

    view.unmount();
    expect(document.documentElement.dataset.octantTimestampFormat).toBeUndefined();
  });
});
