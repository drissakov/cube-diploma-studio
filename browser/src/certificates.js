import { PDFDocument } from 'pdf-lib';
import { events } from './catalog.js';
import { assetBytes, createFonts, pdfColor } from './fonts.js';

const ink = '#231F20';
const greens = ['#009B53', '#3EA94F', '#00A258'];
const ordinals = [['1st', '#8A6511'], ['2nd', '#526474'], ['3rd', '#93532C']];
const eventNames = new Map(events.map((event) => [event.id, event.name]));
const clean = (value) => String(value ?? '').normalize('NFC').trim().replace(/\s+/gu, ' ');
const span = (text, color = ink) => ({ text, color });

function pagesFor(state, preview) {
  let pages;
  if (state.mode === 'participation') {
    pages = (state.names || []).map((name) => ({ name: clean(name) }));
    if (!pages.length && preview) pages.push({ name: '' });
    if (!pages.length) throw new Error('Загрузите CSV со списком участников.');
    if (!preview && pages.some((page) => !page.name)) throw new Error('В списке есть пустое имя участника.');
  } else if (state.mode === 'awards') {
    const ids = [...new Set(state.events || [])];
    if (!ids.length && preview) ids.push('333');
    if (!ids.length) throw new Error('Выберите хотя бы одну дисциплину.');
    pages = ids.flatMap((id) => {
      if (!eventNames.has(id)) throw new Error('Проверьте выбранные дисциплины.');
      return ordinals.map(([ordinal, color], index) => ({
        name: clean(state.winners?.[id]?.[index]), result: clean(state.results?.[id]?.[index]),
        event: eventNames.get(id), ordinal, color
      }));
    });
  } else throw new Error('Выберите тип документа.');
  if (!preview) return pages;
  const current = pages[state.page ?? 0];
  if (!current) throw new Error('Страница отсутствует.');
  return [current];
}

function nameList(group) {
  return group.flatMap((person, index) => [
    ...(index ? [span(index === group.length - 1 ? ' and ' : ', ')] : []),
    span(person.name, person.color)
  ]);
}

function introLines(title, organizers) {
  const delegates = organizers.filter((entry) => entry.role === 'wca');
  const team = organizers.filter((entry) => entry.role === 'organizer');
  const verb = organizers.length < 2 ? 'certifies that:' : 'certify that:';
  if (!organizers.length) return [[span('The organizing team of ' + title + ' ' + verb)]];
  if (delegates.length && team.length) return [
    [...nameList(delegates), span(' on behalf of WCA, and '), ...nameList(team), span(',')],
    [span('on behalf of the organizing team of ' + title + ',')], [span(verb)]
  ];
  const organization = delegates.length ? 'WCA at ' : 'the organizing team of ';
  return [[...nameList(organizers), span(', on behalf of ' + organization + title + ', ' + verb)]];
}

// Keep differently colored fragments in the same word (e.g. a green name and its comma).
function splitWords(parts) {
  const words = [];
  let word = [];
  for (const { text, color } of parts) {
    for (const token of text.split(/(\s+)/u)) {
      if (!token) continue;
      if (/^\s/u.test(token)) {
        if (word.length) words.push(word);
        word = [];
      } else word.push(span(token, color));
    }
  }
  if (word.length) words.push(word);
  return words;
}

function composeParagraph(fonts, paragraphs, width, maxHeight, size, lineSpacing) {
  const words = paragraphs.map(splitWords);
  const space = fonts.measure(' ', 'Body', 1);
  const partWidth = (part) => fonts.measure(part.text, 'Body', 1);
  for (let point = size; point >= 7; point -= 0.5) {
    const limit = width / point;
    const lines = [];
    for (const row of words) {
      let line = [], used = 0;
      function finish() {
        if (line.length) lines.push(line);
        line = [];
        used = 0;
      }
      function append(part, advance) {
        const previous = line[line.length - 1];
        if (previous && previous.color === part.color) previous.text += part.text;
        else line.push({ ...part });
        used += advance;
      }
      for (const word of row) {
        const wordWidth = word.reduce((sum, part) => sum + partWidth(part), 0);
        if (line.length && used + space + wordWidth > limit) finish();
        if (line.length) append(span(' ', line[line.length - 1].color), space);
        for (const part of word) {
          if (wordWidth <= limit) append(part, partWidth(part));
          else {
            // Long unbroken event titles still have a line break at the right edge.
            for (const char of part.text) {
              const letter = span(char, part.color), advance = partWidth(letter);
              if (line.length && used + advance > limit) finish();
              append(letter, advance);
            }
          }
        }
      }
      finish();
    }
    if (lines.length * point * lineSpacing <= maxHeight) return { lines, size: point, leading: point * lineSpacing };
  }
  throw new Error('Текст слишком длинный для шаблона. Сократите название или имена организаторов.');
}

function paragraph(page, fonts, plan, x, top) {
  let baseline = top - plan.size;
  for (const line of plan.lines) {
    let left = x;
    for (const piece of line) {
      fonts.drawLine(page, piece.text, left, baseline, Infinity, plan.size, { color: piece.color });
      left += fonts.measure(piece.text, 'Body', plan.size);
    }
    baseline -= plan.leading;
  }
}

