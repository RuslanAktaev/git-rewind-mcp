import json, re, sys, time, urllib.request, struct
from concurrent.futures import ThreadPoolExecutor

SRC, OUT = sys.argv[1], sys.argv[2]

def clean(t):
    t = re.sub(r'^[0-9a-z]{7,12}:?\s+', '', t)      # префикс задачи
    t = re.sub(r'https?://\S+', ' ', t)             # ссылки на трекер
    t = re.sub(r'@[\w.-]+', ' ', t)                 # упоминания людей
    t = re.sub(r'\b(refs?|fyi|ref)\b:?', ' ', t, flags=re.I)
    t = re.sub(r'\s+', ' ', t).strip(' .,:-')
    return t

rows = [json.loads(l) for l in open(SRC)]
for r in rows:
    r['text'] = clean(r['title'])
    d = clean(r['desc'])
    if len(d) > 15:
        r['text'] += '. ' + d[:300]

def embed(text):
    req = urllib.request.Request(
        'http://127.0.0.1:11434/api/embeddings',
        data=json.dumps({'model': 'nomic-embed-text', 'prompt': text}).encode(),
        headers={'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(req, timeout=120))['embedding']

t0 = time.time()
with ThreadPoolExecutor(4) as ex:
    vecs = list(ex.map(embed, [r['text'] for r in rows]))
print(f'{len(vecs)} векторов за {time.time()-t0:.0f} c, размерность {len(vecs[0])}')

with open(OUT, 'w') as f:
    for r, v in zip(rows, vecs):
        f.write(json.dumps({**{k: r[k] for k in ('iid','title','text','created','url')},
                            'v': [round(x, 5) for x in v]}, ensure_ascii=False) + '\n')
print('сохранено в', OUT)
