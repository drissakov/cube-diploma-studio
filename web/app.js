'use strict';

const $ = (id) => document.getElementById(id);
const eventMap = new Map();
const svgNS = 'http://www.w3.org/2000/svg';
let state;
let ready = false;
let exporting = false;
function csvSession(namesKey, filenameKey, columnKey) {
  return {namesKey, filenameKey, columnKey, source: null, version: 0, importing: false, needsReview: false, notice: ''};
}
const registrationCsv = csvSession('names', 'csvFilename', 'csvColumn');
const volunteerCsv = csvSession('volunteerNames', 'volunteerCsvFilename', 'volunteerCsvColumn');
const pendingSignatures = new Map();
let previewVersion = 0;
let previewTimer;
let previewRequest;
let previewUrl = '';
let draftVersion = 0;
let savedVersion = 0;
let draftTimer;
let saving = false;

function make(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function icon(name) {
  const svg = document.createElementNS(svgNS, 'svg');
  const use = document.createElementNS(svgNS, 'use');
  use.setAttribute('href', '#i-' + name);
  svg.setAttribute('class', 'ico');
  svg.setAttribute('aria-hidden', 'true');
  svg.append(use);
  return svg;
}

function button(text, cls, onClick, iconName) {
  const node = make('button', cls);
  node.type = 'button';
  if (iconName) node.append(icon(iconName));
  if (text) node.append(document.createTextNode(text));
  node.addEventListener('click', onClick);
  return node;
}

function smallButton(label, iconName, onClick) {
  const node = button('', 'icon-button', onClick, iconName);
  node.title = label;
  node.setAttribute('aria-label', label);
  return node;
}

function plural(number, one, few, many) {
  const tens = number % 100;
  if (tens >= 11 && tens <= 14) return many;
  if (number % 10 === 1) return one;
  return number % 10 >= 2 && number % 10 <= 4 ? few : many;
}

function setError(message = '') {
  $('global-error').hidden = !message;
  $('global-error').textContent = message;
}

async function api(path, body, options = {}) {
  if (window.cubeStudioBrowser) return window.cubeStudioBrowser.api(path, body, options);
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : {'Content-Type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store', ...options
  });
  if (!response.ok) {
    let detail;
    try { detail = (await response.json()).error; } catch { /* e.g. an interrupted local server */ }
    throw new Error(detail || 'Сервер не выполнил запрос (' + response.status + ').');
  }
  return response;
}

function stateFrom(initial, draft) {
  const merged = Object.assign({}, initial || {}, draft || {});
  const names = Array.isArray(merged.names) ? merged.names.map(String) : [];
  return {
    mode: ['awards', 'badges', 'volunteers'].includes(merged.mode) ? merged.mode : 'participation',
    title: String(merged.title ?? ''),
    date: String(merged.date ?? ''),
    organizers: (Array.isArray(merged.organizers) ? merged.organizers : []).slice(0, 5).map((o) => ({
      name: String(o.name ?? ''), role: o.role === 'wca' ? 'wca' : 'organizer', signature: o.signature || ''
    })),
    names,
    volunteerNames: Array.isArray(merged.volunteerNames) ? merged.volunteerNames.map(String) : [],
    volunteerCsvFilename: String(merged.volunteerCsvFilename ?? ''),
    volunteerCsvColumn: String(merged.volunteerCsvColumn ?? ''),
    ...badgeState(merged, names),
    events: Array.from(eventMap.keys()).filter((id) => Array.isArray(merged.events) && merged.events.includes(id)),
    winners: merged.winners || {}, results: merged.results || {},
    page: Math.max(0, Number(merged.page) || 0),
    csvFilename: String(merged.csvFilename ?? ''), csvColumn: String(merged.csvColumn ?? '')
  };
}

function activeCsv() {
  return state.mode === 'volunteers' ? volunteerCsv : registrationCsv;
}

function updateRoster(csv, names, preserveImportedEdits = true) {
  if (csv === volunteerCsv) state.volunteerNames = names;
  else replaceRegistrationNames(names, preserveImportedEdits);
}