function canvasOf(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

async function signatureImage(doc, input) {
  const raw = input.startsWith('data:') ? input.slice(input.indexOf(',') + 1) : input;
  const bytes = Uint8Array.from(atob(raw), (char) => char.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: bytes[0] === 0xff ? 'image/jpeg' : 'image/png' }));
  const scale = Math.min(1, 1000 / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = canvasOf(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  try { ctx.drawImage(bitmap, 0, 0, width, height); } finally { bitmap.close(); }
  const pixels = ctx.getImageData(0, 0, width, height);
  let left = width, right = -1, top = height, bottom = -1;
  const data = pixels.data;
  for (let p = 0; p < width * height; p++) {
    const i = 4 * p;
    if (Math.min(data[i], data[i + 1], data[i + 2]) >= 248) data[i + 3] = 0;
    if (data[i + 3]) {
      const x = p % width, y = Math.floor(p / width);
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
  }
  if (right < left) throw new Error('Изображение подписи пустое. Выберите подпись с видимыми штрихами.');
  const crop = canvasOf(right - left + 1, bottom - top + 1);
  crop.getContext('2d').putImageData(pixels, -left, -top);
  const blob = crop.convertToBlob ? await crop.convertToBlob({ type: 'image/png' }) :
    await new Promise((resolve) => crop.toBlob(resolve, 'image/png'));
  return doc.embedPng(await blob.arrayBuffer());
}

function dateRibbon(page, fonts, date, height, podium) {
  const width = Math.min(335, Math.max(95, fonts.measure(date, 'Body', 10.5) + 19));
  const x = 111.9, y = height - 57.8;
  page.drawSvgPath('M0 0 L' + width + ' 0 L' + width + ' 10.5 L' + (width - 3) + ' 13.6 L0 13.6 Z', {
    x, y, color: pdfColor(podium ? '#EB3B37' : '#EF2925')
  });
  fonts.drawLine(page, date, x + width / 2, y - 9.8, width - 9, 10.5, { color: '#FFFFFF', center: true });
}

export async function certificatePdf(state, preview = false) {
  const title = clean(state.title) || (preview ? 'Competition' : '');
  const date = clean(state.date) || (preview ? '—' : '');
  if (!title || !date) throw new Error('Укажите название и дату соревнования.');
  if ((state.organizers || []).length > 5) throw new Error('В шаблоне помещается до пяти организаторов.');
  const organizers = [];
  for (const entry of state.organizers || []) {
    const name = clean(entry.name);
    if (name) organizers.push({ ...entry, name, color: greens[organizers.length % greens.length] });
    else if (entry.signature && !preview) throw new Error('Укажите имя организатора для загруженной подписи.');
  }
  const pages = pagesFor(state, preview);
  const podium = state.mode === 'awards';
  const kind = podium ? 'podium' : 'participation';
  const contents = [title, date, ...organizers.map((p) => p.name), ...pages.flatMap((p) => [p.name, p.event || '', p.result || ''])];
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setCreator('CubeDiploma Studio');
  const [fonts, [background]] = await Promise.all([
    createFonts(doc, contents),
    assetBytes('/assets/' + kind + '.pdf').then((data) => doc.embedPdf(data, [0])),
    Promise.all(organizers.map(async (p) => { if (p.signature) p.image = await signatureImage(doc, p.signature); }))
  ]);
  const intro = composeParagraph(fonts, introLines(title, organizers), 732, 82, 23, 1.18);
  const height = background.height;
  for (const recipe of pages) {
    const page = doc.addPage([background.width, height]);
    page.drawPage(background);
    fonts.drawLine(page, title, 111.5, height - 47.6, 672, 24.5, { style: 'Title' });
    dateRibbon(page, fonts, date, height, podium);
    paragraph(page, fonts, intro, 48.7, height - 185.1);
    organizers.forEach((p, i) => {
      const baseline = organizers.length <= 3 ? 451 + i * 40.8 : 435 + 105 * i / (organizers.length - 1);
      fonts.drawLine(page, p.name, 158, height - baseline, 158, 17, { color: p.color });
      if (p.image) {
        const fitted = p.image.scaleToFit(96, organizers.length <= 3 ? 32 : 22);
        page.drawImage(p.image, {
          x: 96 - fitted.width / 2, y: height - baseline + 5 - fitted.height / 2, ...fitted
        });
      }
    });
    fonts.drawLine(page, recipe.name, 410, height - (podium ? 302 : 315), 700, 31, { center: true });
    if (podium) {
      const line = [[span('has placed '), span(recipe.ordinal, recipe.color),
        span(' in ' + recipe.event + ' with the result of')]];
      paragraph(page, fonts, composeParagraph(fonts, line, 718, 44, 21, 1.11), 48.6, height - 318);
      fonts.drawLine(page, recipe.result, 292, height - 389.5, 467, 27, { center: true });
    }
  }
  return doc.save();
}
