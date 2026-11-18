import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  decodeAppBackground,
  DEFAULT_APP_BACKGROUND,
  type SidebarBackgroundMetadata,
} from "@octant/contracts/theme";
import { ZEN_BUILTIN_BACKGROUNDS } from "@octant/contracts/zen";
import { DEFAULT_CHARACTER_SET } from "@octant/domain/theme-policy";
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

  it("saves the pixel ground in one choice, then picks its scene, sizes, shades, and stills it", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(
      <AppBackgroundSettings
        background={DEFAULT_APP_BACKGROUND}
        library={library()}
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "Application background" }));
    await user.click(await screen.findByRole("option", { name: "Pixel ground" }));
    // It opens on Ridges at the four shades the scenes are drawn for.
    expect(onChange).toHaveBeenLastCalledWith({
      ...dials,
      kind: "pixels",
      scene: "ridges",
      effectTones: 4,
    });

    const field = { ...DEFAULT_APP_BACKGROUND, kind: "pixels" as const };
    rerender(<AppBackgroundSettings background={field} library={library()} onChange={onChange} />);
    // The field is always printed: no "Off", and it dithers until told otherwise.
    const effect = screen.getByRole("group", { name: "Background effect" });
    expect(within(effect).queryByRole("button", { name: "Off" })).toBeNull();
    expect(within(effect).getByRole("button", { name: "Dither" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("slider", { name: "Pixel size" })).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Colours" })).toBeInTheDocument();
    // A row saved before scenes existed shows Drift; the picker offers all four.
    const scene = screen.getByRole("combobox", { name: "Pixel ground scene" });
    expect(scene).toHaveTextContent("Drift");
    await user.click(scene);
    expect(await screen.findAllByRole("option")).toHaveLength(4);
    await user.click(screen.getByRole("option", { name: "Burst" }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "pixels", scene: "burst" }),
    );
    const motion = screen.getByRole("group", { name: "Background motion" });
    expect(within(motion).getByRole("button", { name: "Wave" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(within(motion).getByRole("button", { name: "Still" }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ motion: "still" }));
  });

  it("saves a photo under the Picture scene as part of the pixel ground, not as a photo ground", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <AppBackgroundSettings
        background={{ ...DEFAULT_APP_BACKGROUND, kind: "pixels", scene: "picture" }}
        library={library()}
        onChange={onChange}
      />,
    );

    await user.click(await screen.findByRole("radio", { name: "harbour.png" }));

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "pixels", scene: "picture", backgroundId: PHOTO_ID }),
    );
  });

  it("saves the ASCII field as the ground in one choice, keeping every dial", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <AppBackgroundSettings
        background={DEFAULT_APP_BACKGROUND}
        library={library()}
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "Application background" }));
    await user.click(await screen.findByRole("option", { name: "ASCII field" }));

    expect(onChange).toHaveBeenLastCalledWith({ ...dials, kind: "characters" });
  });

  it("saves flowing colour as the ground in one choice, then stills the field", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(
      <AppBackgroundSettings
        background={DEFAULT_APP_BACKGROUND}
        library={library()}
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "Application background" }));
    await user.click(await screen.findByRole("option", { name: "Flowing" }));
    expect(onChange).toHaveBeenLastCalledWith({ ...dials, kind: "flowing" });

    const field = { ...DEFAULT_APP_BACKGROUND, kind: "flowing" as const };
    rerender(<AppBackgroundSettings background={field} library={library()} onChange={onChange} />);
    expect(screen.queryByRole("group", { name: "Background effect" })).toBeNull();
    const motion = screen.getByRole("group", { name: "Background motion" });
    expect(within(motion).getByRole("button", { name: "Wave" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(within(motion).getByRole("button", { name: "Still" }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ motion: "still" }));
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

  it("prints a picture as it is, pixelated, or dithered, offers motion only once printed, and never dots", async () => {
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
    // A print stays still until a person asks it to wave.
    const motion = screen.getByRole("group", { name: "Background motion" });
    expect(within(motion).getByRole("button", { name: "Still" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(within(motion).getByRole("button", { name: "Wave" }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ effect: "pixelate", motion: "wave" }),
    );

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

    // ASCII starts at a readable character size and offers no tones or Motion.
    await user.click(screen.getByRole("button", { name: "ASCII" }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ effect: "ascii", effectCell: 14 }),
    );
    rerender(
      <AppBackgroundSettings
        background={{ ...walnut, effect: "ascii", effectCell: 14 }}
        library={library()}
        onChange={onChange}
      />,
    );
    expect(screen.getByRole("slider", { name: "Pixel size" })).toBeInTheDocument();
    expect(screen.queryByRole("slider", { name: "Colours" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Background motion" })).toBeNull();
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

  it("starts a fresh install on the character field", () => {
    render(
      <AppBackgroundSettings
        background={DEFAULT_APP_BACKGROUND}
        library={library()}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("combobox", { name: "Application background" })).toHaveTextContent(
      "ASCII field",
    );
  });

  it("shows a ground saved as the retired dot pattern as None, with nothing to tune", () => {
    render(
      <AppBackgroundSettings
        background={decodeAppBackground({ kind: "theme" })}
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

  it("has no separate sidebar switch when the ground is behind everything", async () => {
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
    expect(screen.queryByRole("switch", { name: "Cover the sidebar" })).not.toBeInTheDocument();
  });

  it("says the photo was added and shows it in the gallery, marked as the one in use", async () => {
    const user = userEvent.setup();
    render(
      <AppBackgroundSettings
        background={{ ...DEFAULT_APP_BACKGROUND, kind: "photo", backgroundId: PHOTO_ID as never }}
        library={library()}
        onChange={vi.fn()}
      />,
    );

    await user.upload(
      screen.getByLabelText("Choose a photo to upload"),
      new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "sunrise.png", { type: "image/png" }),
    );

    expect(await screen.findByText("Photo added.")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "sunrise.png" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "harbour.png" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("marks the photo in use in the gallery and uses another one when it is clicked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <AppBackgroundSettings
        background={{ ...DEFAULT_APP_BACKGROUND, kind: "photo", backgroundId: PHOTO_ID as never }}
        library={library({
          list: vi.fn(async () => [
            photo(PHOTO_ID, "harbour.png"),
            photo(UPLOADED_ID, "sunrise.png"),
          ]),
        })}
        onChange={onChange}
      />,
    );

    const current = await screen.findByRole("radio", { name: "harbour.png" });
    expect(current).toHaveAttribute("aria-checked", "true");
    await user.click(await screen.findByRole("radio", { name: "sunrise.png" }));

    expect(onChange).toHaveBeenLastCalledWith({
      ...dials,
      kind: "photo",
      backgroundId: UPLOADED_ID,
    });
  });

  it("removes a photo only after the person confirms, and never offers it for the photo in use", async () => {
    const user = userEvent.setup();
    const remove = vi.fn(async () => undefined);
    render(
      <AppBackgroundSettings
        background={{ ...DEFAULT_APP_BACKGROUND, kind: "photo", backgroundId: PHOTO_ID as never }}
        library={library({
          list: vi.fn(async () => [
            photo(PHOTO_ID, "harbour.png"),
            photo(UPLOADED_ID, "sunrise.png"),
          ]),
          remove,
        })}
        onChange={vi.fn()}
      />,
    );

    await screen.findByRole("radio", { name: "sunrise.png" });
    expect(screen.queryByRole("button", { name: "Remove harbour.png" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove sunrise.png" }));
    expect(remove).not.toHaveBeenCalled();
    await user.click(
      within(screen.getByRole("group", { name: "Remove sunrise.png?" })).getByRole("button", {
        name: "Keep",
      }),
    );
    expect(screen.getByRole("radio", { name: "sunrise.png" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove sunrise.png" }));
    await user.click(
      within(screen.getByRole("group", { name: "Remove sunrise.png?" })).getByRole("button", {
        name: "Remove",
      }),
    );

    expect(remove).toHaveBeenCalledExactlyOnceWith(UPLOADED_ID);
    await waitFor(() =>
      expect(screen.queryByRole("radio", { name: "sunrise.png" })).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Photo removed.")).toBeInTheDocument();
  });

  it("keeps a photo the host refuses to remove and says why", async () => {
    const user = userEvent.setup();
    render(
      <AppBackgroundSettings
        background={{ ...DEFAULT_APP_BACKGROUND, kind: "photo", backgroundId: PHOTO_ID as never }}
        library={library({
          list: vi.fn(async () => [
            photo(PHOTO_ID, "harbour.png"),
            photo(UPLOADED_ID, "sunrise.png"),
          ]),
          remove: vi.fn(async () => {
            throw new Error("The sidebar is showing this photo, so it cannot be deleted.");
          }),
        })}
        onChange={vi.fn()}
      />,
    );

    await screen.findByRole("radio", { name: "sunrise.png" });
    await user.click(screen.getByRole("button", { name: "Remove sunrise.png" }));
    await user.click(
      within(screen.getByRole("group", { name: "Remove sunrise.png?" })).getByRole("button", {
        name: "Remove",
      }),
    );

    expect(await screen.findByText(/cannot be deleted/)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "sunrise.png" })).toBeInTheDocument();
  });

  describe("character field customization", () => {
    const characters = { ...DEFAULT_APP_BACKGROUND, kind: "characters" as const };

    async function openCustomize(user: ReturnType<typeof userEvent.setup>) {
      await user.click(screen.getByText("Customize"));
    }

    it("offers Customize only while the character field is the ground", () => {
      const { rerender } = render(
        <AppBackgroundSettings
          background={{ ...DEFAULT_APP_BACKGROUND, kind: "none" }}
          onChange={vi.fn()}
        />,
      );
      expect(screen.queryByText("Customize")).toBeNull();
      rerender(<AppBackgroundSettings background={characters} onChange={vi.fn()} />);
      expect(screen.getByText("Customize")).toBeInTheDocument();
    });

    it("updates the ground as a person types their own characters", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<AppBackgroundSettings background={characters} onChange={onChange} />);
      await openCustomize(user);
      const field = screen.getByRole("textbox", { name: "Characters" });
      await user.clear(field);
      await user.type(field, "01");
      expect(onChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: "characters", characterSet: "01" }),
      );
    });

    it("keeps the last good set and says why when an emoji is typed", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(
        <AppBackgroundSettings
          background={{ ...characters, characterSet: "01" }}
          onChange={onChange}
        />,
      );
      await openCustomize(user);
      const field = screen.getByRole("textbox", { name: "Characters" });
      await user.type(field, "😀");
      expect(onChange).not.toHaveBeenCalled();
      expect(screen.getByText(/Emoji and spaces are left out/)).toBeInTheDocument();
    });

    it("moves density and speed on the ground", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<AppBackgroundSettings background={characters} onChange={onChange} />);
      await openCustomize(user);
      fireEvent.change(screen.getByRole("slider", { name: "Density" }), {
        target: { value: "80" },
      });
      expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ characterDensity: 80 }));
      fireEvent.change(screen.getByRole("slider", { name: "Speed" }), { target: { value: "0" } });
      expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ characterSpeed: 0 }));
    });

    it("resets the characters, density and speed to the default field", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(
        <AppBackgroundSettings
          background={{
            ...characters,
            characterSet: "01",
            characterDensity: 80,
            characterSpeed: 10,
          }}
          onChange={onChange}
        />,
      );
      await openCustomize(user);
      await user.click(screen.getByRole("button", { name: "Reset" }));
      const next = onChange.mock.calls.at(-1)?.[0];
      expect(next).toMatchObject({ kind: "characters" });
      expect(next).not.toHaveProperty("characterSet");
      expect(next).not.toHaveProperty("characterDensity");
      expect(next).not.toHaveProperty("characterSpeed");
    });

    it("previews slider and typing changes and saves once when the person lets go", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      const onPreview = vi.fn();
      render(
        <AppBackgroundSettings background={characters} onChange={onChange} onPreview={onPreview} />,
      );
      await openCustomize(user);
      const density = screen.getByRole("slider", { name: "Density" });
      fireEvent.change(density, { target: { value: "60" } });
      fireEvent.change(density, { target: { value: "70" } });
      expect(onPreview).toHaveBeenCalledTimes(2);
      expect(onChange).not.toHaveBeenCalled();
      fireEvent.pointerUp(density);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ characterDensity: 70 }));
      const field = screen.getByRole("textbox", { name: "Characters" });
      await user.clear(field);
      await user.type(field, "01");
      expect(onChange).toHaveBeenCalledTimes(1);
      await user.keyboard("{Enter}");
      expect(onChange).toHaveBeenCalledTimes(2);
      expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ characterSet: "01" }));
    });

    it("clears the typed text and the note when Reset is pressed", async () => {
      const user = userEvent.setup();
      render(<AppBackgroundSettings background={characters} onChange={vi.fn()} />);
      await openCustomize(user);
      const field = screen.getByRole("textbox", { name: "Characters" });
      await user.type(field, "😀");
      expect(screen.getByText(/Emoji and spaces are left out/)).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Reset" }));
      expect(screen.queryByText(/Emoji and spaces are left out/)).toBeNull();
      expect(field).toHaveValue(DEFAULT_CHARACTER_SET);
    });
  });
});
