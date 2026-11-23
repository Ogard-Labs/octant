/**
 * A pure-JavaScript image resizer for hosts without a system one: icon sets
 * off macOS. Resampling runs on premultiplied-alpha floats so a transparent
 * pixel's colour cannot bleed into its opaque neighbours' edges; the result
 * is un-premultiplied on the way out. Large shrinks (a scale factor of 2 or
 * more on an axis) use an exact area average — the box filter that is also
 * the mathematically correct average for them — and anything closer uses a
 * Lanczos-3 kernel widened to the scale so the downscale stays antialiased.
 *
 * Everything here is synchronous and allocates only what it returns.
 */

export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  /** `width * height * 4` bytes of straight (not premultiplied) RGBA. */
  readonly data: Uint8Array | Uint8ClampedArray;
}

/** Resamples `source` to exactly `width` × `height`. */
export function resampleRgba(source: RgbaImage, width: number, height: number): Uint8ClampedArray {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`Cannot resample to ${String(width)}×${String(height)}.`);
  }
  if (source.data.byteLength !== source.width * source.height * 4) {
    throw new Error(
      `An ${String(source.width)}×${String(source.height)} image needs ${String(source.width * source.height * 4)} bytes, got ${String(source.data.byteLength)}.`,
    );
  }
  const premultiplied = premultiply(source);
  const narrowed = resampleHorizontal(premultiplied, source.width, source.height, width);
  const sampled = resampleVertical(narrowed, width, source.height, height);
  return unPremultiply(sampled, width, height);
}

/**
 * `resampleRgba` that lets the event loop run between rows of work, so a
 * render from a large source does not hold the host for a whole pass. Every
 * `yieldEveryRows`th row ends with a macrotask boundary.
 */
export async function resampleRgbaYielding(
  source: RgbaImage,
  width: number,
  height: number,
  yieldEveryRows = 128,
): Promise<Uint8ClampedArray> {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`Cannot resample to ${String(width)}×${String(height)}.`);
  }
  if (source.data.byteLength !== source.width * source.height * 4) {
    throw new Error(
      `An ${String(source.width)}×${String(source.height)} image needs ${String(source.width * source.height * 4)} bytes, got ${String(source.data.byteLength)}.`,
    );
  }
  const yieldNow = () => new Promise<void>((resolve) => setImmediate(resolve));
  const premultiplied = premultiply(source);
  const narrowed = await resampleHorizontalYielding(
    premultiplied,
    source.width,
    source.height,
    width,
    yieldEveryRows,
    yieldNow,
  );
  const sampled = await resampleVerticalYielding(
    narrowed,
    width,
    source.height,
    height,
    yieldEveryRows,
    yieldNow,
  );
  return unPremultiply(sampled, width, height);
}

/**
 * Straight-alpha bytes to premultiplied floats. Floats, not bytes, so
 * repeated weighted sums keep their precision through both passes.
 */
function premultiply(source: RgbaImage): Float32Array {
  const out = new Float32Array(source.width * source.height * 4);
  for (let i = 0; i < source.data.byteLength; i += 4) {
    const alpha = (source.data[i + 3] ?? 0) / 255;
    out[i] = (source.data[i] ?? 0) * alpha;
    out[i + 1] = (source.data[i + 1] ?? 0) * alpha;
    out[i + 2] = (source.data[i + 2] ?? 0) * alpha;
    out[i + 3] = alpha;
  }
  return out;
}

function unPremultiply(samples: Float32Array, width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < out.byteLength; i += 4) {
    const alpha = samples[i + 3] ?? 0;
    if (alpha <= 0) continue;
    out[i] = Math.min(255, Math.max(0, Math.round((samples[i] ?? 0) / alpha)));
    out[i + 1] = Math.min(255, Math.max(0, Math.round((samples[i + 1] ?? 0) / alpha)));
    out[i + 2] = Math.min(255, Math.max(0, Math.round((samples[i + 2] ?? 0) / alpha)));
    out[i + 3] = Math.min(255, Math.max(0, Math.round(alpha * 255)));
  }
  return out;
}

/** Every row of a `srcW` × `srcH` premultiplied image narrowed to `dstW`. */
function resampleHorizontal(
  input: Float32Array,
  srcW: number,
  srcH: number,
  dstW: number,
): Float32Array {
  if (srcW === dstW) return input;
  const out = new Float32Array(srcH * dstW * 4);
  const sampled = new Float32Array(dstW * 4);
  for (let y = 0; y < srcH; y += 1) {
    resampleLine(input.subarray(y * srcW * 4, (y + 1) * srcW * 4), sampled, srcW, dstW);
    out.set(sampled, y * dstW * 4);
  }
  return out;
}

