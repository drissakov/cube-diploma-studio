import Papa from 'papaparse';

const nameHeaders = [
  'name', 'full name', 'competitor name', 'competitor', 'participant name',
  'participant', 'фио', 'ф.и.о.', 'фамилия имя отчество', 'имя фамилия',
  'фамилия имя', 'полное имя', 'имя участника', 'участник', 'имя', 'аты-жөні'
];

function decode(bytes) {
  const [first, second] = bytes;
  const encodings = first === 0xff && second === 0xfe ? ['utf-16le']
    : first === 0xfe && second === 0xff ? ['utf-16be']
    : ['utf-8', 'windows-1251'];
  for (const encoding of encodings) {
    try {
      const text = new TextDecoder(encoding, {fatal: true}).decode(bytes);
      if (!text.includes('\0')) return text;
    } catch { /* Try the next supported encoding. */ }
  }
  throw new Error('Не удалось прочитать текст. Сохраните файл как CSV в кодировке UTF-8.');
}

function delimiterFromHeader(line) {
  // Counts separators only outside quotes, including a quoted delimiter in a title.
  const counts = new Map([[',', 0], [';', 0], ['\t', 0]]);
  let quoted = false;
  for (const char of line) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && counts.has(char)) counts.set(char, counts.get(char) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0][0];
}

function columnLabels(header) {
  const seen = new Set();
  return header.map((cell, i) => {
    const base = cell.trim() || 'Столбец ' + (i + 1);
    let name = base;
    let suffix = 2;
    while (seen.has(name)) name = base + ' (' + suffix++ + ')';
    seen.add(name);
    return name;
  });
}

export function registrationCsv(bytes, requestedColumn) {
  let text = decode(bytes).replace(/^[\r\n]+/, '');
  if (!text.trim()) throw new Error('CSV-файл пуст.');
  const directive = /^sep=([,;\t])(?:\r\n|\n|\r)/i.exec(text);
  const delimiter = directive ? directive[1] : delimiterFromHeader(text.split(/[\r\n]/, 1)[0]);
  if (directive) text = text.slice(directive[0].length);
  const parsed = Papa.parse(text, {delimiter, skipEmptyLines: false});
  if (parsed.errors.length) {
    const row = (parsed.errors[0].row ?? 0) + 1;
    throw new Error('Ошибка CSV около строки ' + row + '. Проверьте разделители и кавычки.');
  }
  if (!parsed.data.length) throw new Error('В CSV-файле отсутствуют заголовки столбцов.');
  const columns = columnLabels(parsed.data[0]);
  if (requestedColumn && !columns.includes(requestedColumn)) {
    throw new Error('Выбранного столбца нет в CSV-файле.');
  }
  const normalized = new Map(columns.map(label => [label.toLowerCase(), label]));
  const column = requestedColumn || (columns.length === 1 ? columns[0] :
    normalized.get(nameHeaders.find(key => normalized.has(key)))) || '';
  const result = {columns, column, names: [], skipped: 0};
  if (!column) return result;
  const index = columns.indexOf(column);
  for (let i = 1; i < parsed.data.length; i++) {
    const row = parsed.data[i];
    if (!row.some(cell => cell.trim())) continue;
    if (row.length !== columns.length) {
      throw new Error('В записи ' + (i + 1) + ' число полей отличается от заголовка. Проверьте разделители и кавычки.');
    }
    const name = row[index].trim().replace(/\s+/gu, ' ').normalize('NFC');
    if (name) result.names.push(name);
    else result.skipped++;
  }
  return result;
}
