import type { ImageGenerationClient } from "@octant/client-runtime/image-generation-client";
import { IMAGE_LIBRARY_SCOPE_ID, type ImageGenerationProfileView } from "@octant/contracts";
import { Surface, SurfaceHeader } from "../surface/SurfaceHeader";
import { OctantButton } from "../ui/base/OctantButton";
import { GeneratedImageList } from "./GeneratedImageList";
import { ImageGenerationAction } from "./ImageGenerationAction";

export interface ImageLibraryViewProps {
  readonly client: ImageGenerationClient;
  readonly profiles: ReadonlyArray<ImageGenerationProfileView>;
  readonly onOpenSettings?: () => void;
  readonly onClose?: () => void;
}

/**
 * Image generation as its own surface, reached from the profile menu rather
 * than from a thread's composer. Jobs run in the host-wide library scope and
 * their artifacts stay in the host's attachment store, so a generated image
 * is kept locally whether or not it is ever attached to a thread.
 */
export function ImageLibraryView(props: ImageLibraryViewProps) {
  return (
    <Surface ariaLabel="Image generator" className="image-library" measure="wide">
      <SurfaceHeader
        actions={
          props.profiles.length === 0 ? (
            props.onOpenSettings === undefined ? undefined : (
              <OctantButton
                onClick={props.onOpenSettings}
                size="sm"
                type="button"
                variant="outline"
              >
                Add an image profile
              </OctantButton>
            )
          ) : (
            <ImageGenerationAction
              client={props.client}
              {...(props.onOpenSettings === undefined
                ? {}
                : { onOpenSettings: props.onOpenSettings })}
              profiles={props.profiles}
              scopeId={IMAGE_LIBRARY_SCOPE_ID}
              threadKind="image-library"
            />
          )
        }
        subtitle="Generate images with a configured image profile. Everything generated here is kept on this host."
        title="Image generator"
        {...(props.onClose === undefined ? {} : { onBack: props.onClose })}
      />
      {props.profiles.length === 0 ? (
        <p className="image-library__note" role="status">
          No image profile is configured. Add one under Providers &amp; Models to generate images.
        </p>
      ) : (
        <GeneratedImageList
          client={props.client}
          profiles={props.profiles}
          scopeId={IMAGE_LIBRARY_SCOPE_ID}
          threadKind="image-library"
        />
      )}
    </Surface>
  );
}
