"""Проверка поиска на размеченных примерах.

Для каждого запроса заранее известно, что должно найтись: регулярка по
заголовкам служит эталоном. Считаем, попал ли эталон в пятёрку и какой при
этом z — то есть отличает ли поиск «нашли» от «такого не делали».
"""
import json, math, os, re, statistics, sys, urllib.request

MODEL = os.environ.get('EMBED_MODEL', 'bge-m3')

# truth=None означает «такого в базе нет», и правильный ответ — не найти.
CASES = [
    ('two-factor authentication OTP',        r'\b2fa\b|two[- ]factor|\botp\b'),
    ('export report to csv',                 r'export.{0,20}csv|csv.{0,20}export'),
    ('push notifications',                   r'push notification'),
    ('stripe payment integration',           r'stripe'),
    ('dark mode theme switch',               r'dark (mode|theme)'),
    ('google maps on screen',                r'google map|mapbox'),
    ('sync cryptocurrency rates',            r'crypto'),
    ('pay with cryptocurrency bitcoin',      None),
    ('thermal printer label printing',       None),
    ('nuclear reactor control panel',        None),
]

rows = [json.loads(l) for l in open(sys.argv[1])]

def embed(t):
    req = urllib.request.Request('http://127.0.0.1:11434/api/embeddings',
        data=json.dumps({'model': MODEL, 'prompt': t}).encode(),
        headers={'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(req, timeout=60))['embedding']

def norm(v):
    n = math.sqrt(sum(x*x for x in v)) or 1.0
    return [x/n for x in v]

vecs = [norm(r['v']) for r in rows]

print(f'{"запрос":34} {"в базе":>7} {"в топ-5":>8} {"z1":>6} {"z5":>6}')
for q, truth in CASES:
    pat = re.compile(truth, re.I) if truth else None
    in_base = sum(1 for r in rows if pat and pat.search(r['title']))

    qv = norm(embed(q))
    scores = [sum(a * b for a, b in zip(qv, v)) for v in vecs]
    bg, sd = statistics.mean(scores), statistics.pstdev(scores) or 1.0
    top = sorted(zip(scores, rows), key=lambda t: -t[0])[:5]
    z = (top[0][0] - bg) / sd
    # Случайный выброс поднимает только первый результат; настоящая тема даёт
    # плотную группу, поэтому пятый результат — более честный признак находки.
    z5 = (top[4][0] - bg) / sd
    found = sum(1 for _, r in top if pat and pat.search(r['title']))

    print(f'{q[:34]:34} {in_base:7} {found:8} {z:6.2f} {z5:6.2f}'
          + ('' if truth else '   ← такого в базе нет'))

print('\nz1 — отрыв первого результата, z5 — пятого. Порог должен разделять '
      'строки с эталоном и строки без него.')
