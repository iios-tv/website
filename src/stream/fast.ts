import type { ImageSize } from '../types';

// Flat-buffer fast path used by both the refine worker (live video) and the
// image carve worker (still images and GIFs).
//
// Earlier versions had separate ergonomic implementations using number[][]
// energy maps, boxed seam coordinates, and per-pixel subarray reads. Those
// were clear but allocation-heavy. This file is the same algorithms expressed
// against pre-allocated typed arrays plus a "stride" decoupled from logical
// width:
//
//   * Pixel buffers and energy buffers keep their original `stride` (= inW)
//     even as the logical `size.w`/`size.h` shrink. We shift values left/up
//     within the fixed stride; trailing values become garbage. This matches
//     what the existing carve module already does for ImageData buffers, so
//     we can use copyWithin() for row shifts.
//   * Seams are Int16Array indexed by row (H seams: x at each y) or by
//     column (V seams: y at each x), instead of Coordinate[].
//   * The DP table is two flat typed arrays: cumulative energy (Float64) and
//     a previous-column offset in {-1, 0, 1} (Int8). Backtrack walks offsets.
//
// Shapes summary (size.w, size.h are the *logical* working size):
//   data       Uint8ClampedArray, 4 * stride * stride entries
//   energy     Float32Array, stride * stride entries
//   dpEnergy   Float64Array, >= size.w * size.h
//   dpPrev     Int8Array,    >= size.w * size.h
//   seamH      Int16Array,   length >= size.h (x at each y)
//   seamV      Int16Array,   length >= size.w (y at each x)

// --- Alpha-aware energy gating --------------------------------------------
//
// Matches js-image-carver's contentAwareResizer.ts. Any pixel whose alpha is
// at or below ALPHA_DELETE_THRESHOLD gets PIXEL_DELETE_ENERGY (a large
// negative number) instead of its RGB gradient sum. The DP minimum-path
// search then always picks transparent regions for removal first, so the
// transparent halo around a sticker is carved away before subject pixels.
// Without this, the gradient at the alpha edge actively repels seams from
// the halo and pushes them through the subject, distorting it.
//
// 244 catches everything from fully-transparent through ~95% opaque
// antialiased halo without false-positives on the opaque subject.
export const ALPHA_DELETE_THRESHOLD = 244;

// Sentinel to pass when the caller wants to disable alpha gating entirely
// (e.g. the UI's "without alpha gating" comparison variant). Any negative
// threshold works since alpha bytes are always 0..255; -1 is the most
// readable.
export const ALPHA_GATING_DISABLED = -1;

// Calibrated so a single delete-pixel outweighs any plausible all-max-energy
// seam (3 * 255^2 per pixel; longest realistic seam well under 4096).
// Float32-representable; DP cumulatives stay within range.
const PIXEL_DELETE_ENERGY = -1 * 2 * 2 * 4096 * 3 * 255 * 255;

// --- Aggregate energy (full rebuild, used once per pass) -------------------

// Cross-frame max of horizontal-gradient energy. Writes into `energy` at
// `[y * stride + x]`. Only positions inside (size.w x size.h) are written;
// the rest are left untouched (callers should treat those as garbage).
export function aggregateEnergyHFlat(
  frames: ImageData[],
  size: ImageSize,
  energy: Float32Array,
  stride: number,
  alphaThreshold: number = ALPHA_DELETE_THRESHOLD,
): void {
  const { w, h } = size;
  for (let y = 0; y < h; y += 1) {
    const rowEnergy = y * stride;
    const rowData = y * stride * 4;
    for (let x = 0; x < w; x += 1) {
      const i = rowData + x * 4;
      // Cross-frame max: a position is only "free to remove" if it's
      // transparent in EVERY frame; an opaque frame's positive gradient
      // wins the max and the seam correctly avoids it.
      let maxE = -Infinity;
      for (let f = 0; f < frames.length; f += 1) {
        const data = frames[f].data;
        let e: number;
        if (data[i + 3] <= alphaThreshold) {
          e = PIXEL_DELETE_ENERGY;
        } else {
          const mr = data[i];
          const mg = data[i + 1];
          const mb = data[i + 2];
          e = 0;
          if (x > 0) {
            const il = i - 4;
            const dr = data[il] - mr;
            const dg = data[il + 1] - mg;
            const db = data[il + 2] - mb;
            e += dr * dr + dg * dg + db * db;
          }
          if (x + 1 < w) {
            const ir = i + 4;
            const dr = data[ir] - mr;
            const dg = data[ir + 1] - mg;
            const db = data[ir + 2] - mb;
            e += dr * dr + dg * dg + db * db;
          }
        }
        if (e > maxE) maxE = e;
      }
      energy[rowEnergy + x] = maxE === -Infinity ? 0 : maxE;
    }
  }
}

