declare module 'gifenc' {
  export type RGB = [number, number, number];
  export type RGBA = [number, number, number, number];
  export type Palette = RGB[] | RGBA[];

  export type QuantizeFormat = 'rgb565' | 'rgb444' | 'rgba4444';

  export interface QuantizeOptions {
    format?: QuantizeFormat;
    clearAlpha?: boolean;
    clearAlphaColor?: number;
    clearAlphaThreshold?: number;
    oneBitAlpha?: boolean | number;
  }

  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    opts?: QuantizeOptions,
  ): Palette;

  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: Palette,
    format?: QuantizeFormat,
  ): Uint8Array;

  export interface WriteFrameOptions {
    palette?: Palette | null;
    delay?: number;
    transparent?: boolean;
    transparentIndex?: number;
    repeat?: number;
    colorDepth?: number;
    dispose?: number;
    first?: boolean;
  }

  export interface Encoder {
    reset(): void;
    finish(): void;
    bytes(): Uint8Array;
    bytesView(): Uint8Array;
    writeHeader(): void;
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      opts?: WriteFrameOptions,
    ): void;
    readonly buffer: ArrayBuffer;
  }

  export interface EncoderOptions {
    initialCapacity?: number;
    auto?: boolean;
  }

  export function GIFEncoder(opts?: EncoderOptions): Encoder;

  const _default: typeof GIFEncoder;
  export default _default;
}
