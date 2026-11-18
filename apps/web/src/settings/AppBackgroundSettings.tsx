import type {
  AppBackground,
  AppBackgroundCharacterPattern,
  AppBackgroundEffect,
  AppBackgroundPercent,
  AppBackgroundScene,
  SidebarBackgroundMetadata,
} from "@octant/contracts/theme";
import { ZEN_BUILTIN_BACKGROUNDS } from "@octant/contracts/zen";
import type { ContributedGround } from "@octant/plugin-host/grounds";
import { ASCII_DEFAULT_CELL, ASCII_MIN_CELL, asciiCell } from "@octant/domain/ascii-print";
import {
  DEFAULT_CHARACTER_LEVEL,
  DEFAULT_CHARACTER_SET,
  cleanCharacterSet,
} from "@octant/domain/theme-policy";
import { Check, Image as ImageIcon, Images, Upload, X } from "../ui/icons";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { OctantButton, OctantIconButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { SettingRow, SettingsDisclosure } from "./primitives";
import { SliderField } from "./SliderField";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";
import { usePluginGrounds } from "../theme/pluginGrounds";
import { moveWithinRadioGroup } from "../ui/base/radioGroupKeys";
import { MARK_TICK_STROKE_WIDTH } from "../ui/IconDefaults";

/** The host's shared background image library, read through the window's authority. */
export interface BackgroundImageLibrary {
  readonly list: () => Promise<ReadonlyArray<SidebarBackgroundMetadata>>;
  readonly upload: (file: File) => Promise<SidebarBackgroundMetadata>;
  readonly fetch: (backgroundId: string) => Promise<Blob>;
  /** Absent when the host cannot delete a photo; the gallery then offers no Remove. */
  readonly remove?: (backgroundId: string) => Promise<void>;
}

export interface AppBackgroundSettingsProps {
  readonly background: AppBackground;
  /** Increased contrast hides the ground; the row says so instead of pretending. */
  readonly increasedContrast?: boolean;
  /** A deep link landed on this setting; the first control takes focus. */
  readonly focused?: boolean;
  readonly library?: BackgroundImageLibrary | undefined;
  readonly onChange: (next: AppBackground) => void;
  /**
   * Shows a change without saving it. The character controls preview each
   * keystroke or slider tick through it and save once with `onChange` when the
   * person lets go. Absent, they save each change as it happens.
   */
  readonly onPreview?: (next: AppBackground) => void;
}

type Choice = "builtin" | "photo" | "characters" | "pixels" | "flowing" | "none";

/** A ground saved as the retired dot pattern draws nothing, and says so. */
function choiceFor(kind: AppBackground["kind"]): Choice {
  return kind === "theme" ? "none" : kind;
}

const ACCEPTED_TYPES = "image/png,image/jpeg,image/webp";
const PHOTO_ADDED = "Photo added.";
const PHOTO_REMOVED = "Photo removed.";
const LIMITS = "PNG, JPEG, or WebP up to 8 MiB and 4096×4096";

const CATALOG_GROUPS = ["gradient", "landscape", "forest", "wood", "abstract"] as const;

const GROUP_TITLES: Readonly<Record<(typeof CATALOG_GROUPS)[number], string>> = {
  gradient: "Gradient",
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

/** Every stored dial travels with every kind, so a switch between a
 * built-in, a photo, and none never loses one. */
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
    ...(background.scene === undefined ? {} : { scene: background.scene }),
    ...(background.characterSet === undefined ? {} : { characterSet: background.characterSet }),
    ...(background.characterDensity === undefined
      ? {}
      : { characterDensity: background.characterDensity }),
    ...(background.characterSpeed === undefined
      ? {}
      : { characterSpeed: background.characterSpeed }),
    ...(background.characterPattern === undefined
      ? {}
      : { characterPattern: background.characterPattern }),
  };
}

/** Ready-made sets for the character field; the first is what it draws by default. */
const STARTER_SETS = [
  { id: "letters", label: "Letters and digits", characters: DEFAULT_CHARACTER_SET },
  { id: "binary", label: "Binary", characters: "01" },
  { id: "dots", label: "Dots", characters: "·•●" },
  { id: "shades", label: "Shades", characters: "░▒▓█" },
  { id: "lines", label: "Lines", characters: "─│┼╱╲" },
] as const;

