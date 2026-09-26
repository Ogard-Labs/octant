import type {
  AppBackground,
  AppBackgroundEffect,
  AppBackgroundMotion,
  AppBackgroundPercent,
  SidebarBackgroundMetadata,
} from "@octant/contracts/theme";
import { ZEN_BUILTIN_BACKGROUNDS } from "@octant/contracts/zen";
import { Check, Image as ImageIcon, Images, Upload } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { OctantButton, OctantIconButton } from "../ui/base/OctantButton";
import { OctantPopover } from "../ui/base/OctantPopover";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { SettingRow } from "./primitives";
import { SliderField } from "./SliderField";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";

/** The host's shared background image library, read through the window's authority. */
export interface BackgroundImageLibrary {
  readonly list: () => Promise<ReadonlyArray<SidebarBackgroundMetadata>>;
  readonly upload: (file: File) => Promise<SidebarBackgroundMetadata>;
  readonly fetch: (backgroundId: string) => Promise<Blob>;
}

export interface AppBackgroundSettingsProps {
  readonly background: AppBackground;
  /** Increased contrast hides the ground; the row says so instead of pretending. */
  readonly increasedContrast?: boolean;
  /** A deep link landed on this setting; the first control takes focus. */
  readonly focused?: boolean;
  readonly library?: BackgroundImageLibrary | undefined;
  readonly onChange: (next: AppBackground) => void;
}

type Choice = AppBackground["kind"];
type Dial = "patternOpacity" | "patternSpeed" | "patternIntensity" | "photoOpacity";

const ACCEPTED_TYPES = "image/png,image/jpeg,image/webp";
const LIMITS = "PNG, JPEG, or WebP up to 8 MiB and 4096×4096";

const CATALOG_GROUPS = ["landscape", "forest", "wood", "abstract"] as const;

const GROUP_TITLES: Readonly<Record<(typeof CATALOG_GROUPS)[number], string>> = {
  landscape: "Landscape",
  forest: "Forest",
  wood: "Wood",
  abstract: "Abstract",
};

/**
 * The badge under a tile is the one place a background says it moves, so a
 * title that already ends in "animated" drops it rather than saying it twice
 * ("Waving dots animated" beside a badge reading Animated).
 */
function presetName(title: string): string {
  return title.replace(/\s+animated$/i, "");
}

/** The dials and where the ground shows travel with every kind, so a
 * switch between pattern, photo, and none never loses them. */
function carry(background: AppBackground) {
  return {
    patternEnabled: background.patternEnabled,
    patternOpacity: background.patternOpacity,
    patternSpeed: background.patternSpeed,
    patternIntensity: background.patternIntensity,
    photoDithered: background.photoDithered,
    photoOpacity: background.photoOpacity,
    scope: background.scope,
    coversSidebar: background.coversSidebar,
    ...(background.effect === undefined ? {} : { effect: background.effect }),
    effectCell: background.effectCell,
    effectTones: background.effectTones,
    ...(background.motion === undefined ? {} : { motion: background.motion }),
  };
}

/** The effect a row shows: a photo saved before the choice existed reads its dither switch. */
function currentEffect(background: AppBackground): AppBackgroundEffect {
  if (background.effect !== undefined) return background.effect;
  return background.kind === "photo" && background.photoDithered ? "dither" : "none";
}

/** The motion a row shows: a ground saved before the choice existed reads its pattern switch. */
function currentMotion(background: AppBackground): AppBackgroundMotion {
  return background.motion ?? (background.patternEnabled ? "wave" : "still");
}

const EFFECTS = [
  { id: "none", label: "Off" },
  { id: "pixelate", label: "Pixelate" },
  { id: "dither", label: "Dither" },
] as const satisfies ReadonlyArray<{ id: AppBackgroundEffect; label: string }>;

const MOTIONS = [
  { id: "still", label: "Still" },
  { id: "pulse", label: "Pulse" },
  { id: "wave", label: "Wave" },
] as const satisfies ReadonlyArray<{ id: AppBackgroundMotion; label: string }>;

const MOTION_NOTES: Readonly<Record<AppBackgroundMotion, string>> = {
  still: "Nothing moves.",
  pulse: "The background slowly breathes, a little brighter and back.",
  wave: "Soft bands of dots roll slowly across the background.",
};

/**
 * Settings › Appearance › Background as an open section of shared setting
 * rows: the source, scope, pattern, and photo controls each place a label and
 * one-line description on the left and their control on the right, and the
 * built-in catalog is the one compound block, spanning the column under its
 * own quiet grouped headings.
 */
