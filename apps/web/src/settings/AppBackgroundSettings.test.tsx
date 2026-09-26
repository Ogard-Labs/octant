import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DEFAULT_APP_BACKGROUND, type SidebarBackgroundMetadata } from "@octant/contracts/theme";
import { ZEN_BUILTIN_BACKGROUNDS } from "@octant/contracts/zen";
import { AppBackgroundSettings, type BackgroundImageLibrary } from "./AppBackgroundSettings";

afterEach(cleanup);

const PHOTO_ID = "00000000-0000-4000-8000-000000000b01";
const UPLOADED_ID = "00000000-0000-4000-8000-000000000b02";
const dials = {
  patternEnabled: DEFAULT_APP_BACKGROUND.patternEnabled,
  patternOpacity: DEFAULT_APP_BACKGROUND.patternOpacity,
  patternSpeed: DEFAULT_APP_BACKGROUND.patternSpeed,
  patternIntensity: DEFAULT_APP_BACKGROUND.patternIntensity,
  photoDithered: DEFAULT_APP_BACKGROUND.photoDithered,
  photoOpacity: DEFAULT_APP_BACKGROUND.photoOpacity,
  scope: DEFAULT_APP_BACKGROUND.scope,
  coversSidebar: DEFAULT_APP_BACKGROUND.coversSidebar,
  effectCell: DEFAULT_APP_BACKGROUND.effectCell,
  effectTones: DEFAULT_APP_BACKGROUND.effectTones,
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
  it("saves the plain page as soon as it is chosen, keeping the dials", async () => {
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
    await user.click(await screen.findByRole("option", { name: "Your photo" }));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("img", { name: "No photo chosen" })).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Choose an uploaded photo" }));
    expect(photos.list).toHaveBeenCalled();
    await user.click(await screen.findByRole("radio", { name: "harbour.png" }));

    expect(onChange).toHaveBeenLastCalledWith({ ...dials, kind: "photo", backgroundId: PHOTO_ID });
  });

  it("shows Zen built-in previews and saves the selected one as the workspace ground", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const preset = ZEN_BUILTIN_BACKGROUNDS[0];
    render(
      <AppBackgroundSettings
        background={DEFAULT_APP_BACKGROUND}
        library={library()}
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "Application background" }));
    await user.click(await screen.findByRole("option", { name: "Built-in picture" }));

    expect(screen.getByRole("radio", { name: preset.title })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: `${preset.title} preview` })).toHaveAttribute(
      "src",
      preset.src,
    );
    await user.click(screen.getByRole("radio", { name: preset.title }));

    expect(onChange).toHaveBeenLastCalledWith({
      ...dials,
      kind: "builtin",
      presetId: preset.id,
    });
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

  it("keeps a photo uploaded while the library list was still in flight", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    let settleList: (photos: ReadonlyArray<SidebarBackgroundMetadata>) => void = () => undefined;
    const photos = library({
      list: vi.fn(
        () =>
          new Promise<ReadonlyArray<SidebarBackgroundMetadata>>((resolve) => {
            settleList = resolve;
          }),
      ),
    });
    render(
      <AppBackgroundSettings
        background={{ ...DEFAULT_APP_BACKGROUND, kind: "photo", backgroundId: PHOTO_ID as never }}
        library={photos}
        onChange={onChange}
      />,
    );

    await user.upload(
      screen.getByLabelText("Choose a photo to upload"),
      new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "sunrise.png", { type: "image/png" }),
    );
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    // The list answers late and knows nothing of the upload.
    settleList([photo(PHOTO_ID, "harbour.png")]);

    await user.click(await screen.findByRole("button", { name: "Choose an uploaded photo" }));
    expect(await screen.findByRole("radio", { name: "sunrise.png" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "harbour.png" })).toBeInTheDocument();
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

  it("shows each built-in as a still preview with one visible name and its motion beside it", async () => {
    const user = userEvent.setup();
    const selected = ZEN_BUILTIN_BACKGROUNDS[0]!;
    const animated = ZEN_BUILTIN_BACKGROUNDS.find(
      (preset) => preset.id === "waving-dot-field-animated",
    );
    if (animated === undefined)
      throw new Error("Expected the Waving dots animated built-in preset");
    const onChange = vi.fn();
    render(
      <AppBackgroundSettings
        background={{ ...DEFAULT_APP_BACKGROUND, kind: "builtin", presetId: selected.id }}
        library={library()}
        onChange={onChange}
      />,
    );

    const tile = screen.getByRole("radio", { name: selected.title });
    expect(tile).toHaveAttribute("aria-checked", "true");
    expect(
      within(tile).getByRole("img", { name: `${selected.title} preview` }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(ZEN_BUILTIN_BACKGROUNDS.length);

    // The caption carries the motion, so the visible name drops the "animated"
    // the title ends with; the literal keeps this able to fail if it does not.
    const animatedTile = screen.getByRole("radio", { name: "Waving dots animated" });
    expect(within(animatedTile).getByText("Waving dots")).toBeInTheDocument();
    expect(within(animatedTile).getByText("Animated")).toBeInTheDocument();

    await user.click(animatedTile);
    expect(onChange).toHaveBeenLastCalledWith({
      ...dials,
      kind: "builtin",
      presetId: animated.id,
    });
  });

  it("dials a photo's strength", () => {
    const onChange = vi.fn();
    render(
      <AppBackgroundSettings
        background={{ ...DEFAULT_APP_BACKGROUND, kind: "photo", backgroundId: PHOTO_ID as never }}
        library={library()}
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByRole("slider", { name: "Photo strength" }), {
      target: { value: "75" },
    });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ photoOpacity: 75 }));
  });

  it("prints a picture as it is, pixelated, or dithered, and never offers motion or dots", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const walnut = {
      ...DEFAULT_APP_BACKGROUND,
      kind: "builtin" as const,
      presetId: "warm-walnut-planks" as never,
    };
    const { rerender } = render(
      <AppBackgroundSettings background={walnut} library={library()} onChange={onChange} />,
    );
    expect(screen.queryByRole("group", { name: "Background motion" })).toBeNull();
    expect(screen.queryByRole("slider", { name: "Dot strength" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Pixelate" }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ effect: "pixelate" }));

    rerender(
      <AppBackgroundSettings
        background={{ ...walnut, effect: "pixelate" }}
        library={library()}
        onChange={onChange}
      />,
    );
    expect(screen.getByRole("slider", { name: "Pixel size" })).toBeInTheDocument();
    expect(screen.queryByRole("slider", { name: "Colours" })).toBeNull();

    rerender(
      <AppBackgroundSettings
        background={{ ...walnut, effect: "dither" }}
        library={library()}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByRole("slider", { name: "Colours" }), {
      target: { value: "5" },
    });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ effect: "dither", effectTones: 5 }),
    );
  });

  it("reads a photo saved before the effect choice as dithered", () => {
    const saved = {
      ...DEFAULT_APP_BACKGROUND,
      kind: "photo" as const,
      backgroundId: PHOTO_ID as never,
    };
    render(<AppBackgroundSettings background={saved} library={library()} onChange={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Dither" })).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps an older dithered photo's other print value when one slider moves", () => {
    const onChange = vi.fn();
    const saved = {
      ...DEFAULT_APP_BACKGROUND,
      kind: "photo" as const,
      backgroundId: PHOTO_ID as never,
      photoDithered: true,
    };
    render(<AppBackgroundSettings background={saved} library={library()} onChange={onChange} />);

    fireEvent.change(screen.getByRole("slider", { name: "Pixel size" }), {
      target: { value: "5" },
    });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ effect: "dither", effectCell: 5, effectTones: 4 }),
    );
    fireEvent.change(screen.getByRole("slider", { name: "Colours" }), {
      target: { value: "6" },
    });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ effect: "dither", effectCell: 2, effectTones: 6 }),
    );
  });

  it("folds the built-in pictures behind the chosen one until asked to change it", async () => {
    const user = userEvent.setup();
    render(
      <AppBackgroundSettings
        background={{
          ...DEFAULT_APP_BACKGROUND,
          kind: "builtin",
          presetId: "warm-walnut-planks" as never,
        }}
        library={library()}
        onChange={vi.fn()}
      />,
    );
    const catalog = document.querySelector("details.settings-app-background__catalog");
    expect(catalog?.querySelector("summary")).toHaveTextContent("Warm walnut");
    expect(catalog).not.toHaveAttribute("open");
    await user.click(screen.getByText("Change"));
    expect(catalog).toHaveAttribute("open");
    expect(screen.getByRole("radio", { name: "Warm walnut" })).toBeChecked();
  });

  it("shows a ground saved as the retired dot pattern as None, with nothing to tune", () => {
    render(
      <AppBackgroundSettings
        background={DEFAULT_APP_BACKGROUND}
        library={library()}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("combobox", { name: "Application background" })).toHaveTextContent(
      "None",
    );
    expect(screen.queryByRole("group", { name: "Background effect" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Where the background shows" })).toBeNull();
  });

  it("offers the sidebar only once the ground is behind everything", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const walnut = {
      ...DEFAULT_APP_BACKGROUND,
      kind: "builtin" as const,
      presetId: "warm-walnut-planks" as never,
    };
    const { rerender } = render(
      <AppBackgroundSettings background={walnut} library={library()} onChange={onChange} />,
    );
    expect(screen.queryByRole("switch", { name: "Cover the sidebar" })).not.toBeInTheDocument();
    expect(screen.queryByRole("slider", { name: "Photo strength" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: "Where the background shows" }));
    await user.click(await screen.findByRole("option", { name: "Everything" }));
    expect(onChange).toHaveBeenLastCalledWith({ ...walnut, scope: "everywhere" });

    rerender(
      <AppBackgroundSettings
        background={{ ...walnut, scope: "everywhere" }}
        library={library()}
        onChange={onChange}
      />,
    );
    await user.click(screen.getByRole("switch", { name: "Cover the sidebar" }));
    expect(onChange).toHaveBeenLastCalledWith({
      ...walnut,
      scope: "everywhere",
      coversSidebar: true,
    });
  });
});
