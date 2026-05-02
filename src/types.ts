export type Coordinate = { x: number; y: number };

export type ImageSize = { w: number; h: number };

export type Color = [r: number, g: number, b: number, a: number] | Uint8ClampedArray;

export type Seam = Coordinate[];

export type EnergyMap = number[][];

export type DecodedGif = {
  frames: ImageData[];
  delays: number[];
  width: number;
  height: number;
  loop: number;
};