export function AppBackgroundSettings(props: AppBackgroundSettingsProps) {
  // Choosing "Photo" shows the photo controls; the setting itself only
  // changes once a photo exists, because a photo ground without a photo is
  // nothing.
  const [choice, setChoice] = useState<Choice>(props.background.kind);
  const [photos, setPhotos] = useState<ReadonlyArray<SidebarBackgroundMetadata>>([]);
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const library = props.library;
  const background = props.background;
  const selectedId = background.kind === "photo" ? String(background.backgroundId) : null;
  const selectedPresetId = background.kind === "builtin" ? background.presetId : null;
  const selectedPreset = ZEN_BUILTIN_BACKGROUNDS.find((preset) => preset.id === selectedPresetId);
  const [catalogOpen, setCatalogOpen] = useState(selectedPresetId === null);
  const showPhoto = choice === "photo" || selectedId !== null;
  const showBuiltin = choice === "builtin" || selectedPresetId !== null;
  const showDials = background.kind !== "none";
  const picture = background.kind === "builtin" || background.kind === "photo";
  const effect = currentEffect(background);
  // A photo dithered before the effect choice existed prints at 2 px and 4
  // colours. Moving one slider saves an explicit effect, which retires that
  // legacy reading, so the untouched slider's value is saved with it rather
  // than jumping to the decoded default.
  const legacyPrint = background.effect === undefined && effect === "dither";
  const printCell = legacyPrint ? 2 : background.effectCell;
  const printTones = legacyPrint ? 4 : background.effectTones;
  const motion = currentMotion(background);
  // The theme pattern is the picture itself, so its dots are always there to
  // tune; over a picture they are the Wave.
  const dotsShown = background.kind === "theme" || motion === "wave";

  useEffect(() => {
    setChoice(background.kind);
  }, [background.kind]);

  useEffect(() => {
    if (!showPhoto || library === undefined) return;
    let cancelled = false;
    library
      .list()
      .then((list) => {
        if (cancelled) return;
        // An upload that finished while this list was in flight is not in it
        // yet; keep what the row already knows rather than let a stale list
        // take a fresh photo away.
        setPhotos((current) => {
          const listed = new Set(list.map((photo) => String(photo.id)));
          return [...current.filter((photo) => !listed.has(String(photo.id))), ...list];
        });
      })
      .catch(() => {
        if (!cancelled) setStatus("Octant could not list the photos on this host.");
      });
    return () => {
      cancelled = true;
    };
  }, [library, showPhoto]);

  const choose = (kind: string) => {
    if (kind === "theme" || kind === "none") {
      setChoice(kind);
      setStatus(undefined);
      props.onChange({ ...carry(background), kind });
      return;
    }
    if (kind === "builtin") {
      setChoice("builtin");
      setStatus(undefined);
      return;
    }
    if (kind === "photo") setChoice("photo");
  };

  const pickBuiltin = (presetId: (typeof ZEN_BUILTIN_BACKGROUNDS)[number]["id"]) => {
    setStatus(undefined);
    props.onChange({ ...carry(background), kind: "builtin", presetId });
  };

  const pick = (photo: SidebarBackgroundMetadata) => {
    setStatus(undefined);
    setLibraryOpen(false);
    props.onChange({ ...carry(background), kind: "photo", backgroundId: photo.id });
  };

  const dial = (name: Dial, value: number) => {
    const percent = Math.round(Math.min(100, Math.max(0, value))) as AppBackgroundPercent;
    props.onChange({ ...background, [name]: percent });
  };

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.item(0);
    event.currentTarget.value = "";
    if (file === null || file === undefined || library === undefined) return;
    setBusy(true);
    setStatus(undefined);
    try {
      const uploaded = await library.upload(file);
      setPhotos((current) => [uploaded, ...current.filter((photo) => photo.id !== uploaded.id)]);
      props.onChange({ ...carry(background), kind: "photo", backgroundId: uploaded.id });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "The photo could not be uploaded.");
    } finally {
      setBusy(false);
    }
  };

  const current = photos.find((photo) => String(photo.id) === selectedId);

  return (
    <>
      <div className="setgroup">
        <SettingRow
          description="What sits behind Octant: the theme's dot pattern, a built-in picture, your own photo, or nothing."
          focused={props.focused === true}
          label="Background"
          labelledBySection
          scope="app"
          settingId="app-background"
        >
          <OctantSelectField
            aria-label="Application background"
            className="settings-view__select"
            onValueChange={choose}
            options={[
              { id: "theme", label: "Dot pattern" },
              { id: "builtin", label: "Built-in picture" },
              { id: "photo", label: "Your photo" },
              { id: "none", label: "None" },
            ]}
            value={choice}
          />
        </SettingRow>
      </div>
      {showBuiltin ? (
        <details
          className="settings-app-background__catalog"
          onToggle={(event) => setCatalogOpen(event.currentTarget.open)}
          open={catalogOpen}
        >
          {/* Twenty pictures in four groups were the tallest thing in
              Settings, open on every visit. The current one stands for the
              set until the person asks to change it. */}
          <summary className="settings-app-background__catalog-summary">
            {selectedPreset === undefined ? null : (
              <img
                alt=""
                className="settings-app-background__catalog-current"
                src={"stillSrc" in selectedPreset ? selectedPreset.stillSrc : selectedPreset.src}
              />
            )}
            <span className="settings-app-background__catalog-title">
              {selectedPreset === undefined
                ? "Built-in backgrounds"
                : presetName(selectedPreset.title)}
            </span>
            <span className="settings-app-background__catalog-action">
              {catalogOpen ? "Done" : "Change"}
            </span>
          </summary>
          {CATALOG_GROUPS.map((group) => {
            const presets = ZEN_BUILTIN_BACKGROUNDS.filter((preset) => preset.group === group);
            return (
              <div className="settings-app-background__group" key={group}>
                <h3 className="settings-app-background__group-title">{GROUP_TITLES[group]}</h3>
                <div
                  aria-label={`${GROUP_TITLES[group]} built-in backgrounds`}
                  className="settings-app-background__preset-grid"
                  role="radiogroup"
                >
                  {presets.map((preset) => (
                    <OctantButton
                      aria-checked={selectedPresetId === preset.id}
                      aria-label={preset.title}
                      className="settings-app-background__preset"
                      key={preset.id}
                      onClick={() => pickBuiltin(preset.id)}
                      role="radio"
                      type="button"
                      variant="ghost"
                    >
                      <img
                        alt={`${preset.title} preview`}
                        className="settings-app-background__preset-thumb"
                        loading="lazy"
                        src={"stillSrc" in preset ? preset.stillSrc : preset.src}
                      />
                      <span className="settings-app-background__preset-name">
                        {presetName(preset.title)}
                      </span>
                      {/* The caption keeps its line even when the preset does
                          not move, so every tile in the grid is one height. */}
                      <span aria-hidden="true" className="settings-app-background__preset-motion">
                        {preset.motion === "animated" ? "Animated" : ""}
                      </span>
                      {selectedPresetId === preset.id ? (
                        <span aria-hidden="true" className="settings-app-background__preset-mark">
                          <Check size={12} strokeWidth={2.4} />
                        </span>
                      ) : null}
                    </OctantButton>
                  ))}
                </div>
              </div>
            );
          })}
        </details>
      ) : null}
      {showPhoto ? (
        <div className="setgroup">
          <SettingRow
            description="A picture from this host's library."
            label="Photo"
            scope="app"
            settingId="app-background-photo"
          >
            <div className="settings-app-background__photo">
              <PhotoThumbnail library={library} photo={selectedId === null ? undefined : current} />
              <input
                accept={ACCEPTED_TYPES}
                aria-label="Choose a photo to upload"
                className="settings-app-background__file"
                disabled={busy || library === undefined}
                onChange={(event) => void upload(event)}
                ref={fileInput}
                type="file"
              />
              <OctantIconButton
                disabled={busy || library === undefined}
                label={selectedId === null ? "Upload photo" : "Replace photo"}
                onClick={() => fileInput.current?.click()}
                title={`${selectedId === null ? "Upload" : "Replace"}: ${LIMITS}`}
                type="button"
                variant="ghost"
              >
                <Upload aria-hidden="true" size={14} strokeWidth={1.7} />
              </OctantIconButton>
              {photos.length === 0 ? null : (
                <OctantPopover
                  align="end"
                  onOpenChange={setLibraryOpen}
                  open={libraryOpen}
                  title="Photos on this host"
                  trigger={<Images aria-hidden="true" size={14} strokeWidth={1.7} />}
                  triggerClassName="shell-icon-button"
                  triggerLabel="Choose an uploaded photo"
                  triggerVariant="ghost-icon"
                >
                  <div
                    aria-label="Photos on this host"
                    className="settings-app-background__grid"
                    role="radiogroup"
                  >
                    {photos.map((photo) => (
                      <PhotoChoice
                        checked={selectedId === String(photo.id)}
                        key={String(photo.id)}
                        library={library}
                        onPick={() => pick(photo)}
                        photo={photo}
                      />
                    ))}
                  </div>
                </OctantPopover>
              )}
            </div>
          </SettingRow>
          {background.kind === "photo" ? (
            <>
              <SettingRow
                description="How strongly the photo shows through the page."
                label="Photo strength"
                scope="app"
                settingId="app-background-photo-opacity"
              >
                <SliderField
                  aria-label="Photo strength"
                  className="settings-view__range"
                  max={100}
                  min={0}
                  onChange={(event) => dial("photoOpacity", Number(event.currentTarget.value))}
                  step={1}
                  format={(value) => `${String(value)}%`}
                  value={background.photoOpacity}
                />
              </SettingRow>
            </>
          ) : null}
        </div>
      ) : null}
      {showDials ? (
        <div className="setgroup">
          <SettingRow
            description="Only behind the start screens, or behind every page."
            label="Show behind"
            scope="app"
            settingId="app-background-scope"
          >
            <OctantSelectField
              aria-label="Where the background shows"
              className="settings-view__select"
              onValueChange={(scope) => {
                if (scope === "welcome" || scope === "everywhere") {
                  props.onChange({ ...background, scope });
                }
              }}
              options={[
                { id: "welcome", label: "Start screens" },
                { id: "everywhere", label: "Everything" },
              ]}
              value={background.scope}
            />
          </SettingRow>
          {background.scope === "everywhere" ? (
            <SettingRow
              description="Let the background run under the sidebar too."
              label="Cover the sidebar"
              scope="app"
              settingId="app-background-sidebar"
            >
              <OctantSwitch
                checked={background.coversSidebar}
                label="Cover the sidebar"
                onCheckedChange={(coversSidebar) =>
                  props.onChange({ ...background, coversSidebar })
                }
              />
            </SettingRow>
          ) : null}
          {picture ? (
            <SettingRow
              description="Print the picture in square pixels, or in pixels with fewer colours."
              label="Effect"
              scope="app"
              settingId="app-background-effect"
            >
              <OctantToggleGroup<AppBackgroundEffect>
                aria-label="Background effect"
                onValueChange={(value) => {
                  const next = value[0];
                  if (next !== undefined) props.onChange({ ...background, effect: next });
                }}
                value={[effect]}
              >
                {EFFECTS.map((option) => (
                  <OctantToggleGroupItem key={option.id} value={option.id}>
                    {option.label}
                  </OctantToggleGroupItem>
                ))}
              </OctantToggleGroup>
            </SettingRow>
          ) : null}
          {picture && effect !== "none" ? (
            <SettingRow
              description="How big each square is."
              label="Pixel size"
              scope="app"
              settingId="app-background-effect-cell"
            >
              <SliderField
                aria-label="Pixel size"
                className="settings-view__range"
                format={(value) => `${String(value)} px`}
                max={16}
                min={2}
                onChange={(event) =>
                  props.onChange({
                    ...background,
                    effect,
                    effectCell: Number(event.currentTarget.value),
                    effectTones: printTones,
                  })
                }
                step={1}
                value={printCell}
              />
            </SettingRow>
          ) : null}
          {picture && effect === "dither" ? (
            <SettingRow
              description="How many shades each colour keeps. Fewer looks bolder."
              label="Colours"
              scope="app"
              settingId="app-background-effect-tones"
            >
              <SliderField
                aria-label="Colours"
                className="settings-view__range"
                format={(value) => String(value)}
                max={16}
                min={2}
                onChange={(event) =>
                  props.onChange({
                    ...background,
                    effect,
                    effectCell: printCell,
                    effectTones: Number(event.currentTarget.value),
                  })
                }
                step={1}
                value={printTones}
              />
            </SettingRow>
          ) : null}
          <SettingRow
            description={MOTION_NOTES[motion]}
            label="Motion"
            scope="app"
            settingId="app-background-pattern"
          >
            <OctantToggleGroup<AppBackgroundMotion>
              aria-label="Background motion"
              onValueChange={(value) => {
                const next = value[0];
                if (next === undefined) return;
                // The older switch follows along, so a client built before
                // the motion choice still draws what this one does.
                props.onChange({
                  ...background,
                  motion: next,
                  patternEnabled: background.kind === "theme" || next === "wave",
                });
              }}
              value={[motion]}
            >
              {MOTIONS.map((option) => (
                <OctantToggleGroupItem key={option.id} value={option.id}>
                  {option.label}
                </OctantToggleGroupItem>
              ))}
            </OctantToggleGroup>
          </SettingRow>
          {motion === "wave" ? (
            <SettingRow
              description="How fast the bands roll."
              label="Wave speed"
              scope="app"
              settingId="app-background-pattern-speed"
            >
              <SliderField
                aria-label="Wave speed"
                className="settings-view__range"
                max={100}
                min={0}
                onChange={(event) => dial("patternSpeed", Number(event.currentTarget.value))}
                step={1}
                format={(value) => `${String(value)}%`}
                value={background.patternSpeed}
              />
            </SettingRow>
          ) : null}
          {dotsShown ? (
            <>
              <SettingRow
                description="How strongly the dots show."
                label="Dot strength"
                scope="app"
                settingId="app-background-pattern-opacity"
              >
                <SliderField
                  aria-label="Dot strength"
                  className="settings-view__range"
                  max={100}
                  min={0}
                  onChange={(event) => dial("patternOpacity", Number(event.currentTarget.value))}
                  step={1}
                  format={(value) => `${String(value)}%`}
                  value={background.patternOpacity}
                />
              </SettingRow>
              <SettingRow
                description="How much of the background the dots fill."
                label="Dot density"
                scope="app"
                settingId="app-background-pattern-intensity"
              >
                <SliderField
                  aria-label="Dot density"
                  className="settings-view__range"
                  max={100}
                  min={0}
                  onChange={(event) => dial("patternIntensity", Number(event.currentTarget.value))}
                  step={1}
                  format={(value) => `${String(value)}%`}
                  value={background.patternIntensity}
                />
              </SettingRow>
            </>
          ) : null}
        </div>
      ) : null}
      {props.increasedContrast === true ? (
        <p className="settings-app-background__note">Hidden while Increased contrast is on.</p>
      ) : null}
      {status === undefined ? null : (
        <p className="settings-app-background__note" role="status">
          {status}
        </p>
      )}
    </>
  );
}