function pageCount() {
  if (state.mode === 'badges') return badgeCapacity ? Math.ceil(state.badgePeople.length / badgeCapacity) : 0;
  return state.mode === 'awards' ? state.events.length * 3 : state[activeCsv().namesKey].length;
}

function documentPayload() {
  if (state.mode === 'volunteers') return {mode: state.mode, title: state.title, date: state.date,
    organizers: state.organizers, names: state.volunteerNames, page: state.page};
  if (state.mode !== 'badges') return state;
  const data = {mode: state.mode, title: state.title, date: state.date, page: state.page,
    badgeUrl: state.badgeUrl, badgePeople: state.badgePeople.map(({name, role}) => ({name, role}))};
  for (const [key] of badgeMeasures) data[key] = state[key];
  return data;
}

function markSaved(message, check = false) {
  $('save-status').replaceChildren(...(check ? [icon('check')] : []), document.createTextNode(message));
}

async function saveDraft() {
  clearTimeout(draftTimer);
  if (!ready || saving || savedVersion === draftVersion) return;
  saving = true;
  const version = draftVersion;
  try {
    await api('/api/draft', state);
    savedVersion = version;
    if (savedVersion === draftVersion) markSaved('Настройки сохранены', true);
  } catch (error) {
    markSaved('Не удалось сохранить настройки. ' + error.message);
    draftTimer = setTimeout(saveDraft, 6000);
  } finally {
    saving = false;
    if (version !== draftVersion) void saveDraft();
  }
}

function changed({preview = true} = {}) {
  if (!ready) return;
  draftVersion++;
  markSaved('Сохраняем настройки…');
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraft, 350);
  renderPageInfo();
  if (preview) requestPreview();
}

function renderPageInfo() {
  const badges = state.mode === 'badges';
  const total = pageCount();
  if (!badges || badgeCapacity) state.page = Math.max(0, Math.min(state.page, Math.max(0, total - 1)));
  $('page').value = String(total ? state.page + 1 : 1);
  $('page').max = String(total || 1);
  $('page').disabled = total <= 1;
  $('page-total').textContent = String(total || 1);
  $('prev').disabled = !total || state.page <= 0;
  $('next').disabled = state.page + 1 >= total;
  let context = 'Шаблон';
  let detail = 'Альбомный формат';
  if (badges) {
    const first = state.page * badgeCapacity + 1;
    const last = Math.min(first + badgeCapacity - 1, state.badgePeople.length);
    context = total ? (first === last ? 'Бейдж ' + first : 'Бейджи ' + first + '–' + last) : 'Образец бейджа';
    detail = 'A4 · печать 100%';
  } else if (total && state.mode !== 'awards') {
    context = state[activeCsv().namesKey][state.page];
    detail = state.mode === 'volunteers' ? 'Сертификат волонтёра' : 'Сертификат участника';
  } else if (total) {
    const id = state.events[Math.floor(state.page / 3)];
    const place = state.page % 3;
    context = eventMap.get(id).label + ' · ' + (place + 1) + '-е место';
    detail = state.winners[id]?.[place] || 'Диплом призёра';
  }
  $('page-context').textContent = context;
  $('page-detail').textContent = detail;
  const csv = activeCsv();
  const reviewingCsv = state.mode !== 'awards' && (csv.importing || csv.needsReview);
  $('export-count').textContent = total
    ? total + ' ' + plural(total, 'страница', 'страницы', 'страниц') + ' в одном файле'
    : ({awards: 'Выберите дисциплины', volunteers: 'Добавьте волонтёров'}[state.mode] || 'Добавьте участников');
  const emptyBadgeName = badges && state.badgePeople.some(person => !person.name.trim());
  if (badges && total) $('export-count').textContent = state.badgePeople.length + ' ' + plural(state.badgePeople.length, 'бейдж', 'бейджа', 'бейджей') + ' · ' + total + ' ' + plural(total, 'лист', 'листа', 'листов') + ' A4';
  if (badges && !badgeCapacity) $('export-count').textContent = 'Проверьте размеры бейджа';
  if (emptyBadgeName) $('export-count').textContent = 'Заполните пустое имя в списке';
  if (reviewingCsv) $('export-count').textContent = csv.importing ? 'Читаем CSV…' : 'Проверьте импорт имён';
  const readingSignature = !badges && pendingSignatures.size > 0;
  if (readingSignature) $('export-count').textContent = 'Читаем подпись…';
  $('export').disabled = !ready || exporting || reviewingCsv || readingSignature || emptyBadgeName || !total || !state.title.trim() || !state.date.trim();
}

