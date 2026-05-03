import { describe, expect, it } from 'vitest';

import { decodeGIF, encodeGIF } from './gif';
import { inspectGif } from './test-utils/gif-inspector';
import {
  frameFullyOpaque,
  frameFullyTransparent,
  frameWithTransparentHalo,
  pixelAt,
} from './test-utils/synth';

const W = 32;
const H = 32;

describe('encodeGIF transparency invariants', () => {
  // Regression for the "intermittent black background" bug fixed in this
  // module. gifenc hard-codes the GIF logical-screen-descriptor's
  // backgroundColorIndex to 0 and `dispose: 2` clears each frame's region
  // to global-palette[0] before the next frame draws. If index 0 isn't
  // transparent, "see-through" regions render as whatever opaque colour
  // landed there (typically black, since GIF source-transparent pixels
  // almost always store RGB=(0,0,0)).
  //
  // The fix has three parts; each is asserted below:
  //   1. Quantize to 255 colours (slot 0 reserved).
  //   2. Splice [0,0,0,0] into palette index 0 on every frame.
  //   3. Set transparent=true / transparentIndex=0 on every frame.
  //
  // The hardest case is a frame with zero transparent pixels: pre-fix
  // findTransparentIndex returned -1 for that frame, so transparent=false
  // was emitted, and the next frame's transparent halo bled the opaque
  // background through. We pin transparent=true unconditionally now.

  it("places an RGB=(0,0,0) entry at global-palette index 0 (the dispose=2 background)", () => {
    // Use a fully-opaque rainbow as frame 0 so quantize has no transparent
    // bin to coincidentally place at index 0 -- if this assertion holds,
    // it's because we explicitly spliced [0,0,0,0] there.
    const bytes = encodeGIF(
      [frameFullyOpaque(W, H)],
      [100],
      { w: W, h: H },
    );
    const info = inspectGif(bytes);
    expect(info.bgIdx).toBe(0);
    expect(info.gctIndex0).toEqual([0, 0, 0]);
  });

  it('writes transparent=true, transparentIndex=0, dispose=2 on every frame', () => {
    const frames = [
      frameWithTransparentHalo(W, H),
      frameFullyOpaque(W, H),
      frameWithTransparentHalo(W, H),
    ];
    const bytes = encodeGIF(frames, [100, 100, 100], { w: W, h: H });

    const info = inspectGif(bytes);
    expect(info.gces).toHaveLength(frames.length);
    for (const gce of info.gces) {
      expect(gce.transp).toBe(true);
      expect(gce.transparentIndex).toBe(0);
      expect(gce.disp).toBe(2);
    }
  });

  it('keeps transparent=true even for a frame containing zero transparent pixels (regression)', () => {
    // Pre-fix this case dropped the transparent flag and the NEXT frame's
    // transparent halo decoded as opaque black. Test the trigger frame in
    // isolation.
    const bytes = encodeGIF([frameFullyOpaque(W, H)], [100], { w: W, h: H });
    const info = inspectGif(bytes);
    expect(info.gces).toHaveLength(1);
    expect(info.gces[0].transp).toBe(true);
    expect(info.gces[0].transparentIndex).toBe(0);
  });

  it('handles a fully transparent frame', () => {
    const bytes = encodeGIF([frameFullyTransparent(W, H)], [100], { w: W, h: H });
    const info = inspectGif(bytes);
    expect(info.gctIndex0).toEqual([0, 0, 0]);
    expect(info.gces[0].transp).toBe(true);
  });
});

describe('encodeGIF + decodeGIF roundtrip', () => {
  it('preserves frame count and dimensions', () => {
    const frames = [
      frameWithTransparentHalo(W, H),
      frameFullyOpaque(W, H),
      frameWithTransparentHalo(W, H),
    ];
    const bytes = encodeGIF(frames, [80, 80, 80], { w: W, h: H });
    const decoded = decodeGIF(toArrayBuffer(bytes));
    expect(decoded.width).toBe(W);
    expect(decoded.height).toBe(H);
    expect(decoded.frames).toHaveLength(frames.length);
    for (const frame of decoded.frames) {
      expect(frame.width).toBe(W);
      expect(frame.height).toBe(H);
    }
  });

  it('decodes the opaque centre subject as opaque green', () => {
    // Quantization snaps to the 4-bit-per-channel grid (0, 17, 34, ...,
    // 255), so we tolerate that within the assertion. The point is "still
    // opaque, still recognisably green", not bit-exact preservation.
    const bytes = encodeGIF(
      [frameWithTransparentHalo(W, H)],
      [100],
      { w: W, h: H },
    );
    const decoded = decodeGIF(toArrayBuffer(bytes));
    const [r, g, b, a] = pixelAt(decoded.frames[0], W / 2, H / 2);
    expect(a).toBe(255);
    expect(g).toBeGreaterThan(150);
    expect(r).toBeLessThan(80);
    expect(b).toBeLessThan(80);
  });

  it('decodes the halo region as fully transparent', () => {
    const bytes = encodeGIF(
      [frameWithTransparentHalo(W, H)],
      [100],
      { w: W, h: H },
    );
    const decoded = decodeGIF(toArrayBuffer(bytes));
    // Top-left corner is well outside the centre quarter.
    const [, , , a] = pixelAt(decoded.frames[0], 0, 0);
    expect(a).toBe(0);
  });
});

// Node's Uint8Array.buffer can be a SharedArrayBuffer in some toolchains;
// gifuct-js wants a plain ArrayBuffer. Slice into a fresh one so the test
// stays portable.
function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}
