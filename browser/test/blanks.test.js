import assert from 'node:assert/strict';
import test from 'node:test';
import {badgesPdf} from '../src/badges.js';
import {certificatePdf} from '../src/certificates.js';
import {pdfPages, serveAssets} from './pdf-helpers.js';

const recipient = 'Named Recipient';
const state = {
  title: 'Print Open', date: 'June 15', blankMode: true,
  organizers: [{name: 'Dana Khan', role: 'organizer'}],
  names: [recipient], badgePeople: [{name: recipient, role: 'DELEGATE'}],
};

test('blank participation and volunteer PDFs use the chosen count and omit recipient names', async (t) => {
  serveAssets(t);
  for (const mode of ['participation', 'volunteers']) {
    const pages = await pdfPages(await certificatePdf({...state, mode, blankCount: 3}));
    assert.equal(pages.length, 3);
    for (const page of pages) {
      assert.ok(page.includes(state.title) && page.includes(state.date) && page.includes('Dana Khan'));
      assert.ok(!page.includes(recipient));
      assert.equal(page.includes('has volunteered at this competition'), mode === 'volunteers');
    }
  }
});

test('blank badges pack onto A4 sheets with the selected role and no printed name or placeholder', async (t) => {
  serveAssets(t);
  const badge = {...state, mode: 'badges', blankCount: 7, blankRole: 'GUEST'};
  const pages = await pdfPages(await badgesPdf(badge));
  assert.equal(pages.length, 2);
  const compact = text => text.replace(/\s/g, '');
  const badgeText = compact(state.title + state.date + 'GUEST');
  assert.deepEqual(pages.map(compact), [badgeText.repeat(6), badgeText]);
  assert.deepEqual((await pdfPages(await badgesPdf({...badge, page: 1}, true))).map(compact), [badgeText]);
  const [defaultBadge] = await pdfPages(await badgesPdf({...state, mode: 'badges'}));
  assert.equal(compact(defaultBadge), compact(state.title + state.date + 'COMPETITOR'));
});

test('blank print count guards both engines and previews the final item at the upper limit', async (t) => {
  serveAssets(t);
  for (const [mode, generate, lastPage] of [['badges', badgesPdf, 83], ['participation', certificatePdf, 499]]) {
    const batch = {...state, mode, blankCount: 500};
    for (const blankCount of [0, 501, -1, 1.5, '2', true, null]) {
      await assert.rejects(generate({...batch, blankCount}));
    }
    assert.equal((await pdfPages(await generate({...batch, page: lastPage}, true))).length, 1);
    await assert.rejects(generate({...batch, page: lastPage + 1}, true));
  }
  await assert.rejects(badgesPdf({...state, mode: 'badges', blankRole: 'OTHER'}));
});

test('turning blank mode off resumes the saved recipient and original badge role', async (t) => {
  serveAssets(t);
  const named = {...state, blankMode: false, blankCount: 5, blankRole: 'GUEST'};
  for (const [mode, generate] of [['badges', badgesPdf], ['volunteers', certificatePdf]]) {
    const pages = await pdfPages(await generate({...named, mode}));
    assert.equal(pages.length, 1);
    assert.ok(pages[0].replace(/\s/g, '').includes('NamedRecipient'));
    if (mode === 'badges') assert.ok(pages[0].includes('DELEGATE') && !pages[0].includes('GUEST'));
  }
});
