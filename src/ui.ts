import type { CarveResult } from './pipeline';
import { CarveWorkerClient, formatProgress } from './carve-client';
import { extFor, mimeFor, type ImageFormat } from './image';

const DEFAULT_WIDTH_PCT = 50;
const DEFAULT_HEIGHT_PCT = 50;

// Each variant is one configuration of carve options that the user can toggle
// on for a side-by-side comparison. Adding a new comparison axis (e.g. an
// alternative energy formula) is as simple as appending another entry; the
// UI grows another checkbox + output card automatically.
type VariantConfig = {
  id: string;
  label: string; // text on the checkbox
  shortLabel: string; // text in the card title (kept tight to fit the column)
  alphaAware: boolean;
  defaultChecked: boolean;
};

const VARIANTS: VariantConfig[] = [
  {
    id: 'alpha-on',
    label: 'Alpha-aware energy',
    shortLabel: 'Alpha-aware',
    alphaAware: true,
    defaultChecked: true,
  },
  {
    id: 'alpha-off',
    label: 'No alpha gating',
    shortLabel: 'No gating',
    alphaAware: false,
    defaultChecked: true,
  },
];

type VariantOutput = {
  url: string;
  result: CarveResult;
  blob: Blob;
};

type State = {
  inputBuffer: ArrayBuffer | null;
  inputUrl: string | null;
  outputs: Map<string, VariantOutput>;
  inputName: string;
};

