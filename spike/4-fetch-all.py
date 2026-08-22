"""Выкачивает merge request'ы всех проектов, где состоит пользователь.

В отличие от 1-fetch-mrs.py берёт не один проект и не фиксированное число
страниц: идёт по страницам, пока GitLab отдаёт полные, — иначе большие проекты
молча обрезаются.
"""
import json, os, sys, time, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor

HOST = 'https://gitlab.example.com'
TOKEN = open(os.path.expanduser('~/.gitlab-token')).read().strip()
OUT = sys.argv[1]

def api(path):
    """GET с повтором: длинный обход почти наверняка словит таймаут или обрыв."""
    for attempt in range(4):
        try:
            req = urllib.request.Request(HOST + path, headers={'PRIVATE-TOKEN': TOKEN})
            with urllib.request.urlopen(req, timeout=120) as resp:
                return json.load(resp)
        # OSError покрывает и обрывы соединения, и таймауты, и HTTPError.
        except (OSError, json.JSONDecodeError) as e:
            # 403 и прочие 4xx повторять бессмысленно: доступа не прибавится.
            fatal = isinstance(e, urllib.error.HTTPError) and 400 <= e.code < 500 and e.code != 429
            if fatal or attempt == 3:
                print(f'  ! пропущено {path}: {e}', file=sys.stderr)
                return []
            time.sleep(2 ** attempt)

def pages(path):
    """Собирает все страницы: последняя — та, что короче запрошенного размера."""
    rows, page = [], 1
    while True:
        chunk = api(f'{path}{"&" if "?" in path else "?"}per_page=100&page={page}')
        rows += chunk
        if len(chunk) < 100 or page >= 200:
            return rows
        page += 1

t0 = time.time()
projects = pages('/api/v4/projects?membership=true&simple=true&order_by=id')
print(f'проектов: {len(projects)}')

def mrs(p):
    rows = pages(f'/api/v4/projects/{p["id"]}/merge_requests?state=all')
    return [{'project': p['path_with_namespace'], 'project_id': p['id'], 'iid': m['iid'],
             'title': m.get('title') or '', 'desc': (m.get('description') or '')[:800],
             'state': m['state'], 'created': m['created_at'][:10], 'url': m['web_url']}
            for m in rows]

with ThreadPoolExecutor(8) as ex:
    per_project = list(ex.map(mrs, projects))

with open(OUT, 'w') as f:
    total = 0
    for rows in per_project:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + '\n')
            total += 1

empty = sum(1 for rows in per_project if not rows)
print(f'{total} MR из {len(projects) - empty} проектов за {time.time()-t0:.0f} c '
      f'({empty} проектов без единого MR) → {OUT}')