// Cross-frame max of vertical-gradient energy.
export function aggregateEnergyVFlat(
  frames: ImageData[],
  size: ImageSize,
  energy: Float32Array,
  stride: number,
  alphaThreshold: number = ALPHA_DELETE_THRESHOLD,
): void {
  const { w, h } = size;
  const rowBytes = stride * 4;
  for (let y = 0; y < h; y += 1) {
    const rowEnergy = y * stride;
    const rowData = y * rowBytes;
    for (let x = 0; x < w; x += 1) {
      const i = rowData + x * 4;
      let maxE = -Infinity;
      for (let f = 0; f < frames.length; f += 1) {
        const data = frames[f].data;
        let e: number;
        if (data[i + 3] <= alphaThreshold) {
          e = PIXEL_DELETE_ENERGY;
        } else {
          const mr = data[i];
          const mg = data[i + 1];
          const mb = data[i + 2];
          e = 0;
          if (y > 0) {
            const it = i - rowBytes;
            const dr = data[it] - mr;
            const dg = data[it + 1] - mg;
            const db = data[it + 2] - mb;
            e += dr * dr + dg * dg + db * db;
          }
          if (y + 1 < h) {
            const ib = i + rowBytes;
            const dr = data[ib] - mr;
            const dg = data[ib + 1] - mg;
            const db = data[ib + 2] - mb;
            e += dr * dr + dg * dg + db * db;
          }
        }
        if (e > maxE) maxE = e;
      }
      energy[rowEnergy + x] = maxE === -Infinity ? 0 : maxE;
    }
  }
}

// --- Local energy refresh (incremental update after a seam removal) --------

// Recompute aggregate H-energy at one pixel only. Cheap: O(N) over frames.
function recomputeAggregateAtH(
  frames: ImageData[],
  energy: Float32Array,
  x: number,
  y: number,
  size: ImageSize,
  stride: number,
  alphaThreshold: number,
): void {
  const { w } = size;
  const i = (y * stride + x) * 4;
  let maxE = -Infinity;
  for (let f = 0; f < frames.length; f += 1) {
    const data = frames[f].data;
    let e: number;
    if (data[i + 3] <= alphaThreshold) {
      e = PIXEL_DELETE_ENERGY;
    } else {
      const mr = data[i];
      const mg = data[i + 1];
      const mb = data[i + 2];
      e = 0;
      if (x > 0) {
        const il = i - 4;
        const dr = data[il] - mr;
        const dg = data[il + 1] - mg;
        const db = data[il + 2] - mb;
        e += dr * dr + dg * dg + db * db;
      }
      if (x + 1 < w) {
        const ir = i + 4;
        const dr = data[ir] - mr;
        const dg = data[ir + 1] - mg;
        const db = data[ir + 2] - mb;
        e += dr * dr + dg * dg + db * db;
      }
    }
    if (e > maxE) maxE = e;
  }
  energy[y * stride + x] = maxE === -Infinity ? 0 : maxE;
}

function recomputeAggregateAtV(
  frames: ImageData[],
  energy: Float32Array,
  x: number,
  y: number,
  size: ImageSize,
  stride: number,
  alphaThreshold: number,
): void {
  const { h } = size;
  const rowBytes = stride * 4;
  const i = y * rowBytes + x * 4;
  let maxE = -Infinity;
  for (let f = 0; f < frames.length; f += 1) {
    const data = frames[f].data;
    let e: number;
    if (data[i + 3] <= alphaThreshold) {
      e = PIXEL_DELETE_ENERGY;
    } else {
      const mr = data[i];
      const mg = data[i + 1];
      const mb = data[i + 2];
      e = 0;
      if (y > 0) {
        const it = i - rowBytes;
        const dr = data[it] - mr;
        const dg = data[it + 1] - mg;
        const db = data[it + 2] - mb;
        e += dr * dr + dg * dg + db * db;
      }
      if (y + 1 < h) {
        const ib = i + rowBytes;
        const dr = data[ib] - mr;
        const dg = data[ib + 1] - mg;
        const db = data[ib + 2] - mb;
        e += dr * dr + dg * dg + db * db;
      }
    }
    if (e > maxE) maxE = e;
  }
  energy[y * stride + x] = maxE === -Infinity ? 0 : maxE;
}

