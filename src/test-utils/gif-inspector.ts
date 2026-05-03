// Minimal GIF byte-stream walker for tests.
//
// Pulls out just the fields we assert on:
//   - Logical screen descriptor: background colour index + GCT presence
//   - Global colour table entry 0 (the colour the decoder paints into the
//     "background" between frames when disposal=2)
//   - Per-frame Graphic Control Extensions: transparent flag, transparent
//     colour index, disposal method
//
// Spec: https://www.w3.org/Graphics/GIF/spec-gif89a.txt
//
// We don't validate the LZW image data or the local colour tables --
// those are gifenc's responsibility and aren't relevant to the
// transparency-handling invariants we want to lock in.

export type GceInfo = {
  // Transparent colour flag from the GCE packed byte.
  transp: boolean;
  // Disposal method (0..7) from the GCE packed byte.
  disp: number;
  // Transparent colour index. Only meaningful when transp === true.
  transparentIndex: number;
};

export type GifInfo = {
  width: number;
  height: number;
  // Background colour index from the LSD. gifenc hard-codes this to 0.
  bgIdx: number;
  // RGB of global colour table entry 0, or null if no GCT was written.
  gctIndex0: [number, number, number] | null;
  // Number of entries in the global colour table.
  gctSize: number;
  // One GceInfo per frame, in encounter order.
  gces: GceInfo[];
};

const TRAILER = 0x3b;
const EXT_INTRODUCER = 0x21;
const GCE_LABEL = 0xf9;
const IMAGE_SEPARATOR = 0x2c;

export function inspectGif(bytes: Uint8Array): GifInfo {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Header is 6 bytes ("GIF87a" or "GIF89a"). LSD follows immediately.
  const lsd = 6;
  const width = dv.getUint16(lsd, true);
  const height = dv.getUint16(lsd + 2, true);
  const packed = dv.getUint8(lsd + 4);
  const bgIdx = dv.getUint8(lsd + 5);
  const gctFlag = (packed >> 7) & 1;
  const gctSize = 1 << ((packed & 7) + 1);

  let off = lsd + 7;
  let gctIndex0: [number, number, number] | null = null;
  if (gctFlag) {
    gctIndex0 = [
      dv.getUint8(off + 0),
      dv.getUint8(off + 1),
      dv.getUint8(off + 2),
    ];
    off += gctSize * 3;
  }

  const gces: GceInfo[] = [];

  while (off < bytes.length) {
    const b = dv.getUint8(off);
    if (b === TRAILER) break;

    if (b === EXT_INTRODUCER) {
      const label = dv.getUint8(off + 1);
      if (label === GCE_LABEL) {
        // GCE layout: introducer, label, block size (always 4),
        // packed, delay (u16le), transparent index, terminator.
        const packedG = dv.getUint8(off + 3);
        gces.push({
          transp: (packedG & 0x01) !== 0,
          disp: (packedG >> 2) & 0x07,
          transparentIndex: dv.getUint8(off + 6),
        });
        off += 8;
        continue;
      }
      // Other extensions (Netscape, comment, ...): skip the data sub-blocks.
      off = skipSubBlocks(dv, off + 2);
      continue;
    }

    if (b === IMAGE_SEPARATOR) {
      // Image descriptor: separator, x, y, w, h, packed.
      const packedI = dv.getUint8(off + 9);
      const lctFlag = (packedI >> 7) & 1;
      const lctSize = 1 << ((packedI & 7) + 1);
      off += 10;
      if (lctFlag) off += lctSize * 3;
      // LZW minimum code size, then sub-blocks of compressed image data.
      off += 1;
      off = skipSubBlocks(dv, off);
      continue;
    }

    off += 1;
  }

  return { width, height, bgIdx, gctIndex0, gctSize, gces };
}

// Read a chain of size-prefixed sub-blocks terminated by a 0-length block.
// Returns the offset just past the terminator.
function skipSubBlocks(dv: DataView, start: number): number {
  let off = start;
  while (off < dv.byteLength) {
    const sz = dv.getUint8(off);
    if (sz === 0) {
      return off + 1;
    }
    off += 1 + sz;
  }
  return off;
}
