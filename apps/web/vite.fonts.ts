/**
 * Whether a build may inline an asset as a `data:` URL.
 *
 * The renderer's content policy loads fonts from its own origin only
 * (`font-src 'self'`), so a font inlined as a `data:` URL is refused and the
 * text falls back. KaTeX ships a size-3 font under Vite's default inline
 * limit; keeping every font a file keeps it drawable. Other assets keep the
 * default limit.
 */
export function keepFontsAsFiles(filePath: string): boolean | undefined {
  return /\.(?:woff2?|ttf|otf)$/.test(filePath) ? false : undefined;
}
