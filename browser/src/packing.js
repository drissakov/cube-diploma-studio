// Dimensions and packing coordinates are integers in hundredths of a millimetre.
// A 90° turn of a badge is independent of the orientation chosen for the A4 sheet.
const sheetSides = [21000, 29700];
const cache = new Map();
const floor = Math.floor;
const rowOrder = (a, b) => a.y - b.y || a.x - b.x;

function units(value, min, max, label) {
  const n = Number(value);
  const scaled = Math.round(n * 100);
  if (value === null || value === '' || !Number.isFinite(n) || n < min || n > max || Math.abs(n - scaled / 100) > 1e-11) {
    throw new Error(`${label}: введите от ${min} до ${max} мм, максимум два знака после запятой.`);
  }
  return scaled;
}

function normalPositions(length, a, b) {
  const positions = new Set();
  for (let x = 0; x <= length; x += a)
    for (let y = 0; x + y <= length; y += b) positions.add(x + y);
  return [...positions].sort((x, y) => x - y);
}

function atOrBelow(sorted, limit) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = floor((lo + hi) / 2);
    if (sorted[mid] <= limit) lo = mid + 1;
    else hi = mid;
  }
  return sorted[lo - 1];
}

function scales(length, a, b) {
  // Facets of the hull of valid 1D rows bound the 2D area in rescaled coordinates.
  const hull = [];
  for (let i = 0; i <= floor(length / a); i++) {
    const y = floor((length - i * a) / b);
    while (hull.length >= 2) {
      const [i0, y0] = hull.at(-2), [i1, y1] = hull.at(-1);
      if ((i1 - i0) * (y - y0) < (y1 - y0) * (i - i0)) break;
      hull.pop();
    }
    hull.push([i, y]);
  }
  const result = [[1, 0, floor(length / a)], [0, 1, floor(length / b)]];
  for (let t = 1; t < hull.length; t++) {
    const [i, j] = hull[t - 1], [k, l] = hull[t];
    result.push([j - l, k - i, k * j - i * l]);
  }
  return result;
}

function upperBound(w, h, a, b, lo) {
  const constraints = [];
  const yScales = scales(h, a, b);
  for (const [xa, xb, xd] of scales(w, a, b))
    for (const [ya, yb, yd] of yScales) constraints.push([xa * yb, xb * ya, xd * yd]);
  let hi = floor(w * h / (a * b));
  while (lo < hi) {
    const n = floor((lo + hi + 1) / 2);
    let left = 0, right = n;
    for (const [upright, rotated, bound] of constraints) {
      const delta = upright - rotated, slack = bound - n * rotated;
      if (delta > 0) right = Math.min(right, floor(slack / delta));
      else if (delta < 0) left = Math.max(left, Math.ceil(slack / delta));
      else if (slack < 0) right = -1;
      if (left > right) break;
    }
    if (left <= right) lo = n;
    else hi = n - 1;
  }
  return lo;
}

function shelf(w, h, a, b) {
  let best = { count: 0, turns: 0, blocks: [] };
  for (const across of [false, true]) {
    const [length, depth, wa, ha] = across ? [h, w, b, a] : [w, h, a, b];
    const ka = floor(length / wa), kb = floor(length / ha);
    for (let na = 0; na <= floor(depth / ha); na++) {
      const nb = floor((depth - na * ha) / wa);
      const turns = nb * kb, count = na * ka + turns;
      if (count > best.count || (count === best.count && turns < best.turns)) {
        const blocks = across
          ? [[0, 0, na, ka, false], [na * ha, 0, nb, kb, true]]
          : [[0, 0, ka, na, false], [0, na * ha, kb, nb, true]];
        best = { count, turns, blocks };
      }
    }
  }
  return best;
}

function expandBlocks(blocks, a, b) {
  const slots = [];
  for (const [x, y, cols, rows, turned] of blocks) {
    const dx = turned ? b : a, dy = turned ? a : b;
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) slots.push({ x: x + i * dx, y: y + j * dy, turned });
  }
  return slots;
}

