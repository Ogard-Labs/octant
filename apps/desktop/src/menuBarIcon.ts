export const HOST_TRAY_ICON_SIZE = 18;

export interface HostTrayImage<TImage> {
  readonly isEmpty: () => boolean;
  readonly resize: (options: {
    readonly height: number;
    readonly quality: "best";
    readonly width: number;
  }) => TImage;
  readonly setTemplateImage: (template: boolean) => void;
}

export interface HostTrayImageFactory<TImage> {
  readonly createFromPath: (path: string) => TImage;
}

export function shouldPresentHostTray(
  platform: NodeJS.Platform,
  _state: "attention-required" | "running" | "starting" | "stopped",
): boolean {
  return platform === "darwin" || platform === "linux";
}

/**
 * macOS menu-bar glyphs are template images so the system recolors them.
 * Linux AppIndicator / Electron trays need ordinary non-template PNGs.
 */
export function hostTrayUsesTemplateImage(platform: NodeJS.Platform): boolean {
  return platform === "darwin";
}

export function createHostTrayImage<TImage extends HostTrayImage<TImage>>(
  factory: HostTrayImageFactory<TImage>,
  path: string,
  platform: NodeJS.Platform = "darwin",
): TImage {
  const source = factory.createFromPath(path);
  if (source.isEmpty()) throw new Error("Octant menu-bar icon could not be loaded.");
  const image = source.resize({
    height: HOST_TRAY_ICON_SIZE,
    quality: "best",
    width: HOST_TRAY_ICON_SIZE,
  });
  if (image.isEmpty()) throw new Error("Octant menu-bar icon could not be resized.");
  // The menu-bar asset is the bare Octant aperture glyph drawn black on
  // transparent, so macOS recolors it for light, dark, and selected states.
  image.setTemplateImage(hostTrayUsesTemplateImage(platform));
  return image;
}