// After deleting an H seam (vertical column from the picture's POV), refresh
// energy at the two positions per row whose neighbors actually changed:
// (seamX-1, y) lost its right-side reference; (seamX, y) -- now what used to
// be (seamX+1, y) -- has a new left-side reference. Everything else is either
// untouched or correctly updated by the row-shift in deleteSeamHFromEnergy.
export function refreshEnergyAfterSeamH(
  frames: ImageData[],
  energy: Float32Array,
  seamRowX: Int16Array,
  size: ImageSize,
  stride: number,
  alphaThreshold: number = ALPHA_DELETE_THRESHOLD,
): void {
  const { h, w } = size;
  for (let y = 0; y < h; y += 1) {
    const sx = seamRowX[y];
    if (sx - 1 >= 0) {
      recomputeAggregateAtH(frames, energy, sx - 1, y, size, stride, alphaThreshold);
    }
    if (sx < w) {
      recomputeAggregateAtH(frames, energy, sx, y, size, stride, alphaThreshold);
    }
  }
}

export function refreshEnergyAfterSeamV(
  frames: ImageData[],
  energy: Float32Array,
  seamColY: Int16Array,
  size: ImageSize,
  stride: number,
  alphaThreshold: number = ALPHA_DELETE_THRESHOLD,
): void {
  const { w, h } = size;
  for (let x = 0; x < w; x += 1) {
    const sy = seamColY[x];
    if (sy - 1 >= 0) {
      recomputeAggregateAtV(frames, energy, x, sy - 1, size, stride, alphaThreshold);
    }
    if (sy < h) {
      recomputeAggregateAtV(frames, energy, x, sy, size, stride, alphaThreshold);
    }
  }
}

// --- Single-frame energy + EMA blend (live video refine path) -------------
//
// The refine worker can't afford to keep a ring of N raw frames and rebuild
// a MAX-aggregated energy map every cycle: subject motion is "remembered"
// for N cycles (ghost trails) and the per-cycle work scales with N. Instead
// we maintain a single persistent energy buffer that's EMA-blended on every
// new frame:
//
//   energyEma[i] = (1 - alpha) * energyEma[i] + alpha * frameEnergy[i]
//
// A new subject position contributes alpha (e.g. 0.25) on the first frame
// and decays the old position geometrically. Catch-up time = ~ 1/alpha
// frames instead of N cycles.
//
// `frameEnergyHFlat / VFlat` compute the single-frame gradient that gets
// blended in. They are the existing aggregate functions with the cross-
// frame loop stripped out.

// Single-frame H-gradient energy at every pixel in (size.w x size.h).
export function frameEnergyHFlat(
  frame: ImageData,
  size: ImageSize,
  energy: Float32Array,
  stride: number,
  alphaThreshold: number = ALPHA_DELETE_THRESHOLD,
): void {
  const { w, h } = size;
  const data = frame.data;
  for (let y = 0; y < h; y += 1) {
    const rowEnergy = y * stride;
    const rowData = y * stride * 4;
    for (let x = 0; x < w; x += 1) {
      const i = rowData + x * 4;
      let e: number;
      if (data[i + 3] <= alphaThreshold) {
        e = PIXEL_DELETE_ENERGY;
      } else {
        const mr = data[i];
        const mg = data[i + 1];
        const mb = data[i + 2];
        e = 0;
        if (x > 0) {
          const il = i - 4;
          const dr = data[il] - mr;
          const dg = data[il + 1] - mg;
          const db = data[il + 2] - mb;
          e += dr * dr + dg * dg + db * db;
        }
        if (x + 1 < w) {
          const ir = i + 4;
          const dr = data[ir] - mr;
          const dg = data[ir + 1] - mg;
          const db = data[ir + 2] - mb;
          e += dr * dr + dg * dg + db * db;
        }
      }
      energy[rowEnergy + x] = e;
    }
  }
}