export function mountUi(root: HTMLElement): void {
  root.innerHTML = `
    <div class="controls">
      <label>
        Choose image
        <input type="file" id="file" accept="image/gif,image/png,image/jpeg" />
      </label>
      <label>
        Width %
        <input type="number" id="width-pct" min="1" max="100" value="${DEFAULT_WIDTH_PCT}" />
      </label>
      <label>
        Height %
        <input type="number" id="height-pct" min="1" max="100" value="${DEFAULT_HEIGHT_PCT}" />
      </label>
      <label title="After carving, bilinear-scale the result back up to the original image dimensions. The output keeps the original size but with low-energy areas compressed -- effectively a content-aware zoom toward the subject.">
        <input type="checkbox" id="scale-back" checked />
        Scale back to original size
      </label>
    </div>
    <div class="variants-row">
      <span class="variants-label" title="Each checked variant produces its own output card so you can compare them side-by-side.">
        Variants:
      </span>
      ${VARIANTS.map(
        (v) =>
          `<label title="${variantTooltip(v)}"><input type="checkbox" data-variant="${v.id}" ${v.defaultChecked ? 'checked' : ''} /> ${v.label}</label>`,
      ).join('')}
      <button id="carve" disabled>Carve</button>
    </div>
    <div class="status" id="status"></div>
    <div class="preview" id="preview">
      <div class="preview-card" data-pane="orig">
        <span class="label" id="orig-label">Original</span>
        <img id="orig" alt="Original image" />
      </div>
      <div class="preview-outputs">
        ${VARIANTS.map(
          (v) => `
          <div class="preview-card" data-pane="${v.id}" hidden>
            <div class="label-row">
              <span class="label" data-label="${v.id}">${v.shortLabel}</span>
              <a class="download-btn" data-download="${v.id}" hidden download>Download</a>
            </div>
            <img data-image="${v.id}" alt="Carved image (${v.shortLabel})" />
            <pre class="timings" data-timings="${v.id}" hidden></pre>
          </div>`,
        ).join('')}
      </div>
    </div>
  `;

  const fileInput = root.querySelector<HTMLInputElement>('#file')!;
  const widthInput = root.querySelector<HTMLInputElement>('#width-pct')!;
  const heightInput = root.querySelector<HTMLInputElement>('#height-pct')!;
  const scaleBackInput = root.querySelector<HTMLInputElement>('#scale-back')!;
  const carveBtn = root.querySelector<HTMLButtonElement>('#carve')!;
  const status = root.querySelector<HTMLDivElement>('#status')!;
  const origImg = root.querySelector<HTMLImageElement>('#orig')!;
  const origLabel = root.querySelector<HTMLSpanElement>('#orig-label')!;
  const variantCheckboxes = Array.from(
    root.querySelectorAll<HTMLInputElement>('input[data-variant]'),
  );

  const state: State = {
    inputBuffer: null,
    inputUrl: null,
    outputs: new Map(),
    inputName: '',
  };

  // Lazily spawned on first carve so we don't pay the worker startup cost
  // for users who only browse the page. Kept alive across carves.
  let carveClient: CarveWorkerClient | null = null;
  function getCarveClient(): CarveWorkerClient {
    if (!carveClient) carveClient = new CarveWorkerClient();
    return carveClient;
  }

  function getCheckedVariants(): VariantConfig[] {
    return VARIANTS.filter(
      (v) =>
        root.querySelector<HTMLInputElement>(`input[data-variant="${v.id}"]`)?.checked ?? false,
    );
  }

  function refreshCarveButton(): void {
    const ready = state.inputBuffer !== null;
    const anyVariant = getCheckedVariants().length > 0;
    carveBtn.disabled = !(ready && anyVariant);
  }

  function clearAllOutputs(): void {
    for (const out of state.outputs.values()) URL.revokeObjectURL(out.url);
    state.outputs.clear();
    for (const v of VARIANTS) hideVariantPane(root, v.id);
  }

  async function loadFile(file: File): Promise<void> {
    if (!isSupportedImage(file)) {
      status.textContent = `error: unsupported file (${file.name || 'unknown'}); expected GIF, PNG, or JPEG`;
      return;
    }

    revokeIfSet(state.inputUrl);
    clearAllOutputs();

    state.inputBuffer = await file.arrayBuffer();
    state.inputUrl = URL.createObjectURL(file);
    state.inputName = file.name;

    origImg.src = state.inputUrl;
    origLabel.textContent = `Original (${file.name}, ${formatBytes(file.size)})`;
    status.textContent = '';
    refreshCarveButton();
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (file) await loadFile(file);
  });

  installDropZone(loadFile, status);

  for (const cb of variantCheckboxes) {
    cb.addEventListener('change', refreshCarveButton);
  }

  carveBtn.addEventListener('click', async () => {
    if (!state.inputBuffer) return;
    const variants = getCheckedVariants();
    if (variants.length === 0) {
      status.textContent = 'pick at least one variant to carve';
      return;
    }

    const widthPct = clampPct(widthInput.valueAsNumber, DEFAULT_WIDTH_PCT);
    const heightPct = clampPct(heightInput.valueAsNumber, DEFAULT_HEIGHT_PCT);
    const toWidth = Math.max(1, Math.floor((widthPct * getNaturalWidth(origImg)) / 100));
    const toHeight = Math.max(1, Math.floor((heightPct * getNaturalHeight(origImg)) / 100));
    const scaleBack = scaleBackInput.checked;

    carveBtn.disabled = true;
    clearAllOutputs();

    try {
      const client = getCarveClient();
      for (let i = 0; i < variants.length; i += 1) {
        const variant = variants[i];
        const prefix =
          variants.length > 1
            ? `Variant ${i + 1}/${variants.length} (${variant.shortLabel}): `
            : '';
        status.textContent = `${prefix}Carving...`;

        const result = await client.carve(
          state.inputBuffer,
          {
            toWidth,
            toHeight,
            scaleBackToOriginal: scaleBack,
            alphaAware: variant.alphaAware,
          },
          (info) => {
            status.textContent = `${prefix}${formatProgress(info)}`;
          },
        );

        const blob = new Blob([result.bytes as BlobPart], { type: mimeFor(result.format) });
        const url = URL.createObjectURL(blob);
        state.outputs.set(variant.id, { url, result, blob });
        renderVariantPane(root, variant, url, result, blob, state.inputName);
      }
      status.textContent = '';
      syncAnimatedPlayback(root, origImg, state);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      status.textContent = `error: ${msg}`;
      console.error(err);
    } finally {
      refreshCarveButton();
    }
  });
}