function usePhotoUrl(
  library: BackgroundImageLibrary | undefined,
  photoId: string | undefined,
): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (library === undefined || photoId === undefined) {
      setUrl(null);
      return;
    }
    let revoked = false;
    let created: string | null = null;
    library
      .fetch(photoId)
      .then((blob) => {
        if (revoked) return;
        created = URL.createObjectURL(blob);
        setUrl(created);
      })
      .catch(() => {
        if (!revoked) setUrl(null);
      });
    return () => {
      revoked = true;
      if (created !== null) URL.revokeObjectURL(created);
    };
  }, [library, photoId]);
  return url;
}

/** The photo in use, or the empty frame that says none is chosen yet. */
function PhotoThumbnail(props: {
  readonly library: BackgroundImageLibrary | undefined;
  readonly photo: SidebarBackgroundMetadata | undefined;
}) {
  const url = usePhotoUrl(
    props.library,
    props.photo === undefined ? undefined : String(props.photo.id),
  );
  return (
    <span
      aria-label={props.photo === undefined ? "No photo chosen" : props.photo.displayName}
      className="settings-app-background__thumb"
      data-empty={url === null ? "true" : "false"}
      role="img"
    >
      {url === null ? (
        <ImageIcon aria-hidden="true" size={16} strokeWidth={1.6} />
      ) : (
        <img alt="" src={url} />
      )}
    </span>
  );
}

function PhotoChoice(props: {
  readonly checked: boolean;
  readonly library: BackgroundImageLibrary | undefined;
  readonly onPick: () => void;
  readonly photo: SidebarBackgroundMetadata;
}) {
  const url = usePhotoUrl(props.library, String(props.photo.id));
  return (
    <OctantButton
      aria-checked={props.checked}
      aria-label={props.photo.displayName}
      className="settings-view__preset-swatch settings-view__preset-swatch--photo"
      onClick={props.onPick}
      role="radio"
      type="button"
      variant="ghost"
    >
      {url === null ? null : <img alt="" src={url} />}
      {props.checked ? (
        <span aria-hidden="true" className="settings-view__selection-mark">
          ✓
        </span>
      ) : null}
    </OctantButton>
  );
}
