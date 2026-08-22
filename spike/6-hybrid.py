"""Гибридный поиск: смысловой и текстовый вместе.

Каждый ищет по-своему и слеп по-своему: смысловой понимает синонимы, но не
видит, какое слово в запросе главное; текстовый видит редкое слово, но не знает
синонимов. Списки объединяются по рангу — запись, попавшая в оба, поднимается
выше любой, попавшей в один.
"""
import json, math, os, re, sqlite3, statistics, sys, time, urllib.request

MODEL = os.environ.get('EMBED_MODEL', 'bge-m3')
TOP = 20          # сколько берём от каждого способа перед объединением
RRF_K = 60        # сглаживание: без него первое место одного списка перевешивает всё
STOP = {'the','a','an','to','in','on','of','for','with','and','or','by','into','at','app'}

rows = [json.loads(l) for l in open(sys.argv[1])]

def embed(t):
    req = urllib.request.Request('http://127.0.0.1:11434/api/embeddings',
        data=json.dumps({'model': MODEL, 'prompt': t}).encode(),
        headers={'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(req, timeout=60))['embedding']

def norm(v):
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]

vecs = [norm(r['v']) for r in rows]

# Текстовый индекс строится в памяти: 22 365 заголовков — это 0,06 секунды.
con = sqlite3.connect(':memory:')
con.execute("CREATE VIRTUAL TABLE mr USING fts5(title, tokenize='porter unicode61')")
con.executemany("INSERT INTO mr(rowid, title) VALUES (?, ?)",
                [(i + 1, r['title']) for i, r in enumerate(rows)])

def semantic(qv):
    scores = [sum(a * b for a, b in zip(qv, v)) for v in vecs]
    order = sorted(range(len(scores)), key=lambda i: -scores[i])[:TOP]
    return order, scores

def words_of(q):
    return [w for w in re.findall(r'[a-zA-Z]{3,}', q.lower()) if w not in STOP]

def frequency(word):
    """В скольких записях встречается слово. Редкое слово — сильная улика,
    и именно его игнорирует смысловой поиск."""
    return con.execute("SELECT count(*) FROM mr WHERE mr MATCH ?", (word,)).fetchone()[0]

def fulltext(q):
    # Слова через OR: AND нашёл бы слишком мало — заголовки короткие.
    words = words_of(q)
    if not words:
        return []
    expr = ' OR '.join(words)
    cur = con.execute("SELECT rowid FROM mr WHERE mr MATCH ? ORDER BY bm25(mr) LIMIT ?", (expr, TOP))
    return [r[0] - 1 for r in cur.fetchall()]

for q in sys.argv[2:]:
    t0 = time.time()
    qv = norm(embed(q))
    sem, scores = semantic(qv)
    txt = fulltext(q)

    # Объединение по рангу: вклад места n равен 1/(K+n), сумма по обоим спискам.
    rrf = {}
    for place, i in enumerate(sem):
        rrf[i] = rrf.get(i, 0) + 1 / (RRF_K + place + 1)
    for place, i in enumerate(txt):
        rrf[i] = rrf.get(i, 0) + 1 / (RRF_K + place + 1)
    fused = sorted(rrf, key=lambda i: -rrf[i])[:5]

    both = set(sem) & set(txt)
    ms = (time.time() - t0) * 1000
    print(f'\n=== {q}   ({ms:.0f} мс)')
    freq = [(w, frequency(w)) for w in words_of(q)]
    print('    слова запроса: ' + ', '.join(
        f'{w} — {n}' + (' ← НЕТ В БАЗЕ' if n == 0 else '') for w, n in freq))
    print(f'    оба способа согласны на {len(both)} записях из {TOP}; '
          f'лучшая оценка смысла {scores[sem[0]]:.3f}')
    for i in fused:
        mark = 'оба ' if i in both else ('смысл' if i in sem else 'слова')
        print(f'  [{mark:5}] {scores[i]:.3f}  {rows[i]["project"].split("/")[-1]:26} '
              f'{rows[i]["title"][:46]}')
