"""Pack fixed-size badges on A4. Packing coordinates use hundredths of a mm."""

from bisect import bisect_right
from decimal import Decimal, InvalidOperation
from functools import lru_cache
from io import BytesIO
from time import monotonic

from reportlab.lib.units import mm
from reportlab.pdfgen.canvas import Canvas

from pdf_engine import _BUILD_LOCK, _font


SHEET_W, SHEET_H = 21000, 29700


def _dimension(value, minimum, maximum, label):
    try:
        number = Decimal(str(value))
        if not number.is_finite() or not minimum <= number <= maximum:
            raise ValueError
        units = number * 100
        if units != units.to_integral_value():
            raise ValueError
        return int(units)
    except (InvalidOperation, TypeError, ValueError):
        raise ValueError(f"{label}: введите от {minimum} до {maximum} мм, максимум два знака после запятой.") from None


def _sizes(width, height, margin, gap):
    return (_dimension(width, 1, 297, "Ширина бейджа"),
            _dimension(height, 1, 297, "Высота бейджа"),
            _dimension(margin, 0, 104.5, "Поле листа"),
            _dimension(gap, 0, 297, "Интервал между бейджами"))


def _normal(length, a, b):
    return sorted({i + j for i in range(0, length + 1, a)
                   for j in range(0, length - i + 1, b)})


