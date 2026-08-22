import json, math, sys, urllib.request

DB = sys.argv[1]
rows = [json.loads(l) for l in open(DB)]

def embed(text):
    req = urllib.request.Request(
        'http://127.0.0.1:11434/api/embeddings',
        data=json.dumps({'model': 'nomic-embed-text', 'prompt': text}).encode(),
        headers={'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(req, timeout=60))['embedding']

def norm(v):
    n = math.sqrt(sum(x*x for x in v)) or 1.0
    return [x/n for x in v]

vecs = [norm(r['v']) for r in rows]

for q in sys.argv[2:]:
    qv = norm(embed(q))
    scored = sorted(
        ((sum(a*b for a, b in zip(qv, v)), r) for v, r in zip(vecs, rows)),
        key=lambda t: -t[0])[:5]
    print(f'\n=== {q}')
    for s, r in scored:
        print(f'  {s:.3f}  [{r["created"]}] {r["text"][:88]}')
