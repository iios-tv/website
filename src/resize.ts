import type { ImageSize } from './types';

// Bilinear upscale of a frame's logical (srcSize.w x srcSize.h) top-left
// region into a freshly-allocated ImageData of dstSize.
//
// We can't reuse the carve trick of scribbling into the trailing buffer here:
// upscaling needs more bytes than the source allocates, and the destination
// has different geometry anyway. So this returns a new ImageData with its
// own buffer.
//
// Used for the "carve, then scale back to original size" workflow -- the
// effect is that low-energy regions get compressed and high-energy regions
// (the subject) end up occupying more of the frame, so the result is a
// content-aware "zoom" without cropping or non-uniform stretching.
//
// Uses *premultiplied* bilinear interpolation: each source RGB channel is
// weighted by its alpha before being summed, then un-premultiplied at the
// end. PNG/GIF transparent pixels almost always store RGB = (0, 0, 0) under
// alpha = 0; straight per-channel bilinear would drag interpolated RGB
// toward black at every alpha edge, producing dark halos around any
// subject sitting on a transparent background. Premultiplying makes a
// transparent pixel contribute 0 to the RGB sum regardless of its stored
// RGB, so edges stay color-clean.
export function scaleFrame(
  src: ImageData,
  srcSize: ImageSize,
  dstSize: ImageSize,
): ImageData {
  const { w: dstW, h: dstH } = dstSize;
  const { w: srcW, h: srcH } = srcSize;
  const stride = src.width;

  const out = new Uint8ClampedArray(dstW * dstH * 4);

  // Map dst pixel center -> src pixel center, so the corner pixels align
  // exactly (avoids a half-pixel shift on small resizes).
  const xRatio = srcW > 1 && dstW > 1 ? (srcW - 1) / (dstW - 1) : 0;
  const yRatio = srcH > 1 && dstH > 1 ? (srcH - 1) / (dstH - 1) : 0;

  const data = src.data;

  for (let dy = 0; dy < dstH; dy += 1) {
    const sy = dy * yRatio;
    const y0 = Math.floor(sy);
    const y1 = Math.min(y0 + 1, srcH - 1);
    const fy = sy - y0;
    const oneMinusFy = 1 - fy;

    for (let dx = 0; dx < dstW; dx += 1) {
      const sx = dx * xRatio;
      const x0 = Math.floor(sx);
      const x1 = Math.min(x0 + 1, srcW - 1);
      const fx = sx - x0;
      const oneMinusFx = 1 - fx;

      const i00 = (y0 * stride + x0) * 4;
      const i10 = (y0 * stride + x1) * 4;
      const i01 = (y1 * stride + x0) * 4;
      const i11 = (y1 * stride + x1) * 4;

      const w00 = oneMinusFx * oneMinusFy;
      const w10 = fx * oneMinusFy;
      const w01 = oneMinusFx * fy;
      const w11 = fx * fy;

      const a00 = data[i00 + 3];
      const a10 = data[i10 + 3];
      const a01 = data[i01 + 3];
      const a11 = data[i11 + 3];

      const aOut = a00 * w00 + a10 * w10 + a01 * w01 + a11 * w11;

      const di = (dy * dstW + dx) * 4;

      if (aOut > 0) {
        // Bilinear of premultiplied (R*A, G*A, B*A); divide by aOut to
        // un-premultiply. The 1/255 factor cancels between premultiply
        // and un-premultiply, so we can keep "scaled-premul" values as
        // plain (R*A) with no normalization in the middle.
        const rPremul =
          data[i00] * a00 * w00 +
          data[i10] * a10 * w10 +
          data[i01] * a01 * w01 +
          data[i11] * a11 * w11;
        const gPremul =
          data[i00 + 1] * a00 * w00 +
          data[i10 + 1] * a10 * w10 +
          data[i01 + 1] * a01 * w01 +
          data[i11 + 1] * a11 * w11;
        const bPremul =
          data[i00 + 2] * a00 * w00 +
          data[i10 + 2] * a10 * w10 +
          data[i01 + 2] * a01 * w01 +
          data[i11 + 2] * a11 * w11;

        out[di] = rPremul / aOut;
        out[di + 1] = gPremul / aOut;
        out[di + 2] = bPremul / aOut;
      }
      // else: aOut is 0, all four source pixels are fully transparent,
      // out[di..di+2] stays 0 from Uint8ClampedArray's zero-init.

      out[di + 3] = aOut;
    }
  }

  return new ImageData(out, dstW, dstH);
}

export function scaleAllFrames(
  frames: ImageData[],
  srcSize: ImageSize,
  dstSize: ImageSize,
): ImageData[] {
  return frames.map((f) => scaleFrame(f, srcSize, dstSize));
}