function requestPreview() {
  clearTimeout(previewTimer);
  previewRequest?.abort();
  const version = ++previewVersion;
  $('preview-error').hidden = true;
  $('preview-progress').hidden = !previewUrl;
  if (!state.title.trim() || !state.date.trim()) {
    hidePreview('Заполните название и дату соревнования.');
    return;
  }
  if (state.mode === 'badges' && !badgeCapacity) {
    hidePreview(layoutNote || 'Рассчитываем раскладку…');
    return;
  }
  if (state.mode === 'badges' && state.badgePeople.some(person => !person.name.trim())) {
    hidePreview('Заполните пустое имя в списке или удалите эту строку.');
    return;
  }
  previewTimer = setTimeout(() => loadPreview(version), 180);
}

function hidePreview(message) {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = '';
  $('preview-progress').hidden = true;
  $('preview-img').hidden = true;
  $('preview-img').removeAttribute('src');
  $('zoom-img').removeAttribute('src');
  $('expand').disabled = true;
  $('preview-placeholder').hidden = false;
  $('preview-placeholder').textContent = message;
}

async function loadPreview(version) {
  previewRequest = new AbortController();
  try {
    const response = await api('/api/preview', documentPayload(), {signal: previewRequest.signal});
    const blob = await response.blob();
    if (version !== previewVersion) return;
    const url = URL.createObjectURL(blob);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = url;
    $('preview-img').src = $('zoom-img').src = url;
    $('preview-img').hidden = false;
    $('preview-placeholder').hidden = true;
    $('expand').disabled = false;
  } catch (error) {
    if (version !== previewVersion || error.name === 'AbortError') return;
    hidePreview('Предпросмотр недоступен');
    $('preview-error').textContent = error.message;
    $('preview-error').hidden = false;
  } finally {
    if (version === previewVersion) $('preview-progress').hidden = true;
  }
}

function renderModes() {
  const awards = state.mode === 'awards';
  const badges = state.mode === 'badges';
  const volunteers = state.mode === 'volunteers';
  document.body.classList.toggle('badges-mode', badges);
  document.querySelector('h1').textContent = badges ? 'Редактор бейджей' : 'Редактор дипломов';
  document.querySelectorAll('.mode').forEach((node) => node.setAttribute('aria-pressed', String(node.dataset.mode === state.mode)));
  $('participant-panel').hidden = awards;
  $('roster-title').textContent = volunteers ? 'Волонтёры' : 'Участники';
  $('names-dialog-title').textContent = volunteers ? 'Имена волонтёров' : 'Имена участников';
  $('use-badge-volunteers').hidden = !volunteers;
  $('event-panel').hidden = !awards;
  $('winners-panel').hidden = !awards;
  $('organizer-panel').hidden = badges;
  $('badge-print-panel').hidden = !badges;
  $('badge-roster').hidden = !badges;
  $('edit-names').hidden = badges;
  $('preview-title').textContent = {badges: 'Печатный лист A4', awards: 'Диплом призёра',
    participation: 'Сертификат участника', volunteers: 'Сертификат волонтёра'}[state.mode];
  if (badges) {
    renderBadgeRows();
    invalidateLayout();
  }
  renderParticipants();
}

