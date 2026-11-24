import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

test('bulk badge edits keep roles and CSV links by name and duplicate occurrence', () => {
  const state = {
    names: ['Имя из CSV'],
    volunteerNames: ['Волонтёр'],
    badgePeople: [
      {name: 'Айя', role: 'DELEGATE', sourceName: 'Aya'},
      {name: 'René', role: 'VOLUNTEER'},
      {name: 'Айя', role: 'GUEST'},
      {name: 'Удалённая строка', role: 'ORGANIZER'},
    ],
  };
  // The hosted and desktop editors both load this UI code as a classic script.
  const editor = {state, $: () => ({value: ''})};
  runInNewContext(readFileSync(new URL('../../web/badges.js', import.meta.url), 'utf8'), editor);
  editor.renderBadgeRows = () => {};
  editor.replaceBadgeNames(['Rene\u0301', 'АЙЯ', 'Айя', 'Айя', 'Новый человек']);
  assert.deepEqual(state.badgePeople.map(person => ({...person})), [
    {name: 'Rene\u0301', role: 'VOLUNTEER'},
    {name: 'АЙЯ', role: 'DELEGATE', sourceName: 'Aya'},
    {name: 'Айя', role: 'GUEST'},
    {name: 'Айя', role: 'COMPETITOR'},
    {name: 'Новый человек', role: 'COMPETITOR'},
  ]);
  editor.replaceBadgeNames([]);
  assert.equal(state.badgePeople.length, 0);
  assert.deepEqual(state.names, ['Имя из CSV']);
  assert.deepEqual(state.volunteerNames, ['Волонтёр']);
});
