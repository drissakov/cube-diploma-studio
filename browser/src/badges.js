import {
  PDFDocument, PDFName, PDFOperator, PDFOperatorNames, PrintScaling, clip, closePath,
  concatTransformationMatrix as matrix, drawObject, endPath, fill, lineTo, moveTo,
  popGraphicsState, pushGraphicsState, rectangle, rgb, setFillingRgbColor,
} from 'pdf-lib';
import QRCode from 'qrcode';
import { assetBytes, createFonts, pdfColor } from './fonts.js';
import { badgeLayout, positions } from './packing.js';
export { layoutInfo } from './packing.js';

const pointsPerMm = 72 / 25.4;
const roleColors = {
  COMPETITOR: '#00863D', DELEGATE: '#B53136', ORGANIZER: '#204E9E',
  GUEST: '#704888', VOLUNTEER: '#A35312',
};
function text(value) {
  if (typeof value !== 'string' || value.length > 500) throw new Error('Введите текст длиной до 500 символов.');
  return value.trim().replace(/\s+/gu, ' ').normalize('NFC');
}

function badgeLink(value = '') {
  if (typeof value !== 'string') throw new Error('Введите ссылку для QR-кода.');
  let url = value.trim();
  if (!url) return '';
  if (/[\s\u0000-\u001F]/u.test(url)) throw new Error('Уберите пробелы и переносы строк из ссылки.');
  try {
    if (!url.includes('://')) {
      const bare = url.replace(/^\/\//, '');
      if (bare.split(/[/?#]/, 1)[0].includes('@')) throw new Error();
      url = 'https://' + bare;
    }
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) throw new Error();
  } catch {
    throw new Error('Укажите веб-ссылку, например https://example.org.');
  }
  // Preserve the exact Unicode spelling and query string in the QR payload.
  return url;
}

function qrForm(doc, url) {
  if (!url) return null;
  let code;
  try {
    code = QRCode.create([{ data: new TextEncoder().encode(url), mode: 'byte' }], { errorCorrectionLevel: 'M' });
  } catch {
    throw new Error('Ссылка слишком длинная для QR-кода. Вставьте более короткую ссылку.');
  }
  const n = code.modules.size, total = n + 8;
  const ops = ['1 g', `0 0 ${total} ${total} re f`, '0 g'];
  for (let y = 0; y < n; y++) {
    let start = -1;
    for (let x = 0; x <= n; x++) {
      const dark = x < n && code.modules.get(y, x);
      if (dark && start < 0) start = x;
      else if (!dark && start >= 0) {
        ops.push(`${start + 4} ${4 + n - 1 - y} ${x - start} 1 re`);
        start = -1;
      }
    }
  }
  ops.push('f');
  // Shared vector form including a four-module quiet zone: no bitmap resampling at print time.
  const stream = doc.context.flateStream(ops.join('\n'), {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, total, total], Resources: {},
  });
  return { ref: doc.context.register(stream), total };
}

function components(hex) {
  return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
}

function makeShading(doc, w, h) {
  return doc.context.register(doc.context.obj({
    ShadingType: 2, ColorSpace: 'DeviceRGB', Coords: [0, 0, w, h], Extend: [true, true],
    Function: { FunctionType: 2, Domain: [0, 1], C0: components('#E5F4F6'), C1: components('#FCFCFC'), N: 1 },
  }));
}

function ribbon(page, x, y, width, height, slant, color) {
  page.pushOperators(pushGraphicsState(), setFillingRgbColor(...components(color)),
    moveTo(x, y), lineTo(x + width - slant, y), lineTo(x + width, y + height),
    lineTo(x, y + height), closePath(), fill(), popGraphicsState());
}

function nameBlock(page, fonts, name, x, bottom, width, height, maxSize) {
  const space = fonts.measure(' ', 'BadgeName', 1);
  const groups = name.replace(/ \(/g, '\n(').split('\n').map(group =>
    group.split(' ').filter(Boolean).map(word => ({ word, advance: fonts.measure(word, 'BadgeName', 1) })));
  function wrap(size) {
    const lines = [];
    for (const group of groups) {
      let words = [], length = 0;
      for (const { word, advance } of group) {
        if (advance * size > width) return [];
        if (words.length && (length + space + advance) * size > width) {
          lines.push(words.join(' '));
          words = [];
          length = 0;
        }
        length += (words.length ? space : 0) + advance;
        words.push(word);
      }
      if (words.length) lines.push(words.join(' '));
    }
    return lines;
  }
  const usedHeight = (count, size) => (1.04 + 0.99 * (count - 1)) * size;
  let lo = 0, hi = maxSize;
  for (let step = 0; step < 16; step++) {
    const mid = (lo + hi) / 2;
    const lines = wrap(mid);
    if (lines.length && usedHeight(lines.length, mid) <= height) lo = mid;
    else hi = mid;
  }
  const lines = wrap(lo);
  let baseline = bottom + (height + usedHeight(lines.length, lo)) / 2 - 0.82 * lo;
  for (const value of lines) {
    fonts.drawLine(page, value, x, baseline, width, lo, { style: 'BadgeName', color: '#0D429A' });
    baseline -= 0.99 * lo;
  }
}

function drawBadge(page, resources, person) {
  const { fonts, w, h, logo, cubes, title, date, qr, qrKey } = resources;
  const landscape = w > h;
  page.pushOperators(rectangle(0, 0, w, h), clip(), endPath(),
    PDFOperator.of(PDFOperatorNames.ShadingFill, [PDFName.of('BadgeBackground')]));
  const cubesW = Math.min(w, h * 0.83);
  page.drawImage(cubes, { x: w - cubesW, y: 0, width: cubesW, height: cubesW * 546 / 1086 });
  const left = w * (landscape ? 0.06 : 0.09);
  const logoW = Math.min(w * 0.146, h * (landscape ? 0.177 : 0.135));
  const logoX = landscape ? left : left + w * 0.012, logoY = h * 0.952 - logoW;
  page.drawImage(logo, { x: logoX, y: logoY, width: logoW, height: logoW });
  const separatorX = logoX + logoW * 1.17;
  page.drawLine({ start: { x: separatorX, y: logoY }, end: { x: separatorX, y: logoY + logoW * 0.94 },
    color: pdfColor('#282935'), thickness: logoW * 0.018 });
  const titleX = separatorX + logoW * 0.20, titleWidth = w - titleX - left * 0.7;
  fonts.drawLine(page, title, titleX, logoY + logoW * 0.45, titleWidth, logoW * 0.49,
    { style: 'Title', color: '#24232A' });
  const dateH = logoW * 0.32;
  const dateW = Math.min(titleWidth, Math.max(logoW * 2.32, fonts.measure(date, 'Body', dateH * 0.87) + dateH));
  ribbon(page, titleX, logoY, dateW, dateH, Math.min(dateW * 0.11, dateH * 0.68), '#E52522');
  fonts.drawLine(page, date, titleX + dateW * 0.47, logoY + dateH * 0.22, dateW * 0.82, dateH * 0.86,
    { center: true, color: '#FFFFFF' });
  const bandH = Math.min(h * (landscape ? 0.102 : 0.077), w * 0.12);
  const bandBottom = h * (landscape ? 0.315 : 0.464);
  const upper = Math.min(logoY - h * 0.02, h * (landscape ? 0.75 : 0.80));
  const lower = bandBottom + bandH + h * (landscape ? 0.02 : 0.025);
  nameBlock(page, fonts, person.name, left, lower, w - left * 1.8, upper - lower,
    Math.min(h * (landscape ? 0.169 : 0.12), w * 0.175));
  const labelSize = bandH * 0.70;
  const bandW = Math.min(w - 1.6 * left, Math.max(w * (landscape ? 0.34 : 0.596),
    fonts.measure(person.role, 'BadgeName', labelSize) + bandH * 1.28));
  const slant = Math.min(bandH * 0.61, bandW * 0.15);
  ribbon(page, left, bandBottom, bandW, bandH, slant, roleColors[person.role]);
  fonts.drawLine(page, person.role, left + (bandW - slant * 0.55) / 2, bandBottom + bandH * 0.25,
    bandW - slant - bandH * 0.33, labelSize, { style: 'BadgeName', color: '#FFFFFF', center: true });
  if (qr) {
    const x = w * (landscape ? 0.059 : 0.078), y = h * (landscape ? 0.035 : 0.253);
    const target = Math.min(w * 0.228, h * (landscape ? 0.247 : 0.182));
    const maximum = Math.min(w * 0.39, bandBottom - y - h * 0.012);
    const scale = Math.min(maximum, Math.max(target, qr.total * 0.35 * pointsPerMm)) / qr.total;
    page.pushOperators(pushGraphicsState(), matrix(scale, 0, 0, scale, x, y), drawObject(qrKey), popGraphicsState());
  }
}

export async function badgesPdf(state, preview = false) {
  const title = text(state.title ?? ''), date = text(state.date ?? '');
  if (!title || !date) throw new Error('Укажите название и дату соревнований.');
  const layout = badgeLayout(state);
  const source = state.badgePeople ?? [];
  if (!Array.isArray(source)) throw new Error('Проверьте список людей для бейджей.');
  const people = source.map(person => {
    const name = text(person?.name ?? ''), role = person?.role ?? 'COMPETITOR';
    if (!Object.hasOwn(roleColors, role)) throw new Error('Выберите один из пяти статусов для каждого человека.');
    if (!name && !preview) throw new Error('В списке бейджей есть пустое имя. Заполните или удалите строку.');
    return { name: name || 'Имя Фамилия', role };
  });
  if (!people.length) {
    if (!preview) throw new Error('Добавьте человека вручную или загрузите CSV для бейджей.');
    people.push({ name: 'Имя Фамилия', role: 'COMPETITOR' });
  }
  const pageCount = Math.ceil(people.length / layout.count);
  const first = preview ? (state.page ?? 0) : 0;
  if (!Number.isInteger(first) || first < 0 || first >= pageCount) throw new Error('Лист отсутствует.');
  const last = preview ? first + 1 : pageCount;
  const doc = await PDFDocument.create();
  const qr = qrForm(doc, badgeLink(state.badgeUrl));
  doc.setTitle(title);
  doc.catalog.getOrCreateViewerPreferences().setPrintScaling(PrintScaling.None);
  const visible = people.slice(first * layout.count, last * layout.count);
  const [fonts, logo, cubes] = await Promise.all([
    createFonts(doc, [title, date, ...visible.flatMap(p => [p.name, p.role])]),
    assetBytes('/assets/badge-logo.png').then(data => doc.embedPng(data)),
    assetBytes('/assets/badge-cubes.png').then(data => doc.embedPng(data)),
  ]);
  const point = pointsPerMm / 100;
  const w = layout.width * point, h = layout.height * point;
  const shading = makeShading(doc, w, h);
  for (let sheet = first; sheet < last; sheet++) {
    const page = doc.addPage([layout.pageWidth * point, layout.pageHeight * point]);
    page.node.Resources().set(PDFName.of('Shading'), doc.context.obj({ BadgeBackground: shading }));
    const qrKey = qr && page.node.newXObject('BadgeQR', qr.ref);
    const group = people.slice(sheet * layout.count, (sheet + 1) * layout.count);
    const guides = [];
    positions(layout, group.length).forEach((box, index) => {
      const x = box.x * point, dx = box.width * point, dy = box.height * point;
      const yBottom = (layout.pageHeight - box.y) * point - dy;
      const transform = box.turned ? matrix(0, -1, 1, 0, x, yBottom + dy) : matrix(1, 0, 0, 1, x, yBottom);
      page.pushOperators(pushGraphicsState(), transform);
      drawBadge(page, { fonts, logo, cubes, title, date, qr, qrKey, w, h }, group[index]);
      page.pushOperators(popGraphicsState());
      guides.push({ x, y: yBottom, width: dx, height: dy });
    });
    for (const guide of guides) page.drawRectangle({ ...guide, borderColor: rgb(0.61, 0.65, 0.67), borderWidth: 0.22 });
  }
  return doc.save();
}