function guillotine(a, b, xs, ys) {
  // Save only the winning cut for each reachable width/height pair.
  const memo = new Map();
  function solve(w, h) {
    const key = w + ',' + h;
    if (memo.has(key)) return memo.get(key);
    const straight = floor(w / a) * floor(h / b);
    const rotated = floor(w / b) * floor(h / a);
    let best = rotated > straight ? [rotated, rotated, 'grid', true] : [straight, 0, 'grid', false];
    if (w >= a + b && h >= a + b && best[0] < 4) best = [4, 2, 'pinwheel'];
    if (best[0] < floor(w * h / (a * b))) {
      for (const [axis, length, positions] of [['x', w, xs], ['y', h, ys]]) {
        for (let i = 1; i < positions.length && 2 * positions[i] <= length; i++) {
          const cut = positions[i], other = atOrBelow(positions, length - cut);
          const left = axis === 'x' ? solve(cut, h) : solve(w, cut);
          const right = axis === 'x' ? solve(other, h) : solve(w, other);
          const count = left[0] + right[0], turns = left[1] + right[1];
          if (count > best[0] || (count === best[0] && turns < best[1])) best = [count, turns, axis, cut];
        }
      }
    }
    memo.set(key, best);
    return best;
  }
  const slots = [];
  function expand(w, h, x, y) {
    const [, , axis, cut] = solve(w, h);
    if (axis === 'grid') {
      const cols = floor(w / (cut ? b : a)), rows = floor(h / (cut ? a : b));
      for (const p of expandBlocks([[x, y, cols, rows, cut]], a, b)) slots.push(p);
    } else if (axis === 'pinwheel') {
      slots.push({ x, y, turned: false }, { x: x + a, y, turned: true },
        { x: x + b, y: y + a, turned: false }, { x, y: y + b, turned: true });
    } else if (axis === 'x') {
      expand(cut, h, x, y);
      expand(atOrBelow(xs, w - cut), h, x + cut, y);
    } else {
      expand(w, cut, x, y);
      expand(w, atOrBelow(ys, h - cut), x, y + cut);
    }
  }
  expand(xs.at(-1), ys.at(-1), 0, 0);
  return slots;
}

function exact(w, h, a, b, xs, ys, best, upper) {
  // In the raster graph each clique is a set of nonoverlapping badge positions.
  const raster = (length, normal) => [...new Set(normal.map(p => atOrBelow(normal, length - p)))].sort((x, y) => x - y);
  const xx = raster(w, xs), yy = raster(h, ys);
  if (xx.length * yy.length > 2600) return { slots: best, optimal: false };
  const choices = [];
  for (const y of yy) for (const x of xx) {
    for (const [dx, dy, turned] of [[a, b, false], [b, a, true]])
      if (x + dx <= w && y + dy <= h) choices.push({ x, y, right: x + dx, bottom: y + dy, turned });
  }
  if (choices.length > 2200) return { slots: best, optimal: false };
  const bits = choices.map((_, i) => 1n << BigInt(i));
  const indices = new Map(bits.map((bit, i) => [bit, i]));
  const edges = choices.map(p => {
    let mask = 0n;
    for (let i = 0; i < choices.length; i++) {
      const q = choices[i];
      if (q.x >= p.right || q.y >= p.bottom || q.right <= p.x || q.bottom <= p.y) mask |= bits[i];
    }
    return mask;
  });
  const deadline = performance.now() + 1000;
  let complete = true;
  const chosen = [];
  function extend(available) {
    if (!available) {
      if (chosen.length > best.length) best = chosen.map(i => choices[i]);
      return;
    }
    if (performance.now() > deadline) { complete = false; return; }
    const order = [], bounds = [];
    let left = available, color = 0;
    while (left) {
      color++;
      let sameColor = left;
      while (sameColor) {
        const bit = sameColor & -sameColor, i = indices.get(bit);
        left ^= bit;
        sameColor &= left & ~edges[i];
        order.push(i);
        bounds.push(color);
      }
    }
    for (let j = order.length - 1; j >= 0; j--) {
      if (bounds[j] + chosen.length <= best.length || best.length >= upper || !complete) return;
      const i = order[j];
      chosen.push(i);
      extend(available & edges[i]);
      chosen.pop();
      available ^= bits[i];
    }
  }
  extend((1n << BigInt(choices.length)) - 1n);
  return { slots: best, optimal: complete || best.length === upper };
}

