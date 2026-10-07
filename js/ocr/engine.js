// OCR service layer. The rest of the app only knows this interface, so the
// engine can be swapped (Tesseract, PaddleOCR, a native plugin, a cloud API)
// without touching the scanner.
//
//   interface OcrEngine {
//     name: string
//     init(): Promise<void>
//     recognize(canvas, { mode: 'line' | 'sparse' }):
//        Promise<{ symbols: {ch, conf, bbox:{x0,y0,x1,y1}}[], ms: number }>
//     terminate(): Promise<void>
//   }
//
// Engines return loose symbols in canvas pixel coordinates; grouping symbols
// into text lines is done here so every engine gets the same treatment.

const engines = new Map();
export function registerEngine(name, factory) { engines.set(name, factory); }
export function createEngine(name, options) {
  const f = engines.get(name);
  if (!f) throw new Error(`Unknown OCR engine: ${name}`);
  return f(options);
}
export function engineNames() { return [...engines.keys()]; }

/**
 * Group symbols into lines by geometry. Stencilled ULD numbers have wide
 * letter-spacing, which OCR engines often report as many separate "words";
 * this joins anything that sits on the same baseline at a similar size.
 */
export function groupLines(symbols) {
  const syms = symbols.filter((s) => s.bbox && s.ch && s.ch.trim()).sort((a, b) => a.bbox.x0 - b.bbox.x0);
  const lines = [];
  for (const s of syms) {
    const h = s.bbox.y1 - s.bbox.y0;
    let target = null, bestGap = Infinity;
    for (const line of lines) {
      const last = line.chars[line.chars.length - 1].bbox;
      const lh = line.height;
      const overlap = Math.min(last.y1, s.bbox.y1) - Math.max(last.y0, s.bbox.y0);
      const gap = s.bbox.x0 - last.x1;
      const similar = h > lh * 0.45 && h < lh * 2.2;
      if (overlap > 0.4 * Math.min(h, lh) && similar && gap < 2.2 * Math.max(h, lh) && gap < bestGap) {
        target = line; bestGap = gap;
      }
    }
    if (target) {
      target.chars.push(s);
      target.height = (target.height * (target.chars.length - 1) + h) / target.chars.length;
    } else {
      lines.push({ chars: [s], height: h });
    }
  }
  return lines;
}
