import {
  MAX_BROWSER_SCREENSHOT_DATA_URL_CHARACTERS,
  type ProviderToolImage,
} from "@octant/contracts";

/** Keep screenshot bytes out of text transcripts and within the browser envelope. */
export function browserToolImage(dataUrl: string | undefined): ProviderToolImage | undefined {
  if (dataUrl === undefined || dataUrl.length > MAX_BROWSER_SCREENSHOT_DATA_URL_CHARACTERS)
    return undefined;
  const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  const mimeType = match?.[1];
  const data = match?.[2];
  if ((mimeType !== "image/png" && mimeType !== "image/jpeg") || data === undefined)
    return undefined;
  return { mimeType, data };
}