/** What the character field draws; all in turn is what it did before the choice. */
const CHARACTER_PATTERNS = [
  { id: "cycle", label: "All in turn" },
  { id: "blotches", label: "Blotches" },
  { id: "currents", label: "Currents" },
  { id: "rings", label: "Rings" },
] as const satisfies ReadonlyArray<{ id: AppBackgroundCharacterPattern; label: string }>;

const CHARACTERS_HINT = "Up to 64 characters. The field draws only these.";
// Shorter than the hint, so swapping one for the other never wraps the row.
const REFUSED_CHARACTERS = "Emoji and spaces are left out.";

/** What the pixel ground can draw; a row saved before scenes existed shows Drift. */
const SCENES = [
  { id: "ridges", label: "Ridges" },
  { id: "burst", label: "Burst" },
  { id: "drift", label: "Drift" },
  { id: "picture", label: "Your picture" },
] as const satisfies ReadonlyArray<{ id: AppBackgroundScene; label: string }>;

/** A fresh pixel ground opens on Ridges at the bolder four shades the scenes are drawn for. */
const FIELD_TONES = 4;

/** The effect a row shows: a photo saved before the choice existed reads its dither switch. */
function currentEffect(background: AppBackground): AppBackgroundEffect {
  if (background.effect !== undefined) return background.effect;
  return background.kind === "photo" && background.photoDithered ? "dither" : "none";
}

/** The pixel field is always printed, so it offers only the two prints. */
const FIELD_EFFECTS = [
  { id: "pixelate", label: "Pixelate" },
  { id: "dither", label: "Dither" },
] as const satisfies ReadonlyArray<{ id: AppBackgroundEffect; label: string }>;

type Motion = "still" | "wave";

/**
 * Whether the ground moves, as the row shows it: a drawn field moves unless
 * a person chose Still; a printed picture moves only once a person chose Wave.
 */
function currentMotion(background: AppBackground): Motion {
  if (background.motion === "still") return "still";
  if (background.motion === "wave" || background.motion === "pulse") return "wave";
  return background.kind === "characters" ||
    background.kind === "pixels" ||
    background.kind === "flowing"
    ? "wave"
    : "still";
}

const EFFECTS = [
  { id: "none", label: "Off" },
  { id: "pixelate", label: "Pixelate" },
  { id: "dither", label: "Dither" },
  { id: "ascii", label: "ASCII" },
] as const satisfies ReadonlyArray<{ id: AppBackgroundEffect; label: string }>;

/**
 * Settings › Appearance › Background as an open section of shared setting
 * rows: the source, scope, effect, and photo controls each place a label and
 * one-line description on the left and their control on the right, and the
 * built-in catalog is the one compound block, spanning the column under its
 * own quiet grouped headings.
 */
