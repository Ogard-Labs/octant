import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MarketplaceFetchSettings } from "./MarketplaceFetchSettings";

describe("MarketplaceFetchSettings", () => {
  it("turns marketplace fetches off in Settings", () => {
    const onEnabledChange = vi.fn();
    render(<MarketplaceFetchSettings enabled onEnabledChange={onEnabledChange} />);
    fireEvent.click(screen.getByRole("switch", { name: "Allow marketplace fetches" }));
    expect(onEnabledChange).toHaveBeenCalledWith(false);
  });

  it("keeps Search available in copy when the preference is on", () => {
    render(<MarketplaceFetchSettings enabled onEnabledChange={vi.fn()} />);
    expect(screen.getByText(/Opening the Marketplace tab does not fetch/i)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Allow marketplace fetches" })).toBeChecked();
  });
});