// Single-frame V-gradient energy at every pixel in (size.w x size.h).
export function frameEnergyVFlat(
  frame: ImageData,
  size: ImageSize,
  energy: Float32Array,
  stride: number,
  alphaThreshold: number = ALPHA_DELETE_THRESHOLD,
): void {
  const { w, h } = size;
  const data = frame.data;
  const rowBytes = stride * 4;
  for (let y = 0; y < h; y += 1) {
    const rowEnergy = y * stride;
    const rowData = y * rowBytes;
    for (let x = 0; x < w; x += 1) {
      const i = rowData + x * 4;
      let e: number;
      if (data[i + 3] <= alphaThreshold) {
        e = PIXEL_DELETE_ENERGY;
      } else {
        const mr = data[i];
        const mg = data[i + 1];
        const mb = data[i + 2];
        e = 0;
        if (y > 0) {
          const it = i - rowBytes;
          const dr = data[it] - mr;
          const dg = data[it + 1] - mg;
          const db = data[it + 2] - mb;
          e += dr * dr + dg * dg + db * db;
        }
        if (y + 1 < h) {
          const ib = i + rowBytes;
          const dr = data[ib] - mr;
          const dg = data[ib + 1] - mg;
          const db = data[ib + 2] - mb;
          e += dr * dr + dg * dg + db * db;
        }
      }
      energy[rowEnergy + x] = e;
    }
  }
}

// In-place EMA blend: target[i] = (1 - alpha) * target[i] + alpha * sample[i].
// Iterates min(target.length, sample.length) entries. Garbage cells outside
// the logical region don't matter (they're never read by the DP search).
export function emaBlend(
  target: Float32Array,
  sample: Float32Array,
  alpha: number,
): void {
  const oneMinusAlpha = 1 - alpha;
  const n = Math.min(target.length, sample.length);
  for (let i = 0; i < n; i += 1) {
    target[i] = oneMinusAlpha * target[i] + alpha * sample[i];
  }
}

// After deleting an H seam, refresh the two cells per row whose neighbour
// relationships changed. Unlike `refreshEnergyAfterSeamH`, this writes the
// single-frame H-gradient directly into `energy` (no EMA blend). Mixing
// frames within one carve cycle isn't useful: the EMA happens across
// cycles via emaBlend(), and we want the carve to see consistent values.
export function refreshEnergyFromFrameH(
  frame: ImageData,
  energy: Float32Array,
  seamRowX: Int16Array,
  size: ImageSize,
  stride: number,
  alphaThreshold: number = ALPHA_DELETE_THRESHOLD,
): void {
  const { h, w } = size;
  for (let y = 0; y < h; y += 1) {
    const sx = seamRowX[y];
    if (sx - 1 >= 0) {
      recomputeFrameAtH(frame, energy, sx - 1, y, size, stride, alphaThreshold);
    }
    if (sx < w) {
      recomputeFrameAtH(frame, energy, sx, y, size, stride, alphaThreshold);
    }
  }
}

export function refreshEnergyFromFrameV(
  frame: ImageData,
  energy: Float32Array,
  seamColY: Int16Array,
  size: ImageSize,
  stride: number,
  alphaThreshold: number = ALPHA_DELETE_THRESHOLD,
): void {
  const { w, h } = size;
  for (let x = 0; x < w; x += 1) {
    const sy = seamColY[x];
    if (sy - 1 >= 0) {
      recomputeFrameAtV(frame, energy, x, sy - 1, size, stride, alphaThreshold);
    }
    if (sy < h) {
      recomputeFrameAtV(frame, energy, x, sy, size, stride, alphaThreshold);
    }
  }
}

function recomputeFrameAtH(
  frame: ImageData,
  energy: Float32Array,
  x: number,
  y: number,
  size: ImageSize,
  stride: number,
  alphaThreshold: number,
): void {
  const { w } = size;
  const data = frame.data;
  const i = (y * stride + x) * 4;
  let e: number;
  if (data[i + 3] <= alphaThreshold) {
    e = PIXEL_DELETE_ENERGY;
  } else {
    const mr = data[i];
    const mg = data[i + 1];
    const mb = data[i + 2];
    e = 0;
    if (x > 0) {
      const il = i - 4;
      const dr = data[il] - mr;
      const dg = data[il + 1] - mg;
      const db = data[il + 2] - mb;
      e += dr * dr + dg * dg + db * db;
    }
    if (x + 1 < w) {
      const ir = i + 4;
      const dr = data[ir] - mr;
      const dg = data[ir + 1] - mg;
      const db = data[ir + 2] - mb;
      e += dr * dr + dg * dg + db * db;
    }
  }
  energy[y * stride + x] = e;
}

