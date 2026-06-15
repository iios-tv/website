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

// Nearest-neighbour downscale into a pre-allocated destination ImageData.
//
// Used by the refine worker to run carving at a smaller "refine" grid than
// the full crop, dropping the carve loop's per-cycle work roughly 4x at
// REFINE_SCALE = 0.5. Center-pixel sampling (the +0.5 in the index math)
// keeps the sampled pixels centered in each source block rather than
// biased to the top-left, which is barely more code and noticeably less
// jittery on motion.
//
// Quality is "good enough for gradient topology": seam carving only needs
// to know where edges live, not their photographic fidelity. A 2x2 box
// average would be marginally smoother but the difference is invisible
// on camera footage at the resolutions we care about.
export function downscaleFrame(src: ImageData, dst: ImageData): void {
  const srcData = src.data;
  const dstData = dst.data;
  const srcW = src.width;
  const srcH = src.height;
  const dstW = dst.width;
  const dstH = dst.height;
  const srcStride = srcW * 4;
  for (let dy = 0; dy < dstH; dy += 1) {
    const sy = Math.min(srcH - 1, Math.floor(((dy + 0.5) * srcH) / dstH));
    const srcRowBase = sy * srcStride;
    const dstRowBase = dy * dstW * 4;
    for (let dx = 0; dx < dstW; dx += 1) {
      const sx = Math.min(srcW - 1, Math.floor(((dx + 0.5) * srcW) / dstW));
      const si = srcRowBase + sx * 4;
      const di = dstRowBase + dx * 4;
      dstData[di + 0] = srcData[si + 0];
      dstData[di + 1] = srcData[si + 1];
      dstData[di + 2] = srcData[si + 2];
      dstData[di + 3] = srcData[si + 3];
    }
  }
}

// Upscale a refine-resolution SeamMask to full crop resolution.
//
// `refineMask.sourceX/sourceY` index into a refine-res frame (refineMask.inW
// x refineMask.inH). The main thread holds the full-res cropped frame and
// wants source coords in the full-res space (fullInW x fullInH). The
// returned mask has the requested full geometry and source coords in the
// full-res space, so the main thread's `applyMask` works without knowing
// the worker downsampled internally.
//
// Mapping for each full output pixel (fx, fy):
//   1. Find which refine cell it belongs to: (rx, ry) = floor of
//      (fx * refineOutW / fullOutW, fy * refineOutH / fullOutH).
//   2. Look up the refine source coord (refSx, refSy) for that cell.
//   3. Map back to full-res source: each refine source pixel covers a
//      ~(fullInW / refineInW) x (fullInH / refineInH) block; pick the
//      sub-pixel position within that block that mirrors fx/fy's offset
//      inside its refine output cell. Adjacent full output pixels in the
//      same refine cell pick adjacent full source pixels, preserving the
//      full-res detail of the cropped frame.
//
// Allocates fresh Int16Arrays for the source coords -- the worker
// transfers them to the main thread, so reuse is impossible anyway.
export function upscaleMask(
  refineMask: SeamMask,
  fullInW: number,
  fullInH: number,
  fullOutW: number,
  fullOutH: number,
): SeamMask {
  const { inW: rInW, inH: rInH, outW: rOutW, outH: rOutH, sourceX: rSx, sourceY: rSy } = refineMask;

  const inScaleX = fullInW / rInW;
  const inScaleY = fullInH / rInH;
  const outScaleX = fullOutW / rOutW;
  const outScaleY = fullOutH / rOutH;

  const sourceX = new Int16Array(fullOutW * fullOutH);
  const sourceY = new Int16Array(fullOutW * fullOutH);

  for (let fy = 0; fy < fullOutH; fy += 1) {
    const ry = Math.min(rOutH - 1, Math.floor(fy / outScaleY));
    const subY = fy - ry * outScaleY;
    const rRowBase = ry * rOutW;
    const fRowBase = fy * fullOutW;
    for (let fx = 0; fx < fullOutW; fx += 1) {
      const rx = Math.min(rOutW - 1, Math.floor(fx / outScaleX));
      const subX = fx - rx * outScaleX;
      const rIdx = rRowBase + rx;
      const fullSx = Math.min(
        fullInW - 1,
        Math.max(0, Math.round(rSx[rIdx] * inScaleX + subX)),
      );
      const fullSy = Math.min(
        fullInH - 1,
        Math.max(0, Math.round(rSy[rIdx] * inScaleY + subY)),
      );
      sourceX[fRowBase + fx] = fullSx;
      sourceY[fRowBase + fx] = fullSy;
    }
  }

  return {
    inW: fullInW,
    inH: fullInH,
    outW: fullOutW,
    outH: fullOutH,
    sourceX,
    sourceY,
    generation: refineMask.generation,
  };
}
