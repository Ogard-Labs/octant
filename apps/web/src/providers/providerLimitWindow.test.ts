import { describe, expect, it } from "vitest";
import { providerLimitWindowShortLabel } from "./providerLimitWindow";

describe("provider limit window short names", () => {
  it("names a five-hour window by its length", () => {
    expect(providerLimitWindowShortLabel("five_hour")).toBe("5h");
    expect(providerLimitWindowShortLabel("primary_5h")).toBe("5h");
  });

  it("names a seven-day window as the week it meters", () => {
    expect(providerLimitWindowShortLabel("seven_day")).toBe("Week");
    expect(providerLimitWindowShortLabel("secondary_7d")).toBe("Week");
  });

  it("keeps the full label for a window whose length is not a plain duration", () => {
    expect(providerLimitWindowShortLabel("gpt-5:weekly-opus")).toBe("weekly-opus limit");
  });
});