export function AppBackgroundSettings(props: AppBackgroundSettingsProps) {
  // Choosing "Photo" shows the photo controls; the setting itself only
  // changes once a photo exists, because a photo ground without a photo is
  // nothing.
  const [choice, setChoice] = useState<Choice>(choiceFor(props.background.kind));
  const [photos, setPhotos] = useState<ReadonlyArray<SidebarBackgroundMetadata>>([]);
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [confirmingRemoval, setConfirmingRemoval] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const library = props.library;
  const background = props.background;
  const pluginGrounds = usePluginGrounds();
  const savedCharacters =
    background.kind === "characters"
      ? (background.characterSet ?? DEFAULT_CHARACTER_SET)
      : DEFAULT_CHARACTER_SET;
  // What the person is typing. A refused text stays in the box with its note
  // while the ground keeps the last good set.
  const [typed, setTyped] = useState(savedCharacters);
  const [typedRefused, setTypedRefused] = useState(false);
  const charactersBox = useRef<HTMLInputElement>(null);
  // The ground the character controls are previewing and have not saved yet.
  const unsaved = useRef<AppBackground | undefined>(undefined);
  useEffect(() => {
    // The box keeps what the person is typing; the saved value never overwrites it mid-edit.
    if (charactersBox.current !== null && document.activeElement === charactersBox.current) return;
    setTyped(savedCharacters);
    setTypedRefused(false);
  }, [savedCharacters]);
  const previewCharacters = (next: AppBackground) => {
    if (props.onPreview === undefined) {
      props.onChange(next);
      return;
    }
    unsaved.current = next;
    props.onPreview(next);
  };
  const saveCharacters = (next?: AppBackground) => {
    const pending = next ?? unsaved.current;
    unsaved.current = undefined;
    if (pending !== undefined) props.onChange(pending);
  };
  // A plugin's ground is copied into the person's own (never saved as a
  // reference), so it keeps working when the plugin is switched off.
  const pickPluginGround = (picked: ContributedGround) => {
    const {
      characterSet: _set,
      characterDensity: _density,
      characterSpeed: _speed,
      characterPattern: _pattern,
      ...rest
    } = background;
    setTyped(picked.ground.characterSet);
    setTypedRefused(false);
    saveCharacters({
      ...rest,
      characterSet: picked.ground.characterSet,
      ...(picked.ground.characterDensity === undefined
        ? {}
        : { characterDensity: picked.ground.characterDensity }),
      ...(picked.ground.characterSpeed === undefined
        ? {}
        : { characterSpeed: picked.ground.characterSpeed }),
      ...(picked.ground.characterPattern === undefined
        ? {}
        : { characterPattern: picked.ground.characterPattern }),
    });
  };
  const field = background.kind === "pixels";
  const scene: AppBackgroundScene = (field ? background.scene : undefined) ?? "drift";
  const selectedId =
    background.kind === "photo"
      ? String(background.backgroundId)
      : field && scene === "picture" && background.backgroundId !== undefined
        ? String(background.backgroundId)
        : null;
  const selectedPresetId = background.kind === "builtin" ? background.presetId : null;
  const selectedPreset = ZEN_BUILTIN_BACKGROUNDS.find((preset) => preset.id === selectedPresetId);
  const [catalogOpen, setCatalogOpen] = useState(selectedPresetId === null);
  const showPhoto =
    choice === "photo" ||
    selectedId !== null ||
    (choice === "pixels" && field && scene === "picture");
  const showBuiltin = choice === "builtin" || selectedPresetId !== null;
  const showDials = choiceFor(background.kind) !== "none";
  const picture = background.kind === "builtin" || background.kind === "photo";
  const savedEffect = currentEffect(background);
  // The pixel field has no plain print; a field saved without one dithers.
  const effect: AppBackgroundEffect = field && savedEffect === "none" ? "dither" : savedEffect;
  const printed = (picture && effect !== "none") || field;
  // A picture is printed, whether the ground is a photo or the pixel ground's
  // Picture scene.
  const printedPicture = picture || (field && scene === "picture");
  const motion = currentMotion(background);
  // Characters have no wave, so an ASCII print offers no Motion.
  const ascii = picture && effect === "ascii";
  const moves =
    (printed && !ascii) || background.kind === "characters" || background.kind === "flowing";
  // A photo dithered before the effect choice existed prints at 2 px and 4
  // colours. Moving one slider saves an explicit effect, which retires that
  // legacy reading, so the untouched slider's value is saved with it rather
  // than jumping to the decoded default.
  const legacyPrint =
    background.kind === "photo" && background.effect === undefined && effect === "dither";
  const printCell = legacyPrint
    ? 2
    : ascii
      ? asciiCell(background.effectCell)
      : background.effectCell;
  const printTones = legacyPrint ? 4 : background.effectTones;

  useEffect(() => {
    setChoice(choiceFor(background.kind));
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
    if (kind === "pixels") {
      setChoice(kind);
      setStatus(undefined);
      // Arriving from another ground opens Ridges, drawn for four shades; a
      // person's own shade count and scene are kept when they come back.
      const tones = background.effectTones === 8 ? FIELD_TONES : background.effectTones;
      props.onChange({
        ...carry(background),
        kind,
        scene: background.scene ?? "ridges",
        effectTones: tones,
      });
      return;
    }
    if (kind === "none" || kind === "characters" || kind === "flowing") {
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

  // Under the pixel ground a photo is the Picture scene's, printed in two
  // tones; anywhere else it is a photo ground.
  const withPhoto = (backgroundId: SidebarBackgroundMetadata["id"]): AppBackground =>
    choice === "pixels" && field
      ? { ...carry(background), kind: "pixels", scene: "picture", backgroundId }
      : { ...carry(background), kind: "photo", backgroundId };

  const pick = (photo: SidebarBackgroundMetadata) => {
    setStatus(undefined);
    props.onChange(withPhoto(photo.id));
  };

  const removePhoto = async (photo: SidebarBackgroundMetadata) => {
    setConfirmingRemoval(null);
    if (library?.remove === undefined) return;
    setBusy(true);
    setStatus(undefined);
    try {
      await library.remove(String(photo.id));
      setPhotos((current) => current.filter((candidate) => candidate.id !== photo.id));
      setStatus(PHOTO_REMOVED);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "The photo could not be removed.");
    } finally {
      setBusy(false);
    }
  };

  const setPhotoOpacity = (value: number) => {
    const percent = Math.round(Math.min(100, Math.max(0, value))) as AppBackgroundPercent;
    props.onChange({ ...background, photoOpacity: percent });
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
      props.onChange(withPhoto(uploaded.id));
      setStatus(PHOTO_ADDED);
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
          description="What sits behind Octant: a built-in picture, your photo, ASCII, pixels, flowing colour, or none."
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
              { id: "builtin", label: "Built-in picture" },
              { id: "photo", label: "Your photo" },
              { id: "characters", label: "ASCII field" },
              { id: "pixels", label: "Pixel ground" },
              { id: "flowing", label: "Flowing" },
              { id: "none", label: "None" },
            ]}
            value={choice}
          />
        </SettingRow>
        {field ? (
          <SettingRow
            description="Ridges with a sun, rays, drifting streaks, or your photo, in the same two tones."
            label="Scene"
            scope="app"
            settingId="app-background-scene"
          >
            <OctantSelectField
              aria-label="Pixel ground scene"
              className="settings-view__select"
              onValueChange={(next) => {
                const chosen = SCENES.find((option) => option.id === next);
                if (chosen !== undefined) props.onChange({ ...background, scene: chosen.id });
              }}
              options={SCENES.map((option) => ({ id: option.id, label: option.label }))}
              value={scene}
            />
          </SettingRow>
        ) : null}
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
                  onKeyDown={moveWithinRadioGroup}
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
                          <Check size={12} strokeWidth={MARK_TICK_STROKE_WIDTH} />
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
                <Upload aria-hidden="true" size={14} />
              </OctantIconButton>
            </div>
          </SettingRow>
          {library === undefined ? null : (
            <div className="settings-app-background__gallery">
              {/* The row and its status line hold their height from the first
                  paint, so a list that arrives, a photo that is added or a
                  refusal moves nothing around them. */}
              <div className="settings-app-background__gallery-head">
                <span className="settings-app-background__gallery-title">On this host</span>
                <span
                  className="settings-app-background__gallery-status"
                  data-tone={status === PHOTO_ADDED || status === PHOTO_REMOVED ? "done" : "note"}
                  role="status"
                >
                  {status ?? ""}
                </span>
              </div>
              <div
                aria-label="Photos on this host"
                className="settings-app-background__gallery-row"
                onKeyDown={moveWithinRadioGroup}
                role="radiogroup"
              >
                {photos.map((photo) => (
                  <PhotoTile
                    busy={busy}
                    checked={selectedId === String(photo.id)}
                    confirming={confirmingRemoval === String(photo.id)}
                    key={String(photo.id)}
                    library={library}
                    onAskRemove={() => setConfirmingRemoval(String(photo.id))}
                    onCancelRemove={() => setConfirmingRemoval(null)}
                    onPick={() => pick(photo)}
                    onRemove={() => void removePhoto(photo)}
                    photo={photo}
                  />
                ))}
                {photos.length === 0 ? (
                  <p className="settings-app-background__gallery-empty">
                    Photos you add appear here.
                  </p>
                ) : null}
              </div>
            </div>
          )}
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
                  onChange={(event) => setPhotoOpacity(Number(event.currentTarget.value))}
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
          {picture || field ? (
            <SettingRow
              description={
                field
                  ? "Plain square pixels, or dithered into a pattern of shades."
                  : "Show the picture as it is, in square pixels, dithered with fewer colours, or as characters."
              }
              label="Effect"
              scope="app"
              settingId="app-background-effect"
            >
              <OctantToggleGroup<AppBackgroundEffect>
                aria-label="Background effect"
                onValueChange={(value) => {
                  const next = value[0];
                  if (next === undefined) return;
                  // A character needs room to read, so ASCII starts at a
                  // readable cell rather than inheriting a 2 px one.
                  const effectCell =
                    next === "ascii" && background.effectCell < ASCII_MIN_CELL
                      ? ASCII_DEFAULT_CELL
                      : background.effectCell;
                  props.onChange({ ...background, effect: next, effectCell });
                }}
                value={[effect]}
              >
                {(field ? FIELD_EFFECTS : EFFECTS).map((option) => (
                  <OctantToggleGroupItem key={option.id} value={option.id}>
                    {option.label}
                  </OctantToggleGroupItem>
                ))}
              </OctantToggleGroup>
            </SettingRow>
          ) : null}
          {printed ? (
            <SettingRow
              description={ascii ? "How big each character is." : "How big each square is."}
              label="Pixel size"
              scope="app"
              settingId="app-background-effect-cell"
            >
              <SliderField
                aria-label="Pixel size"
                className="settings-view__range"
                format={(value) => `${String(value)} px`}
                max={16}
                min={ascii ? ASCII_MIN_CELL : 2}
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
          {(picture && effect === "dither") || field ? (
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
          {background.kind === "characters" ? (
            <SettingsDisclosure
              className="settings-app-background__customize"
              title="Customize"
              variant="inline"
            >
              <SettingRow
                description={
                  // The note takes the hint's place, so the row never grows as it comes and goes.
                  <span role="status">{typedRefused ? REFUSED_CHARACTERS : CHARACTERS_HINT}</span>
                }
                label="Characters"
                scope="app"
                settingId="app-background-characters"
              >
                <span className="settings-app-background__characters">
                  <OctantInput
                    aria-label="Characters"
                    autoComplete="off"
                    className="settings-view__text-input"
                    onBlur={() => saveCharacters()}
                    onChange={(event) => {
                      const text = event.currentTarget.value;
                      setTyped(text);
                      const cleaned = cleanCharacterSet(text);
                      setTypedRefused(cleaned.status === "refused");
                      if (cleaned.status === "ok") {
                        previewCharacters({ ...background, characterSet: cleaned.characterSet });
                      }
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") saveCharacters();
                    }}
                    ref={charactersBox}
                    spellCheck={false}
                    type="text"
                    value={typed}
                  />
                  <OctantSelectField
                    aria-label="Starter character set"
                    className="settings-view__select"
                    onValueChange={(next) => {
                      const plugin = pluginGrounds.find((option) => option.id === next);
                      if (plugin !== undefined) {
                        pickPluginGround(plugin);
                        return;
                      }
                      const starter = STARTER_SETS.find((option) => option.id === next);
                      if (starter !== undefined) {
                        setTyped(starter.characters);
                        setTypedRefused(false);
                        saveCharacters({ ...background, characterSet: starter.characters });
                      }
                    }}
                    options={[
                      ...STARTER_SETS.map((option) => ({ id: option.id, label: option.label })),
                      { id: "custom", label: "Custom", disabled: true },
                      ...pluginGrounds.map((option) => ({
                        id: option.id,
                        label: `${option.displayName} (${option.pluginName})`,
                        group: "From plugins",
                      })),
                    ]}
                    value={
                      STARTER_SETS.find((option) => option.characters === savedCharacters)?.id ??
                      "custom"
                    }
                  />
                </span>
              </SettingRow>
              <SettingRow
                description="The shape its patches take."
                label="Pattern"
                scope="app"
                settingId="app-background-character-pattern"
              >
                <OctantSelectField
                  aria-label="Character pattern"
                  className="settings-view__select"
                  onValueChange={(next) => {
                    const pattern = CHARACTER_PATTERNS.find((option) => option.id === next);
                    if (pattern !== undefined) {
                      saveCharacters({ ...background, characterPattern: pattern.id });
                    }
                  }}
                  options={CHARACTER_PATTERNS.map((option) => ({
                    id: option.id,
                    label: option.label,
                  }))}
                  value={background.characterPattern ?? "cycle"}
                />
              </SettingRow>
              <SettingRow
                description="How much of the field shows."
                label="Density"
                scope="app"
                settingId="app-background-character-density"
              >
                <SliderField
                  aria-label="Density"
                  className="settings-view__range"
                  format={(value) => `${String(value)}%`}
                  max={100}
                  min={0}
                  onBlur={() => saveCharacters()}
                  onChange={(event) =>
                    previewCharacters({
                      ...background,
                      characterDensity: Number(event.currentTarget.value),
                    })
                  }
                  onKeyUp={() => saveCharacters()}
                  onPointerUp={() => saveCharacters()}
                  step={1}
                  value={background.characterDensity ?? DEFAULT_CHARACTER_LEVEL}
                />
              </SettingRow>
              <SettingRow
                description="How fast it drifts and the characters change. Zero holds one frame."
                label="Speed"
                scope="app"
                settingId="app-background-character-speed"
              >
                <SliderField
                  aria-label="Speed"
                  className="settings-view__range"
                  format={(value) => `${String(value)}%`}
                  max={100}
                  min={0}
                  onBlur={() => saveCharacters()}
                  onChange={(event) =>
                    previewCharacters({
                      ...background,
                      characterSpeed: Number(event.currentTarget.value),
                    })
                  }
                  onKeyUp={() => saveCharacters()}
                  onPointerUp={() => saveCharacters()}
                  step={1}
                  value={background.characterSpeed ?? DEFAULT_CHARACTER_LEVEL}
                />
              </SettingRow>
              <SettingRow
                description="Back to the default letters and digits, all patterns in turn, at the default density and speed."
                label="Reset"
                scope="app"
                settingId="app-background-characters-reset"
              >
                <OctantButton
                  onClick={() => {
                    const {
                      characterSet: _set,
                      characterDensity: _density,
                      characterSpeed: _speed,
                      characterPattern: _pattern,
                      ...rest
                    } = background;
                    setTyped(DEFAULT_CHARACTER_SET);
                    setTypedRefused(false);
                    saveCharacters(rest);
                  }}
                  type="button"
                  variant="outline"
                >
                  Reset
                </OctantButton>
              </SettingRow>
            </SettingsDisclosure>
          ) : null}
          {moves ? (
            <SettingRow
              description={
                printedPicture
                  ? "Still keeps the print as it is. Wave sends a wave through its pixels when you click a start screen."
                  : background.kind === "flowing"
                    ? "Still holds one frame. Wave lets the colour field keep drifting."
                    : "Still holds one frame. Wave lets it drift and sends a wave out when you click a start screen."
              }
              label="Motion"
              scope="app"
              settingId="app-background-motion"
            >
              <OctantToggleGroup<Motion>
                aria-label="Background motion"
                onValueChange={(value) => {
                  const next = value[0];
                  if (next !== undefined) props.onChange({ ...background, motion: next });
                }}
                value={[motion]}
              >
                <OctantToggleGroupItem value="still">Still</OctantToggleGroupItem>
                <OctantToggleGroupItem value="wave">Wave</OctantToggleGroupItem>
              </OctantToggleGroup>
            </SettingRow>
          ) : null}
        </div>
      ) : null}
      {props.increasedContrast === true ? (
        <p className="settings-app-background__note">Hidden while Increased contrast is on.</p>
      ) : null}
      {status === undefined || (showPhoto && library !== undefined) ? null : (
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
      {url === null ? <ImageIcon aria-hidden="true" size={16} /> : <img alt="" src={url} />}
    </span>
  );
}

/**
 * One photo in the gallery: a radio that uses it, and a small Remove that
 * shows when the tile is pointed at or focused. Asking to remove swaps that
 * control for Remove and Keep over the same tile, so nothing around it moves.
 * The photo in use has no Remove: the host refuses to delete it.
 */
function PhotoTile(props: {
  readonly busy: boolean;
  readonly checked: boolean;
  readonly confirming: boolean;
  readonly library: BackgroundImageLibrary | undefined;
  readonly onAskRemove: () => void;
  readonly onCancelRemove: () => void;
  readonly onPick: () => void;
  readonly onRemove: () => void;
  readonly photo: SidebarBackgroundMetadata;
}) {
  const url = usePhotoUrl(props.library, String(props.photo.id));
  const canRemove = props.library?.remove !== undefined && !props.checked;
  return (
    <div className="settings-app-background__tile" data-confirming={props.confirming}>
      <OctantButton
        aria-checked={props.checked}
        aria-label={props.photo.displayName}
        className="settings-app-background__tile-pick"
        onClick={props.onPick}
        role="radio"
        title={props.photo.displayName}
        type="button"
        variant="bare"
      >
        {url === null ? null : <img alt="" src={url} />}
      </OctantButton>
      {canRemove && !props.confirming ? (
        <OctantIconButton
          className="settings-app-background__tile-remove"
          disabled={props.busy}
          label={`Remove ${props.photo.displayName}`}
          onClick={props.onAskRemove}
          type="button"
        >
          <span aria-hidden="true" className="settings-app-background__tile-remove-mark">
            <X size={12} />
          </span>
        </OctantIconButton>
      ) : null}
      {props.confirming ? (
        <div
          className="settings-app-background__tile-confirm"
          role="group"
          aria-label={`Remove ${props.photo.displayName}?`}
        >
          <OctantButton onClick={props.onRemove} size="xs" type="button" variant="destructive">
            Remove
          </OctantButton>
          <OctantButton onClick={props.onCancelRemove} size="xs" type="button" variant="secondary">
            Keep
          </OctantButton>
        </div>
      ) : null}
    </div>
  );
}
