// Helpers for synthesising small test ImageData frames.
//
// We need three building blocks to cover the GIF transparency invariants:
//   1. A frame with a clearly visible subject + a transparent halo (the
//      common case for animated emotes).
//   2. A fully opaque frame with no transparent pixels (pre-fix this was
//      the trigger for the dropped-transparent-flag bug).
//   3. A fully transparent frame (boundary case).

export function frameWithTransparentHalo(w = 32, h = 32): ImageData {
  const data = new Uint8ClampedArray(w * h * 4);
  // Subject: opaque green square in the middle quarter of the frame.
  const x0 = Math.floor(w / 4);
  const x1 = w - x0;
  const y0 = Math.floor(h / 4);
  const y1 = h - y0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * w + x) * 4;
      data[i + 0] = 0;
      data[i + 1] = 200;
      data[i + 2] = 0;
      data[i + 3] = 255;
    }
  }
  return new ImageData(data, w, h);
}

export function frameFullyOpaque(w = 32, h = 32): ImageData {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      data[i + 0] = (x * 255) / Math.max(1, w - 1);
      data[i + 1] = (y * 255) / Math.max(1, h - 1);
      data[i + 2] = 128;
      data[i + 3] = 255;
    }
  }
  return new ImageData(data, w, h);
}

export function frameFullyTransparent(w = 32, h = 32): ImageData {
  return new ImageData(new Uint8ClampedArray(w * h * 4), w, h);
}

// Read a single RGBA pixel out of an ImageData at (x, y).
export function pixelAt(img: ImageData, x: number, y: number): [number, number, number, number] {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}