// Animated GIFs in <img> tags start playing as soon as their src is set,
// so the original (loaded on upload) and the carved variants (set later,
// at staggered times as each variant finishes) drift out of phase. Once
// every variant has rendered we clear and re-assign src on all of them
// in a single microtask, which forces every animation to restart from
// frame 0 essentially simultaneously and stay visually synced thereafter.
// Skipped for non-animated inputs to avoid a pointless flicker.
function syncAnimatedPlayback(
  root: HTMLElement,
  origImg: HTMLImageElement,
  state: State,
): void {
  const animated = Array.from(state.outputs.values()).some(
    (o) => o.result.frameCount > 1,
  );
  if (!animated) return;

  const items: { img: HTMLImageElement; url: string }[] = [];
  if (state.inputUrl) items.push({ img: origImg, url: state.inputUrl });
  for (const v of VARIANTS) {
    const out = state.outputs.get(v.id);
    if (!out) continue;
    const img = root.querySelector<HTMLImageElement>(`[data-image="${v.id}"]`);
    if (img) items.push({ img, url: out.url });
  }
  if (items.length === 0) return;

  for (const { img } of items) img.removeAttribute('src');
  Promise.resolve().then(() => {
    for (const { img, url } of items) img.src = url;
  });
}

function variantTooltip(v: VariantConfig): string {
  return v.alphaAware
    ? 'Pixels with alpha <= 244 get a huge negative energy so transparent halos around stickers/emotes are carved away first. Best for images with a transparent background.'
    : 'Energy comes from the RGB gradient only; alpha is ignored. Useful for opaque images, or as a comparison baseline against the alpha-aware variant.';
}

function hideVariantPane(root: HTMLElement, id: string): void {
  const pane = root.querySelector<HTMLDivElement>(`[data-pane="${id}"]`);
  if (!pane) return;
  pane.setAttribute('hidden', '');
  const img = pane.querySelector<HTMLImageElement>('img');
  img?.removeAttribute('src');
  const download = pane.querySelector<HTMLAnchorElement>('.download-btn');
  if (download) {
    download.setAttribute('hidden', '');
    download.removeAttribute('href');
  }
  const timings = pane.querySelector<HTMLPreElement>('.timings');
  if (timings) {
    timings.setAttribute('hidden', '');
    timings.textContent = '';
  }
}

function renderVariantPane(
  root: HTMLElement,
  variant: VariantConfig,
  url: string,
  result: CarveResult,
  blob: Blob,
  inputName: string,
): void {
  const pane = root.querySelector<HTMLDivElement>(`[data-pane="${variant.id}"]`);
  if (!pane) return;
  pane.removeAttribute('hidden');

  const img = pane.querySelector<HTMLImageElement>('img');
  if (img) img.src = url;

  const label = pane.querySelector<HTMLSpanElement>('.label');
  if (label) {
    const carvedDims = `${result.carvedSize.w}x${result.carvedSize.h}`;
    const outDims = `${result.outputSize.w}x${result.outputSize.h}`;
    const dimText = result.scaledBack
      ? `${outDims}, carved to ${carvedDims} then scaled back`
      : outDims;
    const fmtTag = result.format.toUpperCase();
    label.textContent = `${variant.shortLabel} - ${fmtTag} (${dimText}, ${formatBytes(blob.size)})`;
  }

  const download = pane.querySelector<HTMLAnchorElement>('.download-btn');
  if (download) {
    download.href = url;
    download.download = makeDownloadName(
      inputName,
      result.format,
      result.outputSize.w,
      result.outputSize.h,
      result.scaledBack,
      variant.id,
    );
    download.removeAttribute('hidden');
  }

  const timings = pane.querySelector<HTMLPreElement>('.timings');
  if (timings) {
    timings.textContent = formatTimings(result);
    timings.removeAttribute('hidden');
  }
}

function clampPct(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(100, Math.floor(value)));
}

function getNaturalWidth(img: HTMLImageElement): number {
  return img.naturalWidth || 1;
}

function getNaturalHeight(img: HTMLImageElement): number {
  return img.naturalHeight || 1;
}