function renderParticipants() {
  const csv = activeCsv();
  const count = state[csv.namesKey].length;
  const filename = csv.source?.filename || state[csv.filenameKey];
  const volunteers = csv === volunteerCsv;
  const noun = volunteers ? plural(count, 'волонтёр', 'волонтёра', 'волонтёров') : plural(count, 'участник', 'участника', 'участников');
  const namesLabel = count ? count + ' ' + noun : 'Список пуст';
  $('names-count').textContent = csv.needsReview && count ? 'Сохранено: ' + namesLabel : namesLabel;
  $('csv-title').textContent = csv.importing ? 'Читаем файл…' : (filename || 'Загрузить CSV');
  $('csv-description').textContent = filename ? 'Нажмите, чтобы выбрать другой файл' : 'Выберите файл или перетащите его сюда';
  $('edit-names').textContent = count ? 'Изменить список' : 'Ввести имена';
  $('csv-notice').hidden = !csv.notice;
  $('csv-notice').textContent = csv.notice;
  $('cancel-import').hidden = !csv.needsReview;
  if (volunteers) {
    const count = newBadgeVolunteers().length;
    const add = $('use-badge-volunteers');
    add.disabled = !count || csv.needsReview;
    add.querySelector('span').textContent = 'Добавить волонтёров из бейджей' + (count ? ' (' + count + ')' : '');
    add.title = count ? 'Добавить людей со статусом VOLUNTEER в этот список.' : 'В бейджах нет новых людей со статусом VOLUNTEER.';
  }
  const columns = csv.source?.columns || [];
  $('column-wrap').hidden = columns.length < 2;
  const chooser = $('csv-column');
  chooser.replaceChildren();
  if (columns.length) {
    chooser.add(new Option('Выберите столбец', ''));
    columns.forEach((name) => chooser.add(new Option(name, name)));
    chooser.value = csv.source.column || '';
  }
}

function newBadgeVolunteers() {
  const existing = new Map();
  for (const name of state.volunteerNames) {
    const key = name.trim().normalize();
    existing.set(key, (existing.get(key) || 0) + 1);
  }
  const additions = [];
  for (const person of state.badgePeople) {
    const name = person.name.trim();
    if (person.role !== 'VOLUNTEER' || !name) continue;
    // Two badge holders may share a name. Keep each person's certificate on repeated imports.
    const key = name.normalize();
    if (existing.get(key)) existing.set(key, existing.get(key) - 1);
    else additions.push(name);
  }
  return additions;
}

function asDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Не удалось прочитать файл.'));
    reader.readAsDataURL(file);
  });
}

async function loadCsv(file, column) {
  const csv = activeCsv();
  const version = ++csv.version;
  if (!file && !csv.source) return;
  csv.importing = true;
  csv.needsReview = true;
  csv.notice = '';
  if (file) csv.source = {filename: file.name, columns: [], column: ''};
  setError();
  renderParticipants();
  renderPageInfo();
  try {
    const source = file
      ? {file: window.cubeStudioBrowser ? file : (await asDataUrl(file)).split(',')[1], filename: file.name}
      : csv.source;
    if (version !== csv.version) return;
    csv.source = source;
    const data = await (await api('/api/import', {file: source.file, filename: source.filename, column})).json();
    if (version !== csv.version) return;
    csv.source = {...source, columns: data.columns, column: data.column};
    if (!data.column || !data.names.length) {
      csv.notice = data.column ? 'В выбранном столбце нет имён. Проверьте файл или выберите другой столбец.' : 'Выберите столбец с именами.';
      return;
    }
    const sameRoster = state[csv.filenameKey] === source.filename && state[csv.columnKey] === data.column;
    updateRoster(csv, data.names, sameRoster);
    state[csv.filenameKey] = source.filename;
    state[csv.columnKey] = data.column;
    const visible = csv === activeCsv() && state.mode !== 'awards';
    if (visible) state.page = 0;
    csv.needsReview = false;
    if (data.skipped) csv.notice = 'Пустые имена пропущены (' + data.skipped + ').';
    changed({preview: visible});
  } catch (error) {
    if (version === csv.version) csv.notice = error.message;
  } finally {
    if (version === csv.version) {
      csv.importing = false;
      renderParticipants();
      renderPageInfo();
    }
  }
}

