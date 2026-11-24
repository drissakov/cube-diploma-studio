'use strict';

const badgeRoles = ['COMPETITOR', 'DELEGATE', 'ORGANIZER', 'GUEST', 'VOLUNTEER'];
const badgeMeasures = [
  ['badgeWidth', 'badge-width', 75], ['badgeHeight', 'badge-height', 100],
  ['badgeMargin', 'badge-margin', 5], ['badgeGap', 'badge-gap', 0]
];
let badgeCapacity = 0;
let layoutKey = '';
let layoutTimer;
let layoutVersion = 0;
let layoutRequest;
let layoutNote = '';

function badgeState(merged, names) {
  const people = Array.isArray(merged.badgePeople)
    ? merged.badgePeople.filter(person => person && typeof person.name === 'string').map(person => ({
        name: person.name, role: badgeRoles.includes(person.role) ? person.role : 'COMPETITOR',
        ...(typeof person.sourceName === 'string' ? {sourceName: person.sourceName} : {})
      }))
    : names.map(name => ({name, role: 'COMPETITOR', sourceName: name}));
  const values = {badgePeople: people, badgeUrl: String(merged.badgeUrl ?? '')};
  for (const [key, , initial] of badgeMeasures) values[key] = key in merged ? merged[key] : initial;
  return values;
}

function replaceRegistrationNames(names, preserveImportedEdits = true) {
  const byName = new Map();
  const manual = [];
  for (const person of state.badgePeople) {
    if (!('sourceName' in person)) {
      manual.push(person);
    } else if (preserveImportedEdits) {
      if (!byName.has(person.sourceName)) byName.set(person.sourceName, []);
      byName.get(person.sourceName).push(person);
    }
  }
  // A CSV can contain several different people with the same name.
  for (const people of byName.values()) people.reverse();
  state.names = names;
  state.badgePeople = names.map(name => byName.get(name)?.pop() || {name, role: 'COMPETITOR', sourceName: name}).concat(manual);
  $('badge-search').value = '';
  if (state.mode === 'badges') renderBadgeRows();
}

function fillBadgeRole(select, role) {
  for (const label of badgeRoles) select.add(new Option(label, label));
  select.value = role;
  select.dataset.role = role;
}

function replaceBadgeNames(names, newRole = 'COMPETITOR') {
  const key = name => name.trim().normalize().toLowerCase();
  const byName = new Map();
  // Pop matching rows in their original order, including people with identical names.
  for (let i = state.badgePeople.length - 1; i >= 0; i--) {
    const person = state.badgePeople[i];
    const name = key(person.name);
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(person);
  }
  state.badgePeople = names.map(name => {
    const previous = byName.get(key(name))?.pop();
    return previous ? {...previous, name} : {name, role: newRole};
  });
  $('badge-search').value = '';
  renderBadgeRows();
}

function focusBadgeSheet(index) {
  if (!badgeCapacity) return;
  const sheet = Math.floor(index / badgeCapacity);
  if (state.page !== sheet) {
    state.page = sheet;
    changed();
  }
}

function filterBadgeRows() {
  const query = $('badge-search').value.trim().toLocaleLowerCase();
  let visible = 0;
  for (const row of $('badge-list').children) {
    row.hidden = !state.badgePeople[Number(row.dataset.index)].name.toLocaleLowerCase().includes(query);
    if (!row.hidden) visible++;
  }
  $('badge-empty').hidden = visible > 0;
  $('badge-empty').textContent = state.badgePeople.length ? 'По этому имени никого не найдено.' : 'Вставьте имена списком, загрузите CSV или добавьте человека вручную.';
  $('badge-column-titles').hidden = !visible;
}