function recomputeFrameAtV(
  frame: ImageData,
  energy: Float32Array,
  x: number,
  y: number,
  size: ImageSize,
  stride: number,
  alphaThreshold: number,
): void {
  const { h } = size;
  const data = frame.data;
  const rowBytes = stride * 4;
  const i = y * rowBytes + x * 4;
  let e: number;
  if (data[i + 3] <= alphaThreshold) {
    e = PIXEL_DELETE_ENERGY;
  } else {
    const mr = data[i];
    const mg = data[i + 1];
    const mb = data[i + 2];
    e = 0;
    if (y > 0) {
      const it = i - rowBytes;
      const dr = data[it] - mr;
      const dg = data[it + 1] - mg;
      const db = data[it + 2] - mb;
      e += dr * dr + dg * dg + db * db;
    }
    if (y + 1 < h) {
      const ib = i + rowBytes;
      const dr = data[ib] - mr;
      const dg = data[ib + 1] - mg;
      const db = data[ib + 2] - mb;
      e += dr * dr + dg * dg + db * db;
    }
  }
  energy[y * stride + x] = e;
}

// --- DP seam search (flat buffers, no per-cell objects) --------------------

// H seam (top-to-bottom). Output: seamRowX[y] = x of seam pixel at row y.
export function findLowEnergySeamHFlat(
  energy: Float32Array,
  size: ImageSize,
  stride: number,
  dpEnergy: Float64Array,
  dpPrev: Int8Array,
  seamRowX: Int16Array,
): void {
  const { w, h } = size;

  for (let x = 0; x < w; x += 1) {
    dpEnergy[x] = energy[x];
    dpPrev[x] = 0;
  }

  for (let y = 1; y < h; y += 1) {
    const rowBase = y * w;
    const prevBase = (y - 1) * w;
    const eRowBase = y * stride;
    for (let x = 0; x < w; x += 1) {
      let minE = Infinity;
      let off = 0;
      if (x > 0) {
        const e = dpEnergy[prevBase + x - 1];
        if (e < minE) {
          minE = e;
          off = -1;
        }
      }
      const eMid = dpEnergy[prevBase + x];
      if (eMid < minE) {
        minE = eMid;
        off = 0;
      }
      if (x + 1 < w) {
        const eR = dpEnergy[prevBase + x + 1];
        if (eR < minE) {
          minE = eR;
          off = 1;
        }
      }
      dpEnergy[rowBase + x] = minE + energy[eRowBase + x];
      dpPrev[rowBase + x] = off;
    }
  }

  const lastRowBase = (h - 1) * w;
  let bestX = 0;
  let bestE = Infinity;
  for (let x = 0; x < w; x += 1) {
    const e = dpEnergy[lastRowBase + x];
    if (e < bestE) {
      bestE = e;
      bestX = x;
    }
  }

  let cx = bestX;
  for (let y = h - 1; y >= 1; y -= 1) {
    seamRowX[y] = cx;
    cx += dpPrev[y * w + cx];
  }
  seamRowX[0] = cx;
}

// V seam (left-to-right). Output: seamColY[x] = y of seam pixel at column x.
export function findLowEnergySeamVFlat(
  energy: Float32Array,
  size: ImageSize,
  stride: number,
  dpEnergy: Float64Array,
  dpPrev: Int8Array,
  seamColY: Int16Array,
): void {
  const { w, h } = size;

  for (let y = 0; y < h; y += 1) {
    dpEnergy[y * w] = energy[y * stride];
    dpPrev[y * w] = 0;
  }

  for (let x = 1; x < w; x += 1) {
    for (let y = 0; y < h; y += 1) {
      let minE = Infinity;
      let off = 0;
      if (y > 0) {
        const e = dpEnergy[(y - 1) * w + (x - 1)];
        if (e < minE) {
          minE = e;
          off = -1;
        }
      }
      const eMid = dpEnergy[y * w + (x - 1)];
      if (eMid < minE) {
        minE = eMid;
        off = 0;
      }
      if (y + 1 < h) {
        const eD = dpEnergy[(y + 1) * w + (x - 1)];
        if (eD < minE) {
          minE = eD;
          off = 1;
        }
      }
      dpEnergy[y * w + x] = minE + energy[y * stride + x];
      dpPrev[y * w + x] = off;
    }
  }

  let bestY = 0;
  let bestE = Infinity;
  for (let y = 0; y < h; y += 1) {
    const e = dpEnergy[y * w + (w - 1)];
    if (e < bestE) {
      bestE = e;
      bestY = y;
    }
  }

  let cy = bestY;
  for (let x = w - 1; x >= 1; x -= 1) {
    seamColY[x] = cy;
    cy += dpPrev[cy * w + x];
  }
  seamColY[0] = cy;
}

