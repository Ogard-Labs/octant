import type {
  AppBackground,
  AppBackgroundPercent,
  SidebarBackgroundMetadata,
} from "@octant/contracts/theme";
import { Image as ImageIcon, Images, Upload } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { OctantButton, OctantIconButton } from "../ui/base/OctantButton";
import { OctantPopover } from "../ui/base/OctantPopover";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantSlider } from "../ui/base/OctantSlider";
import { OctantSwitch } from "../ui/base/OctantSwitch";

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
  readonly library?: BackgroundImageLibrary | undefined;
  readonly onChange: (next: AppBackground) => void;
}

type Choice = AppBackground["kind"];
type Dial = "patternOpacity" | "patternSpeed" | "patternIntensity" | "photoOpacity";

const ACCEPTED_TYPES = "image/png,image/jpeg,image/webp";
const LIMITS = "PNG, JPEG, or WebP up to 8 MiB and 4096×4096";

/** The dials and where the ground shows travel with every kind, so a
 * switch between pattern, photo, and none never loses them. */
function carry(background: AppBackground) {
  return {
    patternOpacity: background.patternOpacity,
    patternSpeed: background.patternSpeed,
    patternIntensity: background.patternIntensity,
    photoOpacity: background.photoOpacity,
    scope: background.scope,
    coversSidebar: background.coversSidebar,
  };
}

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
  const showPhoto = choice === "photo" || selectedId !== null;
  const showDials = background.kind !== "none";

  useEffect(() => {
    setChoice(background.kind);
  }, [background.kind]);

  useEffect(() => {
    if (!showPhoto || library === undefined) return;
    let cancelled = false;
    library
      .list()
      .then((list) => {
        if (!cancelled) setPhotos(list);
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
    if (kind === "photo") setChoice("photo");
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
    <div className="settings-view__setting settings-app-background">
      <label className="settings-view__field">
        <span>Background</span>
        <OctantSelectField
          aria-label="Application background"
          className="settings-view__select"
          onValueChange={choose}
          options={[
            { id: "theme", label: "Theme pattern" },
            { id: "photo", label: "Photo" },
            { id: "none", label: "None" },
          ]}
          value={choice}
        />
      </label>
      {showPhoto ? (
        <div className="settings-view__field">
          <span>Photo</span>
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
        </div>
      ) : null}
      {showDials ? (
        <>
          <label className="settings-view__field">
            <span>Show behind</span>
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
          </label>
          {background.scope === "everywhere" ? (
            <div className="settings-view__field">
              <span>Cover the sidebar</span>
              <OctantSwitch
                checked={background.coversSidebar}
                label="Cover the sidebar"
                onCheckedChange={(coversSidebar) =>
                  props.onChange({ ...background, coversSidebar })
                }
              />
            </div>
          ) : null}
          <label className="settings-view__field">
            <span>Pattern opacity</span>
            <OctantSlider
              aria-label="Pattern opacity"
              className="settings-view__range"
              max={100}
              min={0}
              onChange={(event) => dial("patternOpacity", Number(event.currentTarget.value))}
              step={1}
              value={background.patternOpacity}
            />
          </label>
          <label className="settings-view__field">
            <span>Pattern speed</span>
            <OctantSlider
              aria-label="Pattern speed"
              className="settings-view__range"
              max={100}
              min={0}
              onChange={(event) => dial("patternSpeed", Number(event.currentTarget.value))}
              step={1}
              value={background.patternSpeed}
            />
          </label>
          <label className="settings-view__field">
            <span>Pattern intensity</span>
            <OctantSlider
              aria-label="Pattern intensity"
              className="settings-view__range"
              max={100}
              min={0}
              onChange={(event) => dial("patternIntensity", Number(event.currentTarget.value))}
              step={1}
              value={background.patternIntensity}
            />
          </label>
          {background.kind === "photo" ? (
            <label className="settings-view__field">
              <span>Photo opacity</span>
              <OctantSlider
                aria-label="Photo opacity"
                className="settings-view__range"
                max={100}
                min={0}
                onChange={(event) => dial("photoOpacity", Number(event.currentTarget.value))}
                step={1}
                value={background.photoOpacity}
              />
            </label>
          ) : null}
        </>
      ) : null}
      {props.increasedContrast === true ? (
        <p className="settings-app-background__note">Hidden while Increased contrast is on.</p>
      ) : null}
      {status === undefined ? null : (
        <p className="settings-app-background__note" role="status">
          {status}
        </p>
      )}
    </div>
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
    </OctantButton>
  );
}
