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

      const di = (dy * dstW + dx) * 4;

      // Per-channel bilinear. Unrolled R/G/B/A for hot-loop friendliness.
      const w00 = oneMinusFx * oneMinusFy;
      const w10 = fx * oneMinusFy;
      const w01 = oneMinusFx * fy;
      const w11 = fx * fy;

      out[di] =
        src.data[i00] * w00 + src.data[i10] * w10 + src.data[i01] * w01 + src.data[i11] * w11;
      out[di + 1] =
        src.data[i00 + 1] * w00 +
        src.data[i10 + 1] * w10 +
        src.data[i01 + 1] * w01 +
        src.data[i11 + 1] * w11;
      out[di + 2] =
        src.data[i00 + 2] * w00 +
        src.data[i10 + 2] * w10 +
        src.data[i01 + 2] * w01 +
        src.data[i11 + 2] * w11;
      out[di + 3] =
        src.data[i00 + 3] * w00 +
        src.data[i10 + 3] * w10 +
        src.data[i01 + 3] * w01 +
        src.data[i11 + 3] * w11;
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