// --- Seam removal (frames, energy map, source coords) ----------------------

// Shift each row left by one starting at the seam column. Uses copyWithin
// for the byte range -- essentially a memmove inside the typed array.
export function deleteSeamHFromFrame(
  frame: ImageData,
  seamRowX: Int16Array,
  size: ImageSize,
  stride: number,
): void {
  const { w, h } = size;
  const data = frame.data;
  const rowBytes = stride * 4;
  for (let y = 0; y < h; y += 1) {
    const sx = seamRowX[y];
    const rowBase = y * rowBytes;
    if (sx + 1 < w) {
      data.copyWithin(rowBase + sx * 4, rowBase + (sx + 1) * 4, rowBase + w * 4);
    }
  }
}

// V seam: shift each column up. Columns aren't contiguous; per-pixel loop.
export function deleteSeamVFromFrame(
  frame: ImageData,
  seamColY: Int16Array,
  size: ImageSize,
  stride: number,
): void {
  const { w, h } = size;
  const data = frame.data;
  const rowBytes = stride * 4;
  for (let x = 0; x < w; x += 1) {
    const sy = seamColY[x];
    let dst = sy * rowBytes + x * 4;
    let src = dst + rowBytes;
    for (let y = sy; y < h - 1; y += 1) {
      data[dst] = data[src];
      data[dst + 1] = data[src + 1];
      data[dst + 2] = data[src + 2];
      data[dst + 3] = data[src + 3];
      dst = src;
      src = dst + rowBytes;
    }
  }
}

// Mirror the seam deletion in the energy map so the next iteration sees the
// shifted layout. Float32Array also has copyWithin, so row shifts are cheap.
export function deleteSeamHFromEnergy(
  energy: Float32Array,
  seamRowX: Int16Array,
  size: ImageSize,
  stride: number,
): void {
  const { w, h } = size;
  for (let y = 0; y < h; y += 1) {
    const sx = seamRowX[y];
    const rowBase = y * stride;
    if (sx + 1 < w) {
      energy.copyWithin(rowBase + sx, rowBase + sx + 1, rowBase + w);
    }
  }
}

export function deleteSeamVFromEnergy(
  energy: Float32Array,
  seamColY: Int16Array,
  size: ImageSize,
  stride: number,
): void {
  const { w, h } = size;
  for (let x = 0; x < w; x += 1) {
    const sy = seamColY[x];
    for (let y = sy; y < h - 1; y += 1) {
      energy[y * stride + x] = energy[(y + 1) * stride + x];
    }
  }
}

// Delete the seam from the source-coordinate arrays (the data the worker
// posts back as the mask). Same shift as the pixels/energy.
export function deleteSeamHFromCoords(
  sourceX: Int16Array,
  sourceY: Int16Array,
  seamRowX: Int16Array,
  size: ImageSize,
  stride: number,
): void {
  const { w, h } = size;
  for (let y = 0; y < h; y += 1) {
    const sx = seamRowX[y];
    const rowBase = y * stride;
    if (sx + 1 < w) {
      sourceX.copyWithin(rowBase + sx, rowBase + sx + 1, rowBase + w);
      sourceY.copyWithin(rowBase + sx, rowBase + sx + 1, rowBase + w);
    }
  }
}

export function deleteSeamVFromCoords(
  sourceX: Int16Array,
  sourceY: Int16Array,
  seamColY: Int16Array,
  size: ImageSize,
  stride: number,
): void {
  const { w, h } = size;
  for (let x = 0; x < w; x += 1) {
    const sy = seamColY[x];
    for (let y = sy; y < h - 1; y += 1) {
      sourceX[y * stride + x] = sourceX[(y + 1) * stride + x];
      sourceY[y * stride + x] = sourceY[(y + 1) * stride + x];
    }
  }
}