function packing(w, h, a, b) {
  const initial = shelf(w, h, a, b);
  if (!initial.count) throw new Error('Бейдж не помещается на A4 даже с поворотом. Уменьшите размер или поля.');
  if (a === b || Math.max(a, b) > Math.min(w, h)) return { ...initial, optimal: true };
  const upper = upperBound(w, h, a, b, initial.count);
  if (initial.count === upper) return { ...initial, optimal: true };
  const xs = normalPositions(w, a, b), ys = normalPositions(h, a, b);
  let slots = expandBlocks(initial.blocks, a, b);
  if (xs.length * ys.length <= 4000) {
    const split = guillotine(a, b, xs, ys);
    if (split.length > slots.length) slots = split;
  }
  let optimal = slots.length === upper;
  if (!optimal) ({ slots, optimal } = exact(w, h, a, b, xs, ys, slots, upper));
  if (slots.length === initial.count) return { ...initial, optimal };
  return { count: slots.length, turns: slots.filter(p => p.turned).length, slots: slots.sort(rowOrder), optimal };
}

export function badgeLayout(state) {
  const width = units(state.badgeWidth === undefined ? 75 : state.badgeWidth, 1, 297, 'Ширина бейджа');
  const height = units(state.badgeHeight === undefined ? 100 : state.badgeHeight, 1, 297, 'Высота бейджа');
  const margin = units(state.badgeMargin === undefined ? 5 : state.badgeMargin, 0, 104.5, 'Поле листа');
  const gap = units(state.badgeGap === undefined ? 0 : state.badgeGap, 0, 297, 'Интервал между бейджами');
  const key = [width, height, margin, gap].join(',');
  if (cache.has(key)) return cache.get(key);
  const a = width + gap, b = height + gap;
  let best, proven = false;
  for (const [pageWidth, pageHeight] of [sheetSides, sheetSides.slice().reverse()]) {
    // Expand the sheet only at the right and bottom to avoid charging an edge gap.
    const w = pageWidth - 2 * margin + gap, h = pageHeight - 2 * margin + gap;
    const candidate = packing(w, h, a, b);
    if (!best || candidate.count > best.count || (candidate.count === best.count && candidate.turns < best.turns))
      best = { ...candidate, pageWidth, pageHeight };
    proven ||= candidate.optimal;
    if (proven && best.turns === 0) break;
  }
  const plan = { ...best, optimal: proven, width, height, margin, gap };
  if (cache.size >= 48) cache.delete(cache.keys().next().value);
  cache.set(key, plan);
  return plan;
}

export function layoutInfo(state) {
  const p = badgeLayout(state);
  return { capacity: p.count, optimal: p.optimal, sheetWidth: p.pageWidth / 100, sheetHeight: p.pageHeight / 100 };
}

export function positions(plan, n) {
  const { width, height, margin, gap, pageWidth, pageHeight } = plan;
  const a = width + gap, b = height + gap;
  const nx = floor((pageWidth - 2 * margin + gap) / a);
  const ny = floor((pageHeight - 2 * margin + gap) / b);
  let slots = plan.slots;
  if (n < plan.count && n <= nx * ny) {
    slots = Array.from({ length: n }, (_, i) => ({ x: (i % nx) * a, y: floor(i / nx) * b, turned: false }));
  } else if (!slots) slots = expandBlocks(plan.blocks, a, b).sort(rowOrder);
  const bands = [];
  for (const slot of slots.slice(0, n)) {
    const box = { ...slot, width: slot.turned ? height : width, height: slot.turned ? width : height };
    let band = bands.at(-1);
    if (!band || box.y >= band.bottom + gap) {
      band = { boxes: [], bottom: box.y };
      bands.push(band);
    }
    band.boxes.push(box);
    band.bottom = Math.max(band.bottom, box.y + box.height);
  }
  if (!bands.length) return [];
  const top = bands[0].boxes[0].y;
  const dy = (pageHeight - (bands.at(-1).bottom - top)) / 2 - top;
  return bands.flatMap(band => {
    // Only independent bands can move horizontally without creating overlaps.
    const left = band.boxes.reduce((v, p) => Math.min(v, p.x), Infinity);
    const right = band.boxes.reduce((v, p) => Math.max(v, p.x + p.width), 0);
    const dx = (pageWidth - (right - left)) / 2 - left;
    return band.boxes.map(p => ({ ...p, x: p.x + dx, y: p.y + dy }));
  });
}
