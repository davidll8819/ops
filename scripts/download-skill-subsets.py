"""Fetch just skill trees when a source repository archive is too large; no execution."""
import importlib.util,json,zipfile,io,concurrent.futures
from pathlib import PurePosixPath
from urllib.parse import quote
spec=importlib.util.spec_from_file_location('downloads',__file__.replace('download-skill-subsets.py','download-skill-catalog.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

def subset(source, rows, ref="HEAD", folder_names=None):
    treeurl=f'https://api.github.com/repos/{source}/git/trees/{ref}?recursive=1'
    treefile=m.CACHE/(source.replace('/','--')+('-tree.json' if ref=='HEAD' else '-'+ref[:12]+'-tree.json'))
    blob=treefile.read_bytes() if treefile.exists() else m.fetch(treeurl,treefile,20_000_000)
    tree=json.loads(blob)
    if tree.get('truncated'):raise ValueError('Repository tree is truncated')
    commit=tree['sha'];files=[e for e in tree['tree'] if e['type']=='blob' and e.get('mode')!='120000' and not any(part in {'tests','test','fixtures'} for part in PurePosixPath(e['path']).parts)]
    names=set(folder_names or [r['英文名称'] for r in rows])
    roots={str(PurePosixPath(e['path']).parent) for e in files if e['path'].endswith('/SKILL.md') and PurePosixPath(e['path']).parent.name in names}
    if not roots:raise ValueError('No matching skill folders in current tree')
    # Choose a canonical authored skill tree, avoiding platform duplicates and test fixtures.
    preferred=set()
    for name in names:
        candidates=[root for root in roots if PurePosixPath(root).name==name]
        if not candidates:continue
        for prefix in ['skills/','source/skills/','.agents/skills/','plugin/skills/']:
            canonical=prefix+name
            if canonical in candidates:preferred.add(canonical);break
        else:preferred.update(candidates)
    roots=preferred
    chosen=[e for e in files if any(e['path'].startswith(root+'/') for root in roots) or (len(PurePosixPath(e['path']).parts)==1 and e['path'].upper().startswith(('LICENSE','NOTICE','COPYING')))]
    if sum(e.get('size',0) for e in chosen)>150_000_000:raise ValueError('Selected skill files exceed size limit')
    def get(e):
        path=e['path'];url=f'https://raw.githubusercontent.com/{source}/{commit}/{quote(path,safe="/")}'
        dest=m.CACHE/(m.sha(url.encode())+'.data')
        data=dest.read_bytes() if dest.exists() else m.fetch(url,dest,30_000_000)
        import hashlib
        if hashlib.sha1(b'blob '+str(len(data)).encode()+b'\x00'+data).hexdigest()!=e['sha']:raise ValueError('Git blob checksum mismatch')
        return path,data
    buf=io.BytesIO()
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        results=list(pool.map(get,chosen))
    with zipfile.ZipFile(buf,'w',zipfile.ZIP_DEFLATED) as z:
        for path,data in results:z.writestr('source/'+path,data)
    archive=m.PACK/(source.replace('/','--')+('--skills.zip' if ref=='HEAD' else '--'+ref[:12]+'--skills.zip'));data=buf.getvalue();archive.write_bytes(data)
    docs=m.archive_skills(data);out={}
    for row in rows:
        matches=[d for d in docs if d['name']==row['英文名称']]
        if len(matches)>1:
            for prefix in ['source/skills/','source/source/skills/','source/.agents/skills/','source/plugin/skills/']:
                preferred=[d for d in matches if d['path']==prefix+row['英文名称']+'/SKILL.md']
                if len(preferred)==1:matches=preferred;break
        if len(matches)!=1:continue
        d=matches[0]
        out[source+'/'+row['英文名称']]={'status':'downloaded','packagePath':archive.relative_to(m.ROOT).as_posix(),'sha256':m.sha(data),'packageBytes':len(data),'sourceUrl':treeurl,'skillFile':d['path'],'skillRoot':str(PurePosixPath(d['path']).parent),'declaredName':d['name'],'match':'frontmatter','skillSha256':d['hash'],'commit':commit,'packageScope':'skill-folders-and-root-license'}
    return out

def main():
    catalog=json.loads((m.CAT/'catalog.json').read_text());wanted={i['source'] for i in catalog['items'] if 'timed out' in i['download'].get('error','')};wanted.discard('heygen-com/hyperframes')
    # Source archives are fetched in parallel by the main downloader; retry only completed failures.
    changes={}
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        futures={pool.submit(subset,s,[r for r in m.ROWS if r['发布来源']==s]):s for s in wanted}
        for f in concurrent.futures.as_completed(futures):
            s=futures[f]
            try:out=f.result();changes.update(out);print(s,len(out),'recovered',flush=True)
            except Exception as e:print(s,'FAILED',str(e)[:180],flush=True)
            (m.CACHE/'subset-recoveries.json').write_text(json.dumps(changes,indent=2)+'\n')
if __name__=='__main__':main()
