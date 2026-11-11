/**
 * The Octant aperture centred on a soft wash made from theme tokens. Shared by
 * the sidebar's What's new card and the announcement dialog, so neither holds
 * a brand colour of its own. The band is decorative.
 */
export function ApertureArt(props: { readonly className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={props.className === undefined ? "aperture-art" : `aperture-art ${props.className}`}
    >
      <svg
        className="aperture-art__mark"
        focusable="false"
        height={24}
        viewBox="0 0 100 100"
        width={24}
      >
        <use href="./icons.svg#aperture" />
      </svg>
    </div>
  );
}
