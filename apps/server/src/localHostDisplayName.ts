export function localHostDisplayName(platform: NodeJS.Platform = process.platform): string {
  return platform === "darwin" ? "This Mac" : "This computer";
}
