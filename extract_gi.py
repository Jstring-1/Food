import fitz, re, csv, os, sys

GI_LO, GI_HI = 383, 412
ITEM_XMAX = 290

def lines_of(page):
    ws = page.get_text('words')
    ws.sort(key=lambda r: (r[1], r[0]))
    lines, cur, cy = [], [], None
    for w in ws:
        if cy is None or abs(w[1] - cy) <= 4:
            cur.append(w); cy = w[1] if cy is None else cy
        else:
            lines.append(cur); cur = [w]; cy = w[1]
    if cur: lines.append(cur)
    return lines

def gi_of(line):
    for x0, y0, x1, y1, t, *_ in line:
        if GI_LO <= x0 <= GI_HI:
            m = re.match(r'(\d{1,3})', t)
            if m:
                v = int(m.group(1))
                if 0 < v <= 115:
                    return v
    return None

def clean_tok(t):
    return re.sub(r'([A-Za-z]{3,})\d{1,2}$', r'\1', t)  # strip footnote superscripts

def item_of(line):
    iws = sorted([(x0, t) for x0, y0, x1, y1, t, *_ in line if x0 < ITEM_XMAX], key=lambda a: a[0])
    if iws and iws[0][0] < 70 and re.fullmatch(r'\d+\*?', iws[0][1]):
        iws = iws[1:]  # drop leading food number
    return ' '.join(clean_tok(t) for _, t in iws).strip()

def is_skip(text):
    s = text.strip()
    if not s: return True
    if 'International tables of glycemic' in s: return True
    if 'Standardized available carbohydrate' in s: return True
    if s.startswith('Food Number') or 'Glu = 100' in s: return True
    if re.fullmatch(r'\d{1,3}', s): return True  # page number
    return False

def is_category(text):
    s = text.strip()
    return len(s) > 3 and any(c.isalpha() for c in s) and not any(c.islower() for c in s) \
        and re.fullmatch(r"[A-Z0-9 &,'/()\-:]+", s) is not None

def extract(path, sample_page=None):
    d = fitz.open(path)
    rng = [sample_page] if sample_page is not None else range(1, d.page_count - 1)
    rows = []
    for pi in rng:
        cur = None
        for line in lines_of(d[pi]):
            if max(w[1] for w in line) < 105:  # header band
                continue
            itext = item_of(line)
            gi = gi_of(line)
            joined = ' '.join(t for *_, t, a, b, c in line) if False else ' '.join(w[4] for w in line)
            if is_skip(joined) or (gi is None and is_category(itext)):
                if cur: rows.append(cur); cur = None
                continue
            if gi is not None:
                if cur: rows.append(cur)
                cur = {'gi': gi, 'items': [itext] if itext else []}
            elif cur is not None and itext:
                cur['items'].append(itext)
        if cur: rows.append(cur)
    out = []
    for r in rows:
        name = re.sub(r'\s+', ' ', ' '.join(r['items'])).strip().strip(',')
        if len(name) > 2:
            out.append((name, r['gi']))
    return out

if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'sample':
        for n, g in extract('SupplementalTable1.pdf', sample_page=3)[:15]:
            print(g, '|', n[:90])
    else:
        rows = extract('SupplementalTable1.pdf')
        seen, uniq = set(), []
        for n, g in rows:
            k = n.lower()
            if k in seen: continue
            seen.add(k); uniq.append((n, g))
        os.makedirs('data', exist_ok=True)
        with open('data/gi.csv', 'w', encoding='utf-8', newline='') as f:
            wc = csv.writer(f); wc.writerow(['name', 'gi']); wc.writerows(uniq)
        print('extracted rows:', len(rows), 'unique:', len(uniq))
