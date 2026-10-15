import { generate } from "lean-qr";

/** The quiet zone the QR specification asks for around the symbol, in modules. */
const QUIET_ZONE = 4;

/**
 * The pairing code as a QR symbol, drawn dark on light whatever the theme,
 * because a scanner reads an inverted symbol unreliably. The symbol encodes
 * the code text exactly as Settings shows it beside the image.
 */
export function PairingCodeQr({ code }: { readonly code: string }) {
  const symbol = generate(code);
  const extent = symbol.size + QUIET_ZONE * 2;
  let modules = "";
  for (let y = 0; y < symbol.size; y += 1) {
    for (let x = 0; x < symbol.size; x += 1) {
      if (symbol.get(x, y)) modules += `M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`;
    }
  }
  return (
    <svg
      aria-label="Pairing code QR"
      className="remote-pairing-qr"
      data-modules={symbol.size}
      role="img"
      shapeRendering="crispEdges"
      viewBox={`0 0 ${extent} ${extent}`}
    >
      <rect className="remote-pairing-qr__ground" height={extent} width={extent} />
      <path className="remote-pairing-qr__modules" d={modules} />
    </svg>
  );
}