/** Every column of a `width` × `srcH` premultiplied image shortened to `dstH`. */
function resampleVertical(
  input: Float32Array,
  width: number,
  srcH: number,
  dstH: number,
): Float32Array {
  if (srcH === dstH) return input;
  const out = new Float32Array(dstH * width * 4);
  const column = new Float32Array(srcH * 4);
  const sampled = new Float32Array(dstH * 4);
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < srcH; y += 1) {
      column.set(input.subarray((y * width + x) * 4, (y * width + x) * 4 + 4), y * 4);
    }
    resampleLine(column, sampled, srcH, dstH);
    for (let y = 0; y < dstH; y += 1) {
      out.set(sampled.subarray(y * 4, y * 4 + 4), (y * width + x) * 4);
    }
  }
  return out;
}

/** `resampleHorizontal` yielding `yieldNow` every `yieldEveryRows` source rows. */
async function resampleHorizontalYielding(
  input: Float32Array,
  srcW: number,
  srcH: number,
  dstW: number,
  yieldEveryRows: number,
  yieldNow: () => Promise<void>,
): Promise<Float32Array> {
  if (srcW === dstW) return input;
  const out = new Float32Array(srcH * dstW * 4);
  const sampled = new Float32Array(dstW * 4);
  for (let y = 0; y < srcH; y += 1) {
    if (y !== 0 && y % yieldEveryRows === 0) await yieldNow();
    resampleLine(input.subarray(y * srcW * 4, (y + 1) * srcW * 4), sampled, srcW, dstW);
    out.set(sampled, y * dstW * 4);
  }
  return out;
}

/** `resampleVertical` yielding `yieldNow` every `yieldEveryRows` output columns. */
async function resampleVerticalYielding(
  input: Float32Array,
  width: number,
  srcH: number,
  dstH: number,
  yieldEveryRows: number,
  yieldNow: () => Promise<void>,
): Promise<Float32Array> {
  if (srcH === dstH) return input;
  const out = new Float32Array(dstH * width * 4);
  const column = new Float32Array(srcH * 4);
  const sampled = new Float32Array(dstH * 4);
  for (let x = 0; x < width; x += 1) {
    if (x !== 0 && x % yieldEveryRows === 0) await yieldNow();
    for (let y = 0; y < srcH; y += 1) {
      column.set(input.subarray((y * width + x) * 4, (y * width + x) * 4 + 4), y * 4);
    }
    resampleLine(column, sampled, srcH, dstH);
    for (let y = 0; y < dstH; y += 1) {
      out.set(sampled.subarray(y * 4, y * 4 + 4), (y * width + x) * 4);
    }
  }
  return out;
}

function resampleLine(line: Float32Array, out: Float32Array, from: number, to: number): void {
  const ratio = from / to;
  if (ratio >= 2) {
    // Area average: each output is the mean of the source pixels its interval
    // covers, weighted by how much of each pixel it covers.
    for (let x = 0; x < to; x += 1) {
      const start = x * ratio;
      const end = start + ratio;
      let weight = 0;
      for (let c = 0; c < 4; c += 1) out[x * 4 + c] = 0;
      for (let i = Math.floor(start); i < Math.ceil(end); i += 1) {
        const cover = Math.min(end, i + 1) - Math.max(start, i);
        if (cover <= 0) continue;
        weight += cover;
        for (let c = 0; c < 4; c += 1) {
          out[x * 4 + c] = (out[x * 4 + c] ?? 0) + (line[i * 4 + c] ?? 0) * cover;
        }
      }
      for (let c = 0; c < 4; c += 1) out[x * 4 + c] = (out[x * 4 + c] ?? 0) / weight;
    }
    return;
  }
  // Lanczos-3 with the kernel widened by the shrink ratio when shrinking.
  const scale = Math.max(1, ratio);
  const support = 3 * scale;
  for (let x = 0; x < to; x += 1) {
    const centre = (x + 0.5) * ratio - 0.5;
    let weight = 0;
    for (let c = 0; c < 4; c += 1) out[x * 4 + c] = 0;
    const first = Math.max(0, Math.ceil(centre - support));
    const last = Math.min(from - 1, Math.floor(centre + support));
    for (let i = first; i <= last; i += 1) {
      const tap = lanczos3((i - centre) / scale);
      if (tap === 0) continue;
      weight += tap;
      for (let c = 0; c < 4; c += 1) {
        out[x * 4 + c] = (out[x * 4 + c] ?? 0) + (line[i * 4 + c] ?? 0) * tap;
      }
    }
    if (weight === 0) {
      // The kernel's window missed every source pixel; take the nearest.
      const nearest = Math.min(from - 1, Math.max(0, Math.round(centre)));
      for (let c = 0; c < 4; c += 1) out[x * 4 + c] = line[nearest * 4 + c] ?? 0;
      continue;
    }
    for (let c = 0; c < 4; c += 1) out[x * 4 + c] = (out[x * 4 + c] ?? 0) / weight;
  }
}

function lanczos3(t: number): number {
  const at = Math.abs(t);
  if (at >= 3) return 0;
  if (at === 0) return 1;
  const sinc = (v: number) => Math.sin(Math.PI * v) / (Math.PI * v);
  return sinc(at) * sinc(at / 3);
}
