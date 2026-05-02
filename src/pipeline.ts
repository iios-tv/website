import { decodeImage, encodeImage, type ImageFormat } from './image';
import { scaleAllFrames } from './resize';
import {
  ALPHA_DELETE_THRESHOLD,
  ALPHA_GATING_DISABLED,
  aggregateEnergyHFlat,
  aggregateEnergyVFlat,
  deleteSeamHFromEnergy,
  deleteSeamHFromFrame,
  deleteSeamVFromEnergy,
  deleteSeamVFromFrame,
  findLowEnergySeamHFlat,
  findLowEnergySeamVFlat,
  refreshEnergyAfterSeamH,
  refreshEnergyAfterSeamV,
} from './stream/fast';
import type { ImageSize } from './types';

export type CarveResult = {
  bytes: Uint8Array;
  format: ImageFormat;
  inputSize: ImageSize;
  carvedSize: ImageSize;
  outputSize: ImageSize;
  frameCount: number;
  scaledBack: boolean;
  timings: {
    decodeMs: number;
    widthCarveMs: number;
    heightCarveMs: number;
    scaleMs: number;
    encodeMs: number;
    totalMs: number;
  };
};

export type CarveOptions = {
  toWidth: number;
  toHeight: number;
  // If true, after carving, bilinear-scale every frame back to the original
  // input dimensions before encoding. Result has the same size as the input,
  // but with low-energy regions compressed -- effectively a content-aware
  // zoom toward the high-energy subject.
  scaleBackToOriginal?: boolean;
  // When true (default), pixels with alpha <= 244 get a huge negative energy
  // so transparent halos are carved away first. When false, alpha is ignored
  // and only the RGB gradient drives seam selection -- useful for A/B
  // comparisons or for opaque inputs where the gating happens to over-protect
  // a region.
  alphaAware?: boolean;
  // JPEG-only quality knob (0..1). Ignored for other formats.
  jpegQuality?: number;
  // Optional progress hook, called from inside the carve loop. Useful when
  // running in a Worker so the host can update a UI without polling.
  onProgress?: ProgressCallback;
};

export type ProgressPhase = 'decode' | 'width' | 'height' | 'scale' | 'encode';

// `current` is monotonically non-decreasing within a phase and reaches `total`
// at the end of that phase. For non-iterative phases (decode, encode, scale-as-
// no-op) we report (0, 1) at start and (1, 1) at end.
export type ProgressCallback = (
  phase: ProgressPhase,
  current: number,
  total: number,
) => void;

// End-to-end orchestrator. Format-agnostic: GIF inputs flow through the
// gifuct/gifenc path; PNG/JPEG inputs flow through createImageBitmap +
// OffscreenCanvas. The cross-frame energy aggregation collapses to plain
// per-frame energy when there's only one frame, so the carving math
// doesn't care which path the data came in on.
//
// Inner loops use flat typed-array energy + DP buffers (see ./stream/fast.ts):
// one full energy build per axis, then incremental refresh of only the
// neighbour cells touched by each seam. Avoids the per-pixel subarray
// allocations that dominate the naive implementation.
export async function carveImage(
  buffer: ArrayBuffer,
  opts: CarveOptions,
): Promise<CarveResult> {
  const onProgress = opts.onProgress ?? noopProgress;
  const t0 = performance.now();

  onProgress('decode', 0, 1);
  const decoded = await decodeImage(buffer);
  onProgress('decode', 1, 1);
  const tDecoded = performance.now();

  const inputSize: ImageSize = { w: decoded.width, h: decoded.height };
  const size: ImageSize = { ...inputSize };

  if (opts.toWidth > size.w) {
    throw new Error(
      `target width ${opts.toWidth} exceeds source width ${size.w}; upsizing not supported`,
    );
  }
  if (opts.toHeight > size.h) {
    throw new Error(
      `target height ${opts.toHeight} exceeds source height ${size.h}; upsizing not supported`,
    );
  }

  // The pixel buffers are never reallocated during carving; their stride
  // stays at the original input width and bytes get shifted left/up within
  // that fixed stride. All scratch buffers below mirror that strategy: sized
  // once at the start, indexed with the same stride throughout.
  const stride = inputSize.w;
  const cells = stride * inputSize.h;
  const energy = new Float32Array(cells);
  const dpEnergy = new Float64Array(cells);
  const dpPrev = new Int8Array(cells);
  const seamRowX = new Int16Array(inputSize.h); // x of seam pixel at each row (H seams)
  const seamColY = new Int16Array(inputSize.w); // y of seam pixel at each column (V seams)

  // alphaAware defaults to true (the better behaviour for transparent emotes
  // and a no-op on opaque inputs). Pass false to fall back to plain RGB
  // gradient energy.
  const alphaAware = opts.alphaAware !== false;
  const alphaThreshold = alphaAware ? ALPHA_DELETE_THRESHOLD : ALPHA_GATING_DISABLED;

  widthPass(
    decoded.frames,
    size,
    opts.toWidth,
    stride,
    energy,
    dpEnergy,
    dpPrev,
    seamRowX,
    alphaThreshold,
    onProgress,
  );
  const tWidth = performance.now();

  heightPass(
    decoded.frames,
    size,
    opts.toHeight,
    stride,
    energy,
    dpEnergy,
    dpPrev,
    seamColY,
    alphaThreshold,
    onProgress,
  );
  const tHeight = performance.now();

  const carvedSize: ImageSize = { ...size };

  let framesForEncode = decoded.frames;
  if (opts.scaleBackToOriginal) {
    onProgress('scale', 0, 1);
    framesForEncode = scaleAllFrames(decoded.frames, size, inputSize);
    size.w = inputSize.w;
    size.h = inputSize.h;
    onProgress('scale', 1, 1);
  }
  const tScaled = performance.now();

  onProgress('encode', 0, 1);
  const bytes = await encodeImage(decoded.format, framesForEncode, decoded.delays, size, {
    jpegQuality: opts.jpegQuality,
  });
  onProgress('encode', 1, 1);
  const tEncoded = performance.now();

  return {
    bytes,
    format: decoded.format,
    inputSize,
    carvedSize,
    outputSize: { ...size },
    frameCount: decoded.frames.length,
    scaledBack: Boolean(opts.scaleBackToOriginal),
    timings: {
      decodeMs: tDecoded - t0,
      widthCarveMs: tWidth - tDecoded,
      heightCarveMs: tHeight - tWidth,
      scaleMs: tScaled - tHeight,
      encodeMs: tEncoded - tScaled,
      totalMs: tEncoded - t0,
    },
  };
}

