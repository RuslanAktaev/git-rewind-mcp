import json, os, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor
tok = open(os.path.expanduser('~/.gitlab-token')).read().strip()
pid, out = sys.argv[1], sys.argv[2]

def page(n):
    url = (f'https://gitlab.example.com/api/v4/projects/{pid}/merge_requests'
           f'?state=all&per_page=100&page={n}')
    req = urllib.request.Request(url, headers={'PRIVATE-TOKEN': tok})
    return json.load(urllib.request.urlopen(req, timeout=120))

with ThreadPoolExecutor(8) as ex:
    chunks = list(ex.map(page, range(1, 31)))

rows = []
for c in chunks:
    for m in c:
        rows.append({'iid': m['iid'], 'title': m.get('title') or '',
                     'desc': (m.get('description') or '')[:800],
                     'state': m['state'], 'created': m['created_at'][:10],
                     'url': m['web_url']})
seen, uniq = set(), []
for r in rows:
    if r['iid'] not in seen:
        seen.add(r['iid']); uniq.append(r)
with open(out, 'w') as f:
    for r in uniq: f.write(json.dumps(r, ensure_ascii=False) + '\n')
print(f'{len(uniq)} MR сохранено в {out}')
