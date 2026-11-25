import assert from 'node:assert/strict';
import test from 'node:test';
import {certificatePdf} from '../src/certificates.js';
import {serveAssets, pdfPages} from './pdf-helpers.js';

const state = {
  mode: 'volunteers',
  title: 'Volunteer Open',
  date: 'June 12–13',
  organizers: [{name: 'Айжан Әлімова', role: 'wca'}, {name: 'Dana Khan', role: 'organizer'}],
  names: ['Алия Нұр', 'Тимур Кәрім', 'Алия Нұр'],
};
const caption = 'has volunteered at this competition';

test('volunteer PDF issues one correctly worded certificate per roster row in order', async (t) => {
  serveAssets(t);
  const pages = await pdfPages(await certificatePdf(state));
  assert.equal(pages.length, state.names.length);
  for (const [index, text] of pages.entries()) {
    for (const expected of [state.names[index], caption, state.title, state.date, ...state.organizers.map(o => o.name)]) {
      assert.ok(text.includes(expected), 'Missing PDF text: ' + expected);
    }
    for (const other of state.names.filter(name => name !== state.names[index])) {
      assert.ok(!text.includes(other));
    }
  }
});

test('volunteer preview follows the selected recipient and supports an empty draft', async (t) => {
  serveAssets(t);
  const [chosen] = await pdfPages(await certificatePdf({...state, page: 1}, true));
  assert.ok(chosen.includes(state.names[1]) && !chosen.includes(state.names[0]));
  const draft = {...state, names: []};
  const [blank] = await pdfPages(await certificatePdf(draft, true));
  assert.ok(blank.includes(caption));
  await assert.rejects(certificatePdf(draft), /имена/);
});

test('participation certificates keep the original template wording', async (t) => {
  serveAssets(t);
  const [page] = await pdfPages(await certificatePdf({...state, mode: 'participation', names: ['Other Person']}));
  assert.ok(page.includes('Other Person'));
  assert.ok(!page.includes(caption));
});