// Width pass: remove vertical seams (each carve drops one column). Build the
// horizontal-gradient energy map once, then for each seam find -> delete from
// frames + energy -> refresh just the two neighbour cells per row.
function widthPass(
  frames: ImageData[],
  size: ImageSize,
  toWidth: number,
  stride: number,
  energy: Float32Array,
  dpEnergy: Float64Array,
  dpPrev: Int8Array,
  seamRowX: Int16Array,
  alphaThreshold: number,
  onProgress: ProgressCallback,
): void {
  const pxToRemove = size.w - toWidth;
  onProgress('width', 0, pxToRemove);
  if (pxToRemove === 0) return;

  aggregateEnergyHFlat(frames, size, energy, stride, alphaThreshold);

  for (let i = 0; i < pxToRemove; i += 1) {
    findLowEnergySeamHFlat(energy, size, stride, dpEnergy, dpPrev, seamRowX);
    for (let f = 0; f < frames.length; f += 1) {
      deleteSeamHFromFrame(frames[f], seamRowX, size, stride);
    }
    deleteSeamHFromEnergy(energy, seamRowX, size, stride);
    size.w -= 1;
    refreshEnergyAfterSeamH(frames, energy, seamRowX, size, stride, alphaThreshold);
    onProgress('width', i + 1, pxToRemove);
  }
}

function heightPass(
  frames: ImageData[],
  size: ImageSize,
  toHeight: number,
  stride: number,
  energy: Float32Array,
  dpEnergy: Float64Array,
  dpPrev: Int8Array,
  seamColY: Int16Array,
  alphaThreshold: number,
  onProgress: ProgressCallback,
): void {
  const pxToRemove = size.h - toHeight;
  onProgress('height', 0, pxToRemove);
  if (pxToRemove === 0) return;

  // The vertical-gradient energy is a different field than the horizontal one
  // we built for the width pass, so we rebuild from scratch (single full pass
  // over the now-smaller frames).
  aggregateEnergyVFlat(frames, size, energy, stride, alphaThreshold);

  for (let i = 0; i < pxToRemove; i += 1) {
    findLowEnergySeamVFlat(energy, size, stride, dpEnergy, dpPrev, seamColY);
    for (let f = 0; f < frames.length; f += 1) {
      deleteSeamVFromFrame(frames[f], seamColY, size, stride);
    }
    deleteSeamVFromEnergy(energy, seamColY, size, stride);
    size.h -= 1;
    refreshEnergyAfterSeamV(frames, energy, seamColY, size, stride, alphaThreshold);
    onProgress('height', i + 1, pxToRemove);
  }
}

function noopProgress(): void {
  /* no-op */
}