function revokeIfSet(url: string | null): void {
  if (url) URL.revokeObjectURL(url);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatTimings(result: CarveResult): string {
  const t = result.timings;
  const lines = [
    `frames:        ${result.frameCount}`,
    `decode:        ${t.decodeMs.toFixed(1)} ms`,
    `width carve:   ${t.widthCarveMs.toFixed(1)} ms`,
    `height carve:  ${t.heightCarveMs.toFixed(1)} ms`,
    `scale-back:    ${t.scaleMs.toFixed(1)} ms`,
    `encode:        ${t.encodeMs.toFixed(1)} ms`,
    `total:         ${t.totalMs.toFixed(1)} ms`,
  ];
  return lines.join('\n');
}

// Build a "<stem>.carved.WxH[.scaled].<variant>.<ext>" name from the input
// filename and output format. Including the variant id keeps multiple
// variants of the same input from clobbering each other on download.
function makeDownloadName(
  inputName: string,
  format: ImageFormat,
  w: number,
  h: number,
  scaledBack: boolean,
  variantId: string,
): string {
  const ext = extFor(format);
  const trimmed = (inputName || '').trim();
  const stem = stripKnownExtension(trimmed) || 'output';
  const dimTag = scaledBack ? `${w}x${h}.scaled` : `${w}x${h}`;
  return `${stem}.carved.${dimTag}.${variantId}.${ext}`;
}

const KNOWN_EXTENSIONS = ['.gif', '.png', '.jpg', '.jpeg'];

function stripKnownExtension(name: string): string {
  const lower = name.toLowerCase();
  for (const e of KNOWN_EXTENSIONS) {
    if (lower.endsWith(e) && name.length > e.length) {
      return name.slice(0, -e.length);
    }
  }
  return name;
}

const SUPPORTED_MIME_TYPES = new Set(['image/gif', 'image/png', 'image/jpeg']);

function isSupportedImage(file: File): boolean {
  if (SUPPORTED_MIME_TYPES.has(file.type)) return true;
  // Some sources (e.g. drags from apps that don't set a MIME type) leave
  // file.type empty; fall back to extension. Decoding failures will still
  // surface as a friendly error if it's a misnamed file.
  const lower = file.name.toLowerCase();
  return KNOWN_EXTENSIONS.some((e) => lower.endsWith(e));
}

function dataTransferHasFiles(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  for (const t of Array.from(dt.types)) {
    if (t === 'Files') return true;
  }
  return false;
}

function pickImageFromDataTransfer(dt: DataTransfer | null): File | null {
  if (!dt) return null;
  for (const f of Array.from(dt.files)) {
    if (isSupportedImage(f)) return f;
  }
  // Fall back to the first file even if it's not supported, so the caller can
  // produce a useful error message naming the file.
  return dt.files.length > 0 ? dt.files[0] : null;
}

// Wire up window-level drag-and-drop. The whole page acts as a drop zone:
// dropping anywhere triggers loadFile. We use a depth counter because
// dragleave fires when the cursor crosses *into* a child element too;
// counting enter/leave events keeps the overlay state correct as the
// pointer moves over nested elements.
function installDropZone(
  loadFile: (file: File) => Promise<void>,
  status: HTMLElement,
): void {
  const overlay = document.getElementById('drop-overlay');
  let depth = 0;

  const showOverlay = (): void => overlay?.classList.add('active');
  const hideOverlay = (): void => overlay?.classList.remove('active');

  window.addEventListener('dragenter', (e) => {
    if (!dataTransferHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    depth += 1;
    showOverlay();
  });

  window.addEventListener('dragover', (e) => {
    if (!dataTransferHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });

  window.addEventListener('dragleave', (e) => {
    if (!dataTransferHasFiles(e.dataTransfer)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) hideOverlay();
  });

  window.addEventListener('drop', async (e) => {
    if (!dataTransferHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    depth = 0;
    hideOverlay();
    const file = pickImageFromDataTransfer(e.dataTransfer);
    if (!file) {
      status.textContent = 'error: drop a GIF, PNG, or JPEG file';
      return;
    }
    await loadFile(file);
  });
}
