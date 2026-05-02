import type { ImageSize } from '../types';

export type CropRegion = {
  x: number;
  y: number;
  w: number;
  h: number;
};

// Extract a (w x h) rectangle from src starting at (x, y) into dst.
//
// Each output row is contiguous in src's underlying buffer, so we copy whole
// rows with subarray + set rather than per-pixel. Pass in a reusable dst to
// avoid allocating per frame in the render loop; if dst is omitted or its
// geometry doesn't match, a fresh ImageData is created.
export function cropImageData(
  src: ImageData,
  region: CropRegion,
  dst?: ImageData,
): ImageData {
  const { x, y, w, h } = region;
  const out =
    dst && dst.width === w && dst.height === h ? dst : new ImageData(w, h);
  const srcStride = src.width;
  for (let row = 0; row < h; row += 1) {
    const srcStart = ((y + row) * srcStride + x) * 4;
    const dstStart = row * w * 4;
    out.data.set(src.data.subarray(srcStart, srcStart + w * 4), dstStart);
  }
  return out;
}

// Snap an arbitrary CropRegion into the largest rectangle that fits inside
// `bounds`. Used both at startup (initial crop might be bigger than camera)
// and during interactive drag (overlay can't escape the camera frame).
export function clampCrop(region: CropRegion, bounds: ImageSize): CropRegion {
  const w = Math.max(1, Math.min(Math.floor(region.w), bounds.w));
  const h = Math.max(1, Math.min(Math.floor(region.h), bounds.h));
  const x = Math.max(0, Math.min(Math.floor(region.x), bounds.w - w));
  const y = Math.max(0, Math.min(Math.floor(region.y), bounds.h - h));
  return { x, y, w, h };
}
