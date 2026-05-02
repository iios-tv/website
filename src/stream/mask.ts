// A SeamMask is the worker's published "current best carving":
//
//   For each output pixel (oX, oY) in (outW x outH), `sourceX[i]` and
//   `sourceY[i]` (where i = oY * outW + oX) tell us which input pixel from
//   the original (inW x inH) frame to copy.
//
// This decouples the carving compute from the per-frame render: the main
// thread can apply the mask to a fresh camera frame in O(outW * outH)
// without re-running the algorithm. The worker republishes a new mask
// whenever it finishes a refine cycle; the latest mask wins.

export type SeamMask = {
  inW: number;
  inH: number;
  outW: number;
  outH: number;
  sourceX: Int16Array;
  sourceY: Int16Array;
  generation: number;
};

// Trivial pass-through mask: useful as a "no-op" before the worker has
// produced its first real mask, so the render loop has something to draw.
export function identityMask(w: number, h: number, generation = 0): SeamMask {
  const sourceX = new Int16Array(w * h);
  const sourceY = new Int16Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      sourceX[i] = x;
      sourceY[i] = y;
    }
  }
  return { inW: w, inH: h, outW: w, outH: h, sourceX, sourceY, generation };
}

// Per-output-pixel gather. ~150k ops for 240x135 (well under 2 ms on a laptop).
export function applyMask(src: ImageData, mask: SeamMask, dst: ImageData): void {
  const srcData = src.data;
  const dstData = dst.data;
  const inStride = src.width;
  const { outW, outH, sourceX, sourceY } = mask;

  for (let oy = 0; oy < outH; oy += 1) {
    for (let ox = 0; ox < outW; ox += 1) {
      const i = oy * outW + ox;
      const sx = sourceX[i];
      const sy = sourceY[i];
      const sIdx = (sy * inStride + sx) * 4;
      const dIdx = i * 4;
      dstData[dIdx] = srcData[sIdx];
      dstData[dIdx + 1] = srcData[sIdx + 1];
      dstData[dIdx + 2] = srcData[sIdx + 2];
      dstData[dIdx + 3] = srcData[sIdx + 3];
    }
  }
}

// True if a fresh mask is bigger/smaller than what the caller is currently
// rendering with. Triggers ImageData reallocation in the render loop.
export function maskGeometryChanged(a: SeamMask, b: SeamMask): boolean {
  return a.outW !== b.outW || a.outH !== b.outH || a.inW !== b.inW || a.inH !== b.inH;
}