function cancelImport() {
  const csv = activeCsv();
  csv.version++;
  csv.importing = false;
  csv.needsReview = false;
  csv.notice = '';
  csv.source = null;
  renderParticipants();
  renderPageInfo();
}

function applyEditedNames(names) {
  const csv = activeCsv();
  if (csv.needsReview) cancelImport();
  if (JSON.stringify(names) === JSON.stringify(state[csv.namesKey])) return;
  csv.source = null;
  csv.notice = '';
  updateRoster(csv, names);
  state[csv.filenameKey] = state[csv.columnKey] = '';
  state.page = 0;
  setError();
  renderParticipants();
  changed();
}

function wireDrop(target, handler) {
  target.addEventListener('dragover', (event) => {
    event.preventDefault();
    target.classList.add('dragging');
  });
  target.addEventListener('dragleave', (event) => {
    if (!target.contains(event.relatedTarget)) target.classList.remove('dragging');
  });
  target.addEventListener('drop', (event) => {
    event.preventDefault();
    target.classList.remove('dragging');
    if (event.dataTransfer.files[0]) handler(event.dataTransfer.files[0]);
  });
}

function renderEvents() {
  const list = $('event-list');
  list.replaceChildren();
  for (const [id, info] of eventMap) {
    const selected = state.events.includes(id);
    const node = button(info.label, 'event-chip', () => {
      const chosen = new Set(state.events);
      if (chosen.has(id)) chosen.delete(id);
      else chosen.add(id);
      setEvents(Array.from(eventMap.keys()).filter((key) => chosen.has(key)));
      list.querySelector('[data-event-id="' + CSS.escape(id) + '"]')?.focus({preventScroll: true});
    }, selected ? 'check' : null);
    node.dataset.eventId = id;
    node.setAttribute('aria-pressed', String(selected));
    node.title = info.name || info.label;
    list.append(node);
  }
  $('event-count').textContent = 'Выбрано ' + state.events.length + ' из ' + eventMap.size;
  $('toggle-events').textContent = state.events.length === eventMap.size ? 'Снять выбор' : 'Выбрать все';
}

function setEvents(events) {
  const previous = state.events[Math.floor(state.page / 3)];
  const place = state.page % 3;
  state.events = events;
  state.page = events.includes(previous) ? events.indexOf(previous) * 3 + place : 0;
  renderEvents();
  renderWinners();
  changed();
}

function textInput(value, placeholder, label, setter) {
  const input = document.createElement('input');
  input.type = 'text';
  input.autocomplete = 'off';
  input.value = value || '';
  input.placeholder = placeholder;
  input.setAttribute('aria-label', label);
  input.addEventListener('input', () => { setter(input.value); changed(); });
  return input;
}

function renderWinners() {
  const list = $('winner-list');
  list.replaceChildren();
  if (!state.events.length) {
    list.append(make('p', 'hint', 'Сначала выберите дисциплины.'));
    return;
  }
  for (const id of state.events) {
    const item = make('div', 'event-winners');
    const label = eventMap.get(id).label;
    item.append(make('h3', '', label));
    for (let index = 0; index < 3; index++) {
      const row = make('div', 'winner-row');
      const number = String(index + 1);
      row.append(make('span', 'rank', number));
      for (const [key, field] of [['winners','Имя'], ['results','Результат']]) {
        const fieldLabel = field + ', ' + label + ', ' + number + '-е место';
        row.append(textInput(state[key][id]?.[index], field, fieldLabel, (value) => {
          if (!Array.isArray(state[key][id])) state[key][id] = ['', '', ''];
          state[key][id][index] = value;
        }));
      }
      item.append(row);
    }
    list.append(item);
  }
}

