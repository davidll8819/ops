"""Verify every CSV-to-package mapping without unpacking or executing downloaded code."""
import csv,json,hashlib,zipfile,re
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
CAT=ROOT/'skills/catalog'
rows=list(csv.DictReader((CAT/'skills-directory-zh.csv').open(encoding='utf-8-sig')))
catalog=json.loads((CAT/'catalog.json').read_text())
items=catalog['items'];assert len(items)==len(rows)
assert len({i['id'] for i in items})==len(items)
archives={};digests={}
for row,item in zip(rows,items):
    assert int(row['序号'])==item['number']
    for source,target in [('英文名称','name'),('中文释义','descriptionZh'),('发布来源','source'),('整理分类','category'),('详情链接','detailUrl'),('释义依据','descriptionBasis')]:assert row[source]==item[target]
    assert hashlib.sha256(row['详情链接'].encode()).hexdigest()[:24]==item['id']
    d=item['download']
    if d['status']!='downloaded':continue
    path=(ROOT/d['packagePath']).resolve()
    assert path.is_relative_to((ROOT/'skills/packages').resolve()) and path.suffix=='.zip'
    if path not in archives:
        digests[path]=hashlib.sha256(path.read_bytes()).hexdigest()
        archives[path]=zipfile.ZipFile(path)
        bad=archives[path].testzip();assert bad is None,(path,bad)
    assert digests[path]==d['sha256']
    text=archives[path].read(d['skillFile']).decode('utf-8-sig',errors='replace')
    assert hashlib.sha256(text.encode()).hexdigest()==d['skillSha256']
    assert text.strip()
    if d.get('match')=='frontmatter':
        header=text.split('---',2)[1]
        name=re.search(r'^name:\s*[\'\"]?([^\r\n\'\"]+)',header,re.M)
        assert name and name[1].strip()==item['name']
    if d.get('match')=='frontmatter-slug':
        slug=re.search(r'^slug:\s*(.+)$',text.split('---',2)[1],re.M)
        assert slug and slug[1].strip()==item['name']
for z in archives.values():z.close()
for kind in ['capabilities','workflows']:
    assert {p.name for p in (ROOT/'skills'/kind).iterdir() if p.is_dir()} <= {'_template'}, 'Unexpected installed skill directory'
print(json.dumps({'directoryRows':len(items),'downloaded':sum(i['download']['status']=='downloaded' for i in items),'unavailable':sum(i['download']['status']!='downloaded' for i in items),'archivesVerified':len(archives),'installed':0},ensure_ascii=False))
