import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DEFAULT_APP_BACKGROUND, type SidebarBackgroundMetadata } from "@octant/contracts/theme";
import { AppBackgroundSettings, type BackgroundImageLibrary } from "./AppBackgroundSettings";

afterEach(cleanup);

const PHOTO_ID = "00000000-0000-4000-8000-000000000b01";
const UPLOADED_ID = "00000000-0000-4000-8000-000000000b02";
const dials = {
  patternOpacity: DEFAULT_APP_BACKGROUND.patternOpacity,
  patternSpeed: DEFAULT_APP_BACKGROUND.patternSpeed,
  patternIntensity: DEFAULT_APP_BACKGROUND.patternIntensity,
  photoOpacity: DEFAULT_APP_BACKGROUND.photoOpacity,
  scope: DEFAULT_APP_BACKGROUND.scope,
  coversSidebar: DEFAULT_APP_BACKGROUND.coversSidebar,
};

function photo(id: string, displayName: string): SidebarBackgroundMetadata {
  return {
    id,
    displayName,
    mediaType: "image/png",
    byteLength: 4,
    width: 2,
    height: 2,
    uploadedAt: "2026-09-06T10:00:00.000Z",
  } as SidebarBackgroundMetadata;
}

function library(overrides: Partial<BackgroundImageLibrary> = {}): BackgroundImageLibrary {
  return {
    list: vi.fn(async () => [photo(PHOTO_ID, "harbour.png")]),
    upload: vi.fn(async (file: File) => photo(UPLOADED_ID, file.name)),
    fetch: vi.fn(async () => new Blob([new Uint8Array([0x89, 0x50])], { type: "image/png" })),
    ...overrides,
  };
}

describe("AppBackgroundSettings", () => {
  it("saves the plain page or the theme pattern as soon as it is chosen, keeping the dials", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <AppBackgroundSettings
        background={{ ...DEFAULT_APP_BACKGROUND, patternSpeed: 80 }}
        library={library()}
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "Application background" }));
    await user.click(await screen.findByRole("option", { name: "None" }));

    expect(onChange).toHaveBeenLastCalledWith({ ...dials, kind: "none", patternSpeed: 80 });
    expect(screen.queryByRole("button", { name: "Upload photo" })).not.toBeInTheDocument();
  });

  it("only saves a photo once one is picked from the host's library", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const photos = library();
    render(
      <AppBackgroundSettings
        background={DEFAULT_APP_BACKGROUND}
        library={photos}
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "Application background" }));
    await user.click(await screen.findByRole("option", { name: "Photo" }));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("img", { name: "No photo chosen" })).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Choose an uploaded photo" }));
    expect(photos.list).toHaveBeenCalled();
    await user.click(await screen.findByRole("radio", { name: "harbour.png" }));

    expect(onChange).toHaveBeenLastCalledWith({ ...dials, kind: "photo", backgroundId: PHOTO_ID });
  });

  it("uploads a photo through the host and makes it the ground", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const photos = library();
    render(
      <AppBackgroundSettings
        background={{ ...DEFAULT_APP_BACKGROUND, kind: "photo", backgroundId: PHOTO_ID as never }}
        library={photos}
        onChange={onChange}
      />,
    );

    expect(await screen.findByRole("img", { name: "harbour.png" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Replace photo" })).toBeInTheDocument();
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "sunrise.png", {
      type: "image/png",
    });
    await user.upload(screen.getByLabelText("Choose a photo to upload"), file);

    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith({
        ...dials,
        kind: "photo",
        backgroundId: UPLOADED_ID,
      });
    });
    expect(photos.upload).toHaveBeenCalledWith(file);
  });

  it("reports a refused upload in the row instead of pretending it worked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <AppBackgroundSettings
        background={{ ...DEFAULT_APP_BACKGROUND, kind: "photo", backgroundId: PHOTO_ID as never }}
        library={library({
          upload: vi.fn(async () => {
            throw new Error("Sidebar background is too large.");
          }),
        })}
        onChange={onChange}
      />,
    );

    await user.upload(
      screen.getByLabelText("Choose a photo to upload"),
      new File([new Uint8Array(8)], "huge.png", { type: "image/png" }),
    );

    expect(await screen.findByRole("status")).toHaveTextContent("too large");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("dials the pattern's opacity, speed, and intensity, and a photo's opacity", () => {
    const onChange = vi.fn();
    render(
      <AppBackgroundSettings
        background={{ ...DEFAULT_APP_BACKGROUND, kind: "photo", backgroundId: PHOTO_ID as never }}
        library={library()}
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByRole("slider", { name: "Pattern opacity" }), {
      target: { value: "20" },
    });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ patternOpacity: 20 }));
    fireEvent.change(screen.getByRole("slider", { name: "Pattern speed" }), {
      target: { value: "0" },
    });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ patternSpeed: 0 }));
    fireEvent.change(screen.getByRole("slider", { name: "Pattern intensity" }), {
      target: { value: "100" },
    });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ patternIntensity: 100 }));
    fireEvent.change(screen.getByRole("slider", { name: "Photo opacity" }), {
      target: { value: "75" },
    });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ photoOpacity: 75 }));
  });

  it("offers the sidebar only once the ground is behind everything", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(
      <AppBackgroundSettings
        background={DEFAULT_APP_BACKGROUND}
        library={library()}
        onChange={onChange}
      />,
    );
    expect(screen.queryByRole("switch", { name: "Cover the sidebar" })).not.toBeInTheDocument();
    expect(screen.queryByRole("slider", { name: "Photo opacity" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: "Where the background shows" }));
    await user.click(await screen.findByRole("option", { name: "Everything" }));
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_APP_BACKGROUND, scope: "everywhere" });

    rerender(
      <AppBackgroundSettings
        background={{ ...DEFAULT_APP_BACKGROUND, scope: "everywhere" }}
        library={library()}
        onChange={onChange}
      />,
    );
    await user.click(screen.getByRole("switch", { name: "Cover the sidebar" }));
    expect(onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_APP_BACKGROUND,
      scope: "everywhere",
      coversSidebar: true,
    });
  });
});
