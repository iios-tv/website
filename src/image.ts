import { decodeGIF, encodeGIF } from './gif';
import type { ImageSize } from './types';

export type ImageFormat = 'gif' | 'png' | 'jpeg';

export type DecodedImage = {
  format: ImageFormat;
  frames: ImageData[];
  // For static (png/jpeg) inputs: [0]. For GIFs: per-frame delay in ms.
  delays: number[];
  width: number;
  height: number;
  // For static inputs: 0 (irrelevant). For GIFs: 0 = loop forever, n>0 = n times.
  loop: number;
};

const MIME_BY_FORMAT: Record<ImageFormat, string> = {
  gif: 'image/gif',
  png: 'image/png',
  jpeg: 'image/jpeg',
};

const EXT_BY_FORMAT: Record<ImageFormat, string> = {
  gif: 'gif',
  png: 'png',
  jpeg: 'jpg',
};

export function mimeFor(format: ImageFormat): string {
  return MIME_BY_FORMAT[format];
}

export function extFor(format: ImageFormat): string {
  return EXT_BY_FORMAT[format];
}

// Sniff the first few bytes of the buffer for one of our supported formats.
// Returns null for anything else (animated PNG, WebP, AVIF, etc.) -- callers
// surface this as a friendly error rather than blindly trying to decode.
export function detectFormat(buffer: ArrayBuffer): ImageFormat | null {
  const view = new Uint8Array(buffer, 0, Math.min(8, buffer.byteLength));
  if (
    view.length >= 4 &&
    view[0] === 0x47 &&
    view[1] === 0x49 &&
    view[2] === 0x46 &&
    view[3] === 0x38
  ) {
    return 'gif';
  }
  if (
    view.length >= 8 &&
    view[0] === 0x89 &&
    view[1] === 0x50 &&
    view[2] === 0x4e &&
    view[3] === 0x47 &&
    view[4] === 0x0d &&
    view[5] === 0x0a &&
    view[6] === 0x1a &&
    view[7] === 0x0a
  ) {
    return 'png';
  }
  if (view.length >= 3 && view[0] === 0xff && view[1] === 0xd8 && view[2] === 0xff) {
    return 'jpeg';
  }
  return null;
}

// Decode any supported image into a uniform multi-frame structure. Static
// images (png/jpeg) become a 1-frame array with delay [0]; the rest of the
// pipeline can stay format-agnostic from here on.
export async function decodeImage(buffer: ArrayBuffer): Promise<DecodedImage> {
  const format = detectFormat(buffer);
  if (!format) {
    throw new Error('unsupported image format (expected GIF, PNG, or JPEG)');
  }

  if (format === 'gif') {
    const decoded = decodeGIF(buffer);
    return {
      format,
      frames: decoded.frames,
      delays: decoded.delays,
      width: decoded.width,
      height: decoded.height,
      loop: decoded.loop,
    };
  }

  const blob = new Blob([buffer], { type: MIME_BY_FORMAT[format] });
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');
    ctx.drawImage(bitmap, 0, 0);
    const frame = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return {
      format,
      frames: [frame],
      delays: [0],
      width: bitmap.width,
      height: bitmap.height,
      loop: 0,
    };
  } finally {
    bitmap.close();
  }
}

export type EncodeOptions = {
  // JPEG quality 0..1; ignored for other formats. 0.92 is a sensible default
  // (visually near-lossless for most photographic content, ~8x smaller than
  // PNG for typical inputs).
  jpegQuality?: number;
};

// Encode a (possibly multi-frame) image back to bytes in the chosen format.
// For static formats only the first frame is encoded -- the carve pipeline
// already collapsed the input to a single frame in the static case.
export async function encodeImage(
  format: ImageFormat,
  frames: ImageData[],
  delays: number[],
  size: ImageSize,
  opts: EncodeOptions = {},
): Promise<Uint8Array> {
  if (format === 'gif') {
    return encodeGIF(frames, delays, size);
  }

  if (frames.length === 0) {
    throw new Error('no frames to encode');
  }

  const frame = frames[0];
  const canvas = new OffscreenCanvas(size.w, size.h);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');

  // The frame's underlying buffer is sized to its original stride; only the
  // top-left (size.w x size.h) is meaningful after the carve. ImageData
  // dimensions and stride must agree, so we copy the live region into a
  // tightly-packed ImageData before painting.
  const tight = packToTight(frame, size);
  ctx.putImageData(tight, 0, 0);

  const blob = await canvas.convertToBlob({
    type: MIME_BY_FORMAT[format],
    quality: format === 'jpeg' ? (opts.jpegQuality ?? 0.92) : undefined,
  });
  return new Uint8Array(await blob.arrayBuffer());
}

function packToTight(src: ImageData, size: ImageSize): ImageData {
  if (src.width === size.w && src.height === size.h) return src;
  const out = new ImageData(size.w, size.h);
  const srcStride = src.width * 4;
  const dstStride = size.w * 4;
  for (let y = 0; y < size.h; y += 1) {
    const srcStart = y * srcStride;
    const dstStart = y * dstStride;
    out.data.set(src.data.subarray(srcStart, srcStart + dstStride), dstStart);
  }
  return out;
}
