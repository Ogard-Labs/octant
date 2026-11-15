import type { DescribedTurnImage } from "@octant/contracts";

/**
 * Which images of a message a Sees images model described for a model that
 * cannot read them, and which model it was. The model got the words; the
 * person sees who wrote them.
 */
export function DescribedImagesNote(props: {
  readonly images: ReadonlyArray<DescribedTurnImage> | undefined;
  readonly className: string;
}) {
  if (props.images === undefined || props.images.length === 0) return null;
  return (
    <p className={props.className} role="note">
      {props.images
        .map(
          (image) =>
            `${image.name} described by ${image.describedBy.model} (${image.describedBy.provider})`,
        )
        .join(" · ")}
    </p>
  );
}
