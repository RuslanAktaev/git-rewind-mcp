import json, os, math, statistics, sys, urllib.request

# Многоязычная модель: запросы можно писать по-русски.
MODEL = os.environ.get('EMBED_MODEL', 'bge-m3')

DB = sys.argv[1]
rows = [json.loads(l) for l in open(DB)]

def embed(text):
    req = urllib.request.Request(
        'http://127.0.0.1:11434/api/embeddings',
        data=json.dumps({'model': MODEL, 'prompt': text}).encode(),
        headers={'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(req, timeout=60))['embedding']

def norm(v):
    n = math.sqrt(sum(x*x for x in v)) or 1.0
    return [x/n for x in v]

vecs = [norm(r['v']) for r in rows]

# Ни один порог на этих данных не разделяет находку и промах (замеры в
# 5-eval.py): несуществующее «pay with cryptocurrency» набирает больше, чем
# настоящий «google maps». Поэтому вердикт не выносим — печатаем отрыв от
# фона как подсказку, а решает тот, кто читает заголовки.
for q in sys.argv[2:]:
    qv = norm(embed(q))
    scores = [sum(a*b for a, b in zip(qv, v)) for v in vecs]
    bg, sd = statistics.mean(scores), statistics.pstdev(scores) or 1.0
    top = sorted(zip(scores, rows), key=lambda t: -t[0])[:5]
    z = (top[0][0] - bg) / sd

    z5 = (top[-1][0] - bg) / sd if len(top) == 5 else float('nan')
    print(f'\n=== {q}\n    отрыв от фона: первый {z:.1f}σ, пятый {z5:.1f}σ '
          f'(плотная группа — тема есть, одинокий выброс — скорее совпало слово)')
    for score, r in top:
        where = f'{r["project"].split("/")[-1]} !{r["iid"]}  ' if 'project' in r else ''
        print(f'  {score:.3f}  {where}[{r["created"]}] {r["text"][:70]}')