function signatureUri(base64) {
  if (base64.startsWith('data:')) return base64;
  return 'data:' + (base64.startsWith('/9j/') ? 'image/jpeg' : 'image/png') + ';base64,' + base64;
}

async function loadSignature(file, person) {
  const token = Symbol();
  pendingSignatures.set(person, token);
  renderPageInfo();
  setError();
  try {
    if (!/\.(png|jpe?g)$/i.test(file.name) && !['image/png','image/jpeg'].includes(file.type))
      throw new Error('Выберите подпись в формате PNG или JPEG.');
    const bitmap = await createImageBitmap(file).catch(() => { throw new Error('Изображение подписи не читается. Выберите PNG или JPEG.'); });
    const scale = Math.min(1, 1100 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    if (pendingSignatures.get(person) !== token || !state.organizers.includes(person)) return;
    person.signature = canvas.toDataURL('image/png').split(',')[1];
    renderOrganizers();
    changed();
  } catch (error) {
    if (pendingSignatures.get(person) === token) setError(error.message);
  } finally {
    if (pendingSignatures.get(person) === token) pendingSignatures.delete(person);
    renderPageInfo();
  }
}

function renderOrganizers() {
  const list = $('organizers');
  list.replaceChildren();
  state.organizers.forEach((person, index) => {
    const card = make('div', 'organizer');
    const top = make('div', 'organizer-top');
    const title = 'Подписант ' + (index + 1);
    top.append(make('strong', '', title), smallButton('Удалить подписанта ' + (index + 1), 'close', () => {
      pendingSignatures.delete(person);
      state.organizers.splice(index, 1);
      renderOrganizers();
      changed();
    }));
    const fields = make('div', 'organizer-fields');
    const nameInput = textInput(person.name, 'Имя и фамилия', title + ', имя и фамилия', (name) => { person.name = name; });
    const role = make('select');
    role.setAttribute('aria-label', title + ', роль');
    role.add(new Option('Делегат WCA', 'wca'));
    role.add(new Option('Организатор соревнования', 'organizer'));
    role.value = person.role;
    role.addEventListener('change', () => { person.role = role.value; changed(); });
    fields.append(nameInput, role);
    const line = make('div', 'signature-line');
    const picker = make('input');
    picker.type = 'file';
    picker.hidden = true;
    picker.accept = '.png,.jpg,.jpeg,image/png,image/jpeg';
    picker.addEventListener('change', () => {
      if (picker.files[0]) void loadSignature(picker.files[0], person);
      picker.value = '';
    });
    const drop = button(person.signature ? 'Заменить подпись' : 'Добавить подпись', 'drop-target signature-target', () => picker.click(), person.signature ? null : 'image');
    drop.title = 'Выберите PNG или JPEG или перетащите изображение';
    if (person.signature) {
      const img = make('img');
      img.alt = '';
      img.src = signatureUri(person.signature);
      drop.prepend(img);
    }
    wireDrop(drop, (file) => void loadSignature(file, person));
    line.append(drop, picker);
    if (person.signature) line.append(smallButton('Удалить подпись', 'close', () => {
      pendingSignatures.delete(person);
      person.signature = '';
      renderOrganizers();
      changed();
    }));
    card.append(top, fields, line);
    list.append(card);
  });
  $('add-organizer').hidden = state.organizers.length >= 5;
}

async function exportPdf() {
  if ($('export').disabled) return;
  exporting = true;
  setError();
  const label = $('export').querySelector('span');
  label.textContent = 'Готовим PDF…';
  const base = state.title.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 95);
  const filename = base + {'awards':' — призёры.pdf', 'badges':' — бейджи.pdf', 'participation':' — участие.pdf', 'volunteers':' — волонтёры.pdf'}[state.mode];
  renderPageInfo();
  try {
    const response = await api('/api/export', documentPayload());
    const url = URL.createObjectURL(await response.blob());
    const link = make('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (error) {
    setError(error.message);
  } finally {
    exporting = false;
    label.textContent = 'Скачать PDF';
    renderPageInfo();
  }
}

function bindControls() {
  bindBadgeControls();
  $('title').value = state.title;
  $('date').value = state.date;
  for (const key of ['title', 'date']) $(key).addEventListener('input', () => { state[key] = $(key).value; changed(); });
  document.querySelectorAll('.mode').forEach((node) => node.addEventListener('click', () => {
    if (state.mode === node.dataset.mode) return;
    state.mode = node.dataset.mode;
    state.page = 0;
    setError();
    renderModes();
    changed();
  }));
  $('csv-drop').addEventListener('click', () => $('csv-file').click());
  $('csv-file').addEventListener('change', () => {
    if ($('csv-file').files[0]) void loadCsv($('csv-file').files[0]);
    $('csv-file').value = '';
  });
  wireDrop($('csv-drop'), (file) => void loadCsv(file));
  $('csv-column').addEventListener('change', () => { if ($('csv-column').value) void loadCsv(null, $('csv-column').value); });
  $('cancel-import').addEventListener('click', cancelImport);
  $('use-badge-volunteers').addEventListener('click', () => {
    applyEditedNames(state.volunteerNames.concat(newBadgeVolunteers()));
  });
  $('edit-names').addEventListener('click', () => {
    $('names-text').value = state[activeCsv().namesKey].join('\n');
    $('names-dialog').showModal();
    $('names-text').focus();
  });
  $('apply-names').addEventListener('click', () => {
    const names = $('names-text').value.split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
    applyEditedNames(names);
    $('names-dialog').close();
  });
  $('toggle-events').addEventListener('click', () => setEvents(state.events.length === eventMap.size ? [] : Array.from(eventMap.keys())));
  $('add-organizer').addEventListener('click', () => {
    if (state.organizers.length >= 5) return;
    state.organizers.push({name:'', role:'organizer', signature:''});
    renderOrganizers();
    $('organizers').lastElementChild.querySelector('input').focus();
    changed();
  });
  const goTo = (n) => {
    if (Number.isFinite(n)) state.page = Math.max(0, Math.min(Math.trunc(n), pageCount() - 1));
    changed();
  };
  $('prev').addEventListener('click', () => goTo(state.page - 1));
  $('next').addEventListener('click', () => goTo(state.page + 1));
  $('page').addEventListener('change', () => goTo($('page').valueAsNumber - 1));
  $('page').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('page').blur(); });
  $('export').addEventListener('click', exportPdf);
  $('expand').addEventListener('click', () => {
    $('zoom-title').textContent = $('preview-title').textContent + ' · ' + $('page-context').textContent;
    $('zoom-dialog').showModal();
  });
  document.querySelectorAll('[data-close]').forEach((node) => node.addEventListener('click', () => $(node.dataset.close).close()));
  document.addEventListener('focusout', () => { if (ready && draftVersion !== savedVersion) void saveDraft(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) void saveDraft(); });
  window.addEventListener('pagehide', () => {
    if (draftVersion !== savedVersion) {
      if (window.cubeStudioBrowser) {
        window.cubeStudioBrowser.flushDraft(state);
        return;
      }
      const blob = new Blob([JSON.stringify(state)], {type:'application/json'});
      if (blob.size < 64000) navigator.sendBeacon('/api/draft', blob);
    }
  });
}

async function start() {
  try {
    const boot = await (await api('/api/bootstrap')).json();
    for (const event of boot.events) eventMap.set(event.id, event);
    state = stateFrom(boot.defaults, boot.draft);
    bindControls();
    ready = true;
    renderModes();
    renderOrganizers();
    renderEvents();
    renderWinners();
    renderParticipants();
    renderPageInfo();
    markSaved(boot.draft ? 'Настройки сохранены' :
      (window.cubeStudioBrowser ? 'Черновик сохраняется в этом браузере' : 'Настройки сохраняются на этом компьютере'), Boolean(boot.draft));
    requestPreview();
  } catch (error) {
    setError('Не удалось открыть редактор. ' + error.message);
    hidePreview('Редактор недоступен');
  }
}

void start();