def _scales(length, a, b):
    """Extreme valid 1D scales: any row that fit before scaling still fits."""
    hull = []
    for i in range(length // a + 1):
        y = (length - i * a) // b
        while len(hull) >= 2:
            (i0, y0), (i1, y1) = hull[-2:]
            if (i1 - i0) * (y - y0) < (y1 - y0) * (i - i0):
                break
            hull.pop()
        hull.append((i, y))
    scales = [(1, 0, length // a), (0, 1, length // b)]
    for (i, j), (k, l) in zip(hull, hull[1:]):
        scales.append((j - l, k - i, k * j - i * l))
    return scales


def _upper_bound(w, h, a, b, lo):
    # For n badges let q be upright. Each pair of 1D scales gives the area
    # constraint q*A + (n-q)*B <= D; all use integer arithmetic.
    constraints = [(xa * yb, xb * ya, xd * yd)
                   for xa, xb, xd in _scales(w, a, b)
                   for ya, yb, yd in _scales(h, a, b)]
    hi = w * h // (a * b)
    while lo < hi:
        n = (hi + lo + 1) // 2
        left, right = 0, n
        for upright, turned, bound in constraints:
            delta = upright - turned
            slack = bound - n * turned
            if delta > 0:
                right = min(right, slack // delta)
            elif delta < 0:
                left = max(left, -((-slack) // delta))
            elif slack < 0:
                right = -1
            if left > right:
                break
        if left <= right:
            lo = n
        else:
            hi = n - 1
    return lo


def _shelf(w, h, a, b):
    # Block = (origin x, origin y, columns, rows, turned clockwise on sheet).
    best, best_blocks = (0, 0), ()
    for across in (False, True):
        length, depth = (h, w) if across else (w, h)
        wa, ha = (b, a) if across else (a, b)
        for na in range(depth // ha + 1):
            nb = (depth - na * ha) // wa
            ka, kb = length // wa, length // ha
            score = (na * ka + nb * kb, -nb * kb)
            if score > best:
                best = score
                if across:
                    best_blocks = ((0, 0, na, ka, False), (na * ha, 0, nb, kb, True))
                else:
                    best_blocks = ((0, 0, ka, na, False), (0, na * ha, kb, nb, True))
    return best[0], best_blocks


def _blocks_to_slots(blocks, a, b):
    slots = []
    for x, y, nx, ny, turned in blocks:
        dx, dy = (b, a) if turned else (a, b)
        slots.extend((x + i * dx, y + j * dy, turned) for j in range(ny) for i in range(nx))
    return slots


def _raster(length, normal):
    # Right-/top-justify a packing while preserving every axis precedence,
    # then round coordinates down to reachable sums. A preceding rectangle's
    # rounded start + its size is itself a reachable sum, so separation holds.
    return sorted({normal[bisect_right(normal, length - p) - 1] for p in normal})


def _guillotine(w, h, a, b, xs, ys):
    # Recursively choose cuts in normal positions. Store compact decisions;
    # only expand the winning decomposition.
    @lru_cache(None)
    def solve(w, h):
        straight = (w // a) * (h // b)
        turned = (w // b) * (h // a)
        best = (straight, 0, "grid", 0)
        if turned > straight:
            best = (turned, -turned, "grid", 1)
        if w >= a + b and h >= a + b and 4 > best[0]:
            best = (4, -2, "pinwheel", 0)
        if best[0] == w * h // (a * b):
            return best
        for axis, length, positions in (("x", w, xs), ("y", h, ys)):
            for cut in positions[1:bisect_right(positions, length // 2)]:
                other = positions[bisect_right(positions, length - cut) - 1]
                if axis == "x":
                    left, right = solve(cut, h), solve(other, h)
                else:
                    left, right = solve(w, cut), solve(w, other)
                score = left[0] + right[0], left[1] + right[1]
                if score > best[:2]:
                    best = (*score, axis, cut)
        return best

    def expand(w, h, x, y, slots):
        _, _, axis, cut = solve(w, h)
        if axis == "grid":
            dx, dy = (b, a) if cut else (a, b)
            slots.extend(_blocks_to_slots([(x, y, w // dx, h // dy, bool(cut))], a, b))
        elif axis == "pinwheel":
            slots.extend(((x, y, False), (x + a, y, True),
                          (x + b, y + a, False), (x, y + b, True)))
        elif axis == "x":
            expand(cut, h, x, y, slots)
            expand(xs[bisect_right(xs, w - cut) - 1], h, x + cut, y, slots)
        else:
            expand(w, cut, x, y, slots)
            expand(w, ys[bisect_right(ys, h - cut) - 1], x, y + cut, slots)

    slots = []
    expand(xs[-1], ys[-1], 0, 0, slots)
    solve.cache_clear()
    return slots


def _exact(w, h, a, b, xs, ys, best, upper):
    # A feasible set is a clique in the compatibility graph of raster
    # placements. Greedy coloring bounds each subtree of the exact search.
    x_starts, y_starts = _raster(w, xs), _raster(h, ys)
    if len(x_starts) * len(y_starts) > 2600:
        return best, False
    choices = [(x, y, x + dx, y + dy, turn)
               for y in y_starts for x in x_starts
               for dx, dy, turn in ((a, b, False), (b, a, True))
               if x + dx <= w and y + dy <= h]
    if len(choices) > 2200:
        return best, False
    edges = []
    for x1, y1, x2, y2, _ in choices:
        mask = 0
        for i, (u1, v1, u2, v2, _) in enumerate(choices):
            if u1 >= x2 or v1 >= y2 or u2 <= x1 or v2 <= y1:
                mask |= 1 << i
        edges.append(mask)
    deadline = monotonic() + 1.0
    complete = True

    def extend(available, chosen):
        nonlocal best, complete
        if not available:
            if len(chosen) > len(best):
                best = [(choices[i][0], choices[i][1], choices[i][4]) for i in chosen]
            return
        if monotonic() > deadline:
            complete = False
            return
        order, bounds = [], []
        left, color = available, 0
        while left:
            color += 1
            same_color = left
            while same_color:
                bit = same_color & -same_color
                i = bit.bit_length() - 1
                left ^= bit
                same_color &= left & ~edges[i]
                order.append(i)
                bounds.append(color)
        for i, bound in zip(reversed(order), reversed(bounds)):
            if len(chosen) + bound <= len(best) or len(best) >= upper or not complete:
                return
            chosen.append(i)
            extend(available & edges[i], chosen)
            chosen.pop()
            available ^= 1 << i

    extend((1 << len(choices)) - 1, [])
    return best, complete or len(best) == upper


def _packing(w, h, a, b):
    count, blocks = _shelf(w, h, a, b)
    if not count:
        raise ValueError("Бейдж не помещается на A4 даже с поворотом. Уменьшите размер или поля.")
    if a == b or max(a, b) > min(w, h):
        return count, True, blocks, None
    upper = _upper_bound(w, h, a, b, count)
    if count == upper:
        return count, True, blocks, None
    xs, ys = _normal(w, a, b), _normal(h, a, b)
    best = _blocks_to_slots(blocks, a, b)
    if len(xs) * len(ys) <= 4000:
        candidate = _guillotine(w, h, a, b, xs, ys)
        if len(candidate) > len(best):
            best = candidate
    optimal = len(best) == upper
    if not optimal:
        best, optimal = _exact(w, h, a, b, xs, ys, best, upper)
    if len(best) == count:
        return count, optimal, blocks, None
    return len(best), optimal, None, tuple(sorted(best, key=lambda p: (p[1], p[0])))


def _rotation_count(blocks, slots):
    if slots is None:
        return sum(nx * ny for _, _, nx, ny, turn in blocks if turn)
    return sum(turn for _, _, turn in slots)


@lru_cache(maxsize=48)
def _layout(width, height, margin, gap):
    # Expanding every tile at its right and bottom, and the sheet at these
    # two edges only, enforces the requested gap without charging an edge gap.
    # Turning the actual sheet often lets all badges be read upright on screen.
    a, b = width + gap, height + gap
    best = None
    proven = False
    for page_w, page_h in ((SHEET_W, SHEET_H), (SHEET_H, SHEET_W)):
        w, h = page_w - 2 * margin + gap, page_h - 2 * margin + gap
        if best and proven and (w // a) * (h // b) == best[0]:
            blocks = ((0, 0, w // a, h // b, False),)
            return best[0], True, blocks, None, page_w, page_h
        n, optimal, blocks, slots = _packing(w, h, a, b)
        rotated = _rotation_count(blocks, slots)
        if best is None or (n, -rotated) > best[:2]:
            best = (n, -rotated, blocks, slots, page_w, page_h)
        # An optimality proof for either orientation applies to both.
        proven = proven or optimal
        if proven and best[1] == 0:
            break
    return best[0], proven, *best[2:]


def layout_info(width, height, margin=5, gap=0):
    capacity, optimal, _, _, page_w, page_h = _layout(*_sizes(width, height, margin, gap))
    return {"capacity": capacity, "optimal": optimal, "sheetWidth": page_w / 100, "sheetHeight": page_h / 100}


def _positions(sizes, n):
    width, height, margin, gap = sizes
    capacity, _, blocks, slots, page_w, page_h = _layout(*sizes)
    a, b = width + gap, height + gap
    w, h = page_w - 2 * margin + gap, page_h - 2 * margin + gap
    nx, ny = w // a, h // b
    if n < capacity and n <= nx * ny:
        # Prefer upright badges on partly filled last sheets if they all fit.
        slots = [(i % nx * a, i // nx * b, False) for i in range(n)]
    elif slots is None:
        slots = sorted(_blocks_to_slots(blocks, a, b), key=lambda p: (p[1], p[0]))
    boxes = [(x, y, height if turn else width, width if turn else height, turn)
             for x, y, turn in slots[:n]]
    # Center independent horizontal bands. A mixed pattern with vertically
    # overlapping rows must retain its original relative x-coordinates.
    bands = []
    for box in boxes:
        if not bands or box[1] >= bands[-1][0] + gap:
            bands.append([box[1] + box[3], [box]])
        else:
            bands[-1][0] = max(bands[-1][0], box[1] + box[3])
            bands[-1][1].append(box)
    top = boxes[0][1]
    dy = (page_h - (bands[-1][0] - top)) / 2 - top
    result = []
    for _, band in bands:
        left = min(x for x, *_ in band)
        right = max(x + dx for x, _, dx, _, _ in band)
        center = (page_w - (right - left)) / 2 - left
        result.extend((x + center, y + dy, dx, dy_box, turn)
                      for x, y, dx, dy_box, turn in band)
    return result


def badges_pdf(settings, people, width, height, margin=5, gap=0, url="", page=None):
    from badge_art import draw_badge

    sizes = _sizes(width, height, margin, gap)
    capacity, _, _, _, page_w, page_h = _layout(*sizes)
    if not people:
        raise ValueError("Добавьте хотя бы одного человека для печати бейджей.")
    total = (len(people) + capacity - 1) // capacity
    if page is not None and (type(page) is not int or not 0 <= page < total):
        raise ValueError("Лист отсутствует.")
    sheets = range(total) if page is None else [page]
    out = BytesIO()
    with _BUILD_LOCK:
        page_size = (page_w * mm / 100, page_h * mm / 100)
        c = Canvas(out, pagesize=page_size, pageCompression=1, initialFontName=_font("Body").fontName)
        c.setTitle(settings["title"])
        c.setViewerPreference("PrintScaling", "None")
        size_x, size_y = sizes[0] * mm / 100, sizes[1] * mm / 100
        for index in sheets:
            group = people[index * capacity:(index + 1) * capacity]
            guides = []
            for person, box in zip(group, _positions(sizes, len(group))):
                xpos, ypos, dx, dy = [v * mm / 100 for v in box[:4]]
                ybottom = page_size[1] - ypos - dy
                c.saveState()
                if box[4]:
                    c.translate(xpos, ybottom + dy)
                    c.rotate(-90)
                else:
                    c.translate(xpos, ybottom)
                draw_badge(c, 0, 0, size_x, size_y, settings["title"], settings["date"],
                           person["name"], person.get("role", person.get("status", "COMPETITOR")), url)
                c.restoreState()
                guides.append((xpos, ybottom, dx, dy))
            c.setLineWidth(0.22)
            c.setStrokeColorRGB(.61, .65, .67)
            for x, y, dx, dy in guides:
                c.rect(x, y, dx, dy, fill=0, stroke=1)
            c.showPage()
        c.save()
    return out.getvalue()
