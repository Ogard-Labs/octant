import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MarketplaceFetchDisclosure, MarketplaceFetchSettings } from "./MarketplaceFetchSettings";

describe("MarketplaceFetchSettings", () => {
  it("turns marketplace fetches off in Settings", () => {
    const onEnabledChange = vi.fn();
    render(<MarketplaceFetchSettings enabled onEnabledChange={onEnabledChange} />);
    fireEvent.click(screen.getByRole("switch", { name: "Allow marketplace fetches" }));
    expect(onEnabledChange).toHaveBeenCalledWith(false);
  });

  it("keeps network details collapsed until they are requested", () => {
    render(<MarketplaceFetchDisclosure />);
    const disclosure = screen.getByText("Network details").closest("details");
    expect(disclosure).not.toHaveAttribute("open");
    expect(screen.getByText(/Opening Marketplace never fetches/i)).not.toBeVisible();
    fireEvent.click(screen.getByText("Network details"));
    expect(screen.getByText(/Opening Marketplace never fetches/i)).toBeVisible();
  });
});