function renderBadgeRows() {
  const fragment = document.createDocumentFragment();
  state.badgePeople.forEach((person, index) => {
    const number = String(index + 1);
    const row = make('div', 'badge-row');
    row.dataset.index = String(index);
    row.addEventListener('focusin', () => focusBadgeSheet(index));
    const name = textInput(person.name, 'Имя и фамилия', 'Имя на бейдже ' + number, value => {
      person.name = value;
      focusBadgeSheet(index);
    });
    name.className = 'badge-person-name';
    const role = make('select', 'badge-status');
    role.setAttribute('aria-label', 'Статус на бейдже ' + number);
    fillBadgeRole(role, person.role);
    role.addEventListener('change', () => {
      person.role = role.value;
      role.dataset.role = person.role;
      focusBadgeSheet(index);
      changed();
    });
    const remove = smallButton('Удалить бейдж ' + number, 'close', () => {
      state.badgePeople.splice(index, 1);
      renderBadgeRows();
      changed();
    });
    row.append(name, role, remove);
    fragment.append(row);
  });
  $('badge-list').replaceChildren(fragment);
  $('badge-roster-count').textContent = String(state.badgePeople.length);
  $('edit-badge-names').textContent = state.badgePeople.length ? 'Изменить список' : 'Вставить имена';
  $('badge-search').hidden = !state.badgePeople.length;
  filterBadgeRows();
}

function setLayoutNote(message, invalid = false) {
  layoutNote = message;
  $('badge-layout-info').textContent = message;
  $('badge-layout-info').classList.toggle('invalid', invalid);
}

function invalidateLayout() {
  const measures = {};
  for (const [key] of badgeMeasures) measures[key] = state[key];
  const key = JSON.stringify(measures);
  if (key === layoutKey && badgeCapacity) return;
  clearTimeout(layoutTimer);
  layoutRequest?.abort();
  const version = ++layoutVersion;
  layoutKey = key;
  badgeCapacity = 0;
  if (!badgeMeasures.every(([key]) => Number.isFinite(state[key]))) {
    setLayoutNote('Заполните все размеры в миллиметрах.', true);
    renderPageInfo();
    requestPreview();
    return;
  }
  setLayoutNote('Рассчитываем раскладку…');
  renderPageInfo();
  requestPreview();
  layoutTimer = setTimeout(async () => {
    layoutRequest = new AbortController();
    try {
      const result = await (await api('/api/badge-layout', measures, {signal: layoutRequest.signal})).json();
      if (version !== layoutVersion) return;
      badgeCapacity = result.capacity;
      const count = badgeCapacity + ' ' + plural(badgeCapacity, 'бейдж', 'бейджа', 'бейджей') + ' на лист A4';
      setLayoutNote(result.optimal === false ? count + ' · Лучшая найденная раскладка' : count);
    } catch (error) {
      if (version !== layoutVersion || error.name === 'AbortError') return;
      setLayoutNote(error.message, true);
    }
    if (state.mode === 'badges' && version === layoutVersion) {
      renderPageInfo();
      requestPreview();
    }
  }, 160);
}

function bindBadgeControls() {
  for (const [key, id] of badgeMeasures) {
    const input = $(id);
    input.value = state[key] ?? '';
    input.addEventListener('input', () => {
      state[key] = Number.isFinite(input.valueAsNumber) ? input.valueAsNumber : null;
      state.page = 0;
      invalidateLayout();
      changed({preview: false});
    });
  }
  $('badge-url').value = state.badgeUrl;
  $('badge-url').addEventListener('input', () => { state.badgeUrl = $('badge-url').value; changed(); });
  $('badge-search').addEventListener('input', filterBadgeRows);
  for (const select of [$('badge-new-role'), $('badge-bulk-role')]) {
    fillBadgeRole(select, 'COMPETITOR');
    select.addEventListener('change', () => { select.dataset.role = select.value; });
  }
  $('badge-new').addEventListener('submit', event => {
    event.preventDefault();
    const name = $('badge-new-name').value.trim();
    if (!name) { $('badge-new-name').focus(); return; }
    state.badgePeople.push({name, role: $('badge-new-role').value});
    $('badge-search').value = '';
    $('badge-new-name').value = '';
    renderBadgeRows();
    const index = state.badgePeople.length - 1;
    if (badgeCapacity) state.page = Math.floor(index / badgeCapacity);
    $('badge-list').scrollTop = $('badge-list').scrollHeight;
    $('badge-new-name').focus();
    changed();
  });
}
