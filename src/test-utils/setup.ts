// Polyfills the handful of browser globals our production code touches, so
// the same modules can be exercised by the Node test runner.
//
// We deliberately implement only the surface the codebase actually uses:
// - ImageData(data, w, h) and ImageData(w, h) constructors
// - .data / .width / .height fields
//
// Anything more ambitious belongs in jsdom / happy-dom; we don't need it.

class ImageDataPolyfill {
  data: Uint8ClampedArray;
  width: number;
  height: number;

  constructor(dataOrW: Uint8ClampedArray | number, wOrH: number, h?: number) {
    if (dataOrW instanceof Uint8ClampedArray) {
      this.data = dataOrW;
      this.width = wOrH;
      this.height = h as number;
    } else {
      this.width = dataOrW;
      this.height = wOrH;
      this.data = new Uint8ClampedArray(this.width * this.height * 4);
    }
  }
}

if (typeof (globalThis as { ImageData?: unknown }).ImageData === 'undefined') {
  Object.defineProperty(globalThis, 'ImageData', {
    value: ImageDataPolyfill,
    writable: false,
    configurable: true,
  });
}
