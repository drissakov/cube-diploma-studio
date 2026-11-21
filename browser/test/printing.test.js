import test from 'node:test';
import assert from 'node:assert/strict';
import {registrationCsv} from '../src/csv.js';
import {badgeLayout, layoutInfo, positions} from '../src/packing.js';

test('registration import keeps duplicate names, quoted separators and original order', () => {
  const data = new TextEncoder().encode('Name;Country\r\n"Дана, Қанат";KZ\r\nАлия;KZ\r\nАлия;KZ\r\n;KZ\r\n');
  const {names, skipped, column} = registrationCsv(data);
  assert.deepEqual(names, ['Дана, Қанат', 'Алия', 'Алия']);
  assert.equal(skipped, 1);
  assert.equal(column, 'Name');
});

test('CSV can select an unfamiliar header without treating IDs as names', () => {
  const data = new TextEncoder().encode('ID,Participant label\n17,Nora\n');
  assert.deepEqual(registrationCsv(data).names, []);
  assert.deepEqual(registrationCsv(data, 'Participant label').names, ['Nora']);
});

test('standard badges print upright, six per landscape A4 sheet', () => {
  assert.deepEqual(layoutInfo({}), {capacity: 6, optimal: true, sheetWidth: 297, sheetHeight: 210});
  const plan = badgeLayout({});
  const boxes = positions(plan, 6);
  assert.equal(boxes.length, 6);
  assert.ok(boxes.every(box => box.width === 7500 && box.height === 10000));
});

test('mixed rotations preserve size, margins and separation even on the last sheet', () => {
  const plan = badgeLayout({badgeWidth: 85.6, badgeHeight: 54, badgeMargin: 5, badgeGap: 0});
  assert.equal(plan.count, 11);
  for (const count of [1, 4, 10, 11]) {
    const boxes = positions(plan, count);
    assert.equal(boxes.length, count);
    for (const [i, box] of boxes.entries()) {
      assert.deepEqual([box.width, box.height].sort((a,b) => a-b), [5400, 8560]);
      assert.ok(box.x >= plan.margin && box.y >= plan.margin);
      assert.ok(box.x + box.width <= plan.pageWidth - plan.margin);
      assert.ok(box.y + box.height <= plan.pageHeight - plan.margin);
      for (const other of boxes.slice(0, i)) {
        assert.ok(box.x + box.width <= other.x || other.x + other.width <= box.x ||
                  box.y + box.height <= other.y || other.y + other.height <= box.y);
      }
    }
  }
});
