import fontkit from '@pdf-lib/fontkit';
import { rgb } from 'pdf-lib';

const resources = new Map();

/** Cache read-only application assets, never the user's personal files. */
export function assetBytes(path) {
  if (!resources.has(path)) {
    const loading = fetch(path).then(async (response) => {
      if (!response.ok) throw new Error('Не удалось загрузить файл шаблона. Обновите страницу.');
      return new Uint8Array(await response.arrayBuffer());
    }).catch((error) => {
      resources.delete(path);
      throw error;
    });
    resources.set(path, loading);
  }
  return resources.get(path);
}

export function pdfColor(hex) {
  const value = Number.parseInt(hex.replace('#', ''), 16);
  return rgb(((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255);
}

const baseFiles = { Body: 'body', Title: 'title', BadgeName: 'badge' };
const extraFiles = [
  ['korean', /[\p{Script=Hangul}]/u],
  ['cjk', /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303f\uff00-\uffef]/u],
  ['arabic', /\p{Script=Arabic}/u],
  ['hebrew', /\p{Script=Hebrew}/u],
  ['devanagari', /\p{Script=Devanagari}/u],
  ['thai', /\p{Script=Thai}/u],
];

/** Resolve glyph fallback once per document. All drawing uses PDF points. */
export async function createFonts(doc, texts) {
  doc.registerFontkit(fontkit);
  const contents = Array.isArray(texts) ? texts.join(' ') : String(texts ?? '');
  const files = [
    ...Object.entries(baseFiles),
    ...extraFiles.filter(([, script]) => script.test(contents)).map(([name]) => [name, name]),
  ];
  const faces = new Map(await Promise.all(files.map(async ([style, file]) => {
    const bytes = await assetBytes('/fonts/' + file + '.ttf');
    // Keep the original glyph indices, including composite letters in Kazakh
    // and Korean. Some viewers drop outlines from dynamically rebuilt subsets.
    const font = await doc.embedFont(bytes, {
      subset: false, customName: 'CubeStudio-' + file,
      // Keep names such as Tiffany selectable as their actual letters.
      // Decorative Latin ligatures in these fonts may have no Unicode entry.
      features: { liga: false, clig: false, dlig: false, calt: false },
    });
    return [style, { font, glyphs: new Set(font.getCharacterSet()) }];
  })));
  const plans = new Map();
  function runs(text, style) {
    const key = style + '\n' + text;
    if (plans.has(key)) return plans.get(key);
    const preferred = faces.get(style) || faces.get('Body');
    const list = [];
    for (const symbol of text) {
      const cp = symbol.codePointAt(0);
      let face = preferred;
      if (!face.glyphs.has(cp)) {
        face = [...faces.values()].find((candidate) => candidate.glyphs.has(cp));
        if (!face) throw new Error('В печатных шрифтах нет символа ' + symbol + ' (U+' + cp.toString(16).toUpperCase() + ').');
      }
      const last = list[list.length - 1];
      if (last && last.font === face.font) last.text += symbol;
      else list.push({ font: face.font, text: symbol });
    }
    for (const part of list) part.unitWidth = part.font.widthOfTextAtSize(part.text, 1);
    plans.set(key, list);
    return list;
  }
  function measure(text, style, size) {
    return runs(text, style).reduce((total, part) => total + part.unitWidth * size, 0);
  }
  function drawLine(page, text, x, y, maxWidth, size, { style = 'Body', color = '#231F20', center = false } = {}) {
    if (!text || size <= 0 || maxWidth <= 0) return;
    const width = measure(text, style, size);
    const fitted = size * Math.min(1, maxWidth / (width || 1));
    let left = x - (center ? measure(text, style, fitted) / 2 : 0);
    const ink = typeof color === 'string' ? pdfColor(color) : color;
    for (const part of runs(text, style)) {
      page.drawText(part.text, { x: left, y, size: fitted, font: part.font, color: ink });
      left += part.unitWidth * fitted;
    }
  }
  return { measure, drawLine };
}
