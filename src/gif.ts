import { parseGIF, decompressFrames, type ParsedFrame } from 'gifuct-js';
import { GIFEncoder, quantize, applyPalette, type Palette } from 'gifenc';

import type { DecodedGif, ImageSize } from './types';

const TRANSPARENT_ALPHA_THRESHOLD = 127;

// Decode an animated GIF into N full-size composed RGBA ImageData frames.
//
// Composition handles GIF disposal methods so that every output frame is what
// the user would actually see at that point in the animation timeline.
//
//   0 / 1  - do not dispose: next frame is drawn on top of this canvas
//   2      - restore to background: clear this frame's patch area to transparent
//   3      - restore to previous: revert canvas to what it was before this frame
export function decodeGIF(buffer: ArrayBuffer): DecodedGif {
  const parsed = parseGIF(buffer);
  const frames = decompressFrames(parsed, true);

  const width = parsed.lsd.width;
  const height = parsed.lsd.height;

  const canvas = new Uint8ClampedArray(width * height * 4);
  const composed: ImageData[] = [];
  const delays: number[] = [];

  let savedForRestore: Uint8ClampedArray | null = null;
  let savedDisposalIndex = -1;

  frames.forEach((frame: ParsedFrame, idx: number) => {
    if (frame.disposalType === 3) {
      savedForRestore = canvas.slice();
      savedDisposalIndex = idx;
    }

    blitPatch(canvas, width, frame);

    const snapshot = new Uint8ClampedArray(canvas);
    composed.push(new ImageData(snapshot, width, height));
    delays.push(frame.delay);

    if (frame.disposalType === 2) {
      clearRect(canvas, width, frame.dims);
    } else if (frame.disposalType === 3 && savedForRestore && savedDisposalIndex === idx) {
      canvas.set(savedForRestore);
    }
  });

  return {
    frames: composed,
    delays,
    width,
    height,
    loop: 0,
  };
}

// Encode an array of ImageData frames as an animated GIF.
//
// Each frame is independently quantized to <=256 colors with one-bit alpha
// preserved (any sufficiently-transparent pixel becomes the GIF's transparent
// index). The first frame's palette is written as the global color table; each
// subsequent frame uses a local color table.
export function encodeGIF(
  frames: ImageData[],
  delays: number[],
  size: ImageSize,
): Uint8Array {
  const { w, h } = size;
  if (frames.length === 0) {
    throw new Error('encodeGIF requires at least one frame');
  }
  if (frames.length !== delays.length) {
    throw new Error('frames and delays must have the same length');
  }

  const encoder = GIFEncoder();

  frames.forEach((frame, i) => {
    const rgba = sliceToWorkingSize(frame, size);
    const palette = quantize(rgba, 256, {
      format: 'rgba4444',
      oneBitAlpha: TRANSPARENT_ALPHA_THRESHOLD,
    });
    const indexed = applyPalette(rgba, palette, 'rgba4444');

    const transparentIndex = findTransparentIndex(palette);

    encoder.writeFrame(indexed, w, h, {
      palette,
      delay: Math.max(20, delays[i] || 100),
      repeat: i === 0 ? 0 : -1,
      transparent: transparentIndex >= 0,
      transparentIndex: transparentIndex >= 0 ? transparentIndex : 0,
      dispose: 2,
    });
  });

  encoder.finish();
  return encoder.bytes();
}

// Carving operates on each frame's underlying buffer in place but tracks the
// shrunk logical size separately. When we encode, we need to extract just the
// (w x h) top-left region from the full-size buffer.
function sliceToWorkingSize(frame: ImageData, size: ImageSize): Uint8ClampedArray {
  const { w, h } = size;
  if (frame.width === w && frame.height === h) {
    return frame.data;
  }
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    const srcOffset = y * frame.width * 4;
    const dstOffset = y * w * 4;
    out.set(frame.data.subarray(srcOffset, srcOffset + w * 4), dstOffset);
  }
  return out;
}

function blitPatch(canvas: Uint8ClampedArray, canvasWidth: number, frame: ParsedFrame): void {
  const { left, top, width: patchWidth, height: patchHeight } = frame.dims;
  const patch = frame.patch;
  for (let py = 0; py < patchHeight; py += 1) {
    for (let px = 0; px < patchWidth; px += 1) {
      const patchIdx = (py * patchWidth + px) * 4;
      const a = patch[patchIdx + 3];
      if (a === 0) continue;
      const canvasIdx = ((top + py) * canvasWidth + (left + px)) * 4;
      canvas[canvasIdx] = patch[patchIdx];
      canvas[canvasIdx + 1] = patch[patchIdx + 1];
      canvas[canvasIdx + 2] = patch[patchIdx + 2];
      canvas[canvasIdx + 3] = a;
    }
  }
}

function clearRect(
  canvas: Uint8ClampedArray,
  canvasWidth: number,
  dims: { left: number; top: number; width: number; height: number },
): void {
  for (let py = 0; py < dims.height; py += 1) {
    const offset = ((dims.top + py) * canvasWidth + dims.left) * 4;
    canvas.fill(0, offset, offset + dims.width * 4);
  }
}

function findTransparentIndex(palette: Palette): number {
  for (let i = 0; i < palette.length; i += 1) {
    const entry = palette[i];
    if (entry.length === 4 && entry[3] === 0) return i;
  }
  return -1;
}
