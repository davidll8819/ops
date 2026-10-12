"""Recover exact old skill names from the same publisher's Git history; no install."""
import importlib.util, json, subprocess, concurrent.futures, csv
from pathlib import PurePosixPath
spec=importlib.util.spec_from_file_location('catalog_downloader', __file__.replace('recover-skill-downloads.py','download-skill-catalog.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

def recover(source, names):
    repo=m.CACHE/(source.replace('/','--')+'-history')
    existing=m.CACHE/'mattpocock-history'
    if source=='mattpocock/skills' and existing.exists():repo=existing
    if not repo.exists():
        p=subprocess.run(['git','-c','core.hooksPath=/dev/null','clone','--quiet','--filter=blob:none','--no-checkout',f'https://github.com/{source}.git',str(repo)],capture_output=True,text=True,timeout=180)
        if p.returncode:raise ValueError(p.stderr[:160])
    log=subprocess.check_output(['git','-C',str(repo),'log','--all','--diff-filter=AM','--no-renames','--format=commit:%H','--name-only','--','**/SKILL.md','SKILL.md'],text=True)
    choices={};commit=None
    for line in log.splitlines():
        if line.startswith('commit:'):commit=line[7:]
        elif line.endswith('/SKILL.md'):
            name=PurePosixPath(line).parent.name
            if name in names and name not in choices:choices[name]=(commit,line)
    result={}
    for name,(commit,path) in choices.items():
        archive=m.PACK/(source.replace('/','--')+'--'+commit[:12]+'.zip')
        url=f'https://codeload.github.com/{source}/zip/{commit}'
        try:
            data=archive.read_bytes() if archive.exists() else m.fetch(url,archive)
            docs=m.archive_skills(data)
            matched=[d for d in docs if d['path'].split('/',1)[-1]==path]
            if len(matched)!=1 or matched[0]['name']!=name:continue
            doc=matched[0]
            result[name]={'status':'downloaded','packagePath':archive.relative_to(m.ROOT).as_posix(),'sha256':m.sha(data),'packageBytes':len(data),'sourceUrl':url,'skillFile':doc['path'],'skillRoot':str(PurePosixPath(doc['path']).parent),'declaredName':name,'match':'frontmatter','skillSha256':doc['hash'],'historical':True,'commit':commit}
        except Exception as e:print('RECOVERY ERROR',source,name,str(e)[:120],flush=True)
    return result

def main():
    c=json.loads((m.CAT/'catalog.json').read_text());groups={}
    for item in c['items']:
        if item['download'].get('error')=='source_skill_not_found' and '/' in item['source'] and item['source']+'/'+item['name'] not in (json.loads((m.CACHE/'recoveries.json').read_text()) if (m.CACHE/'recoveries.json').exists() else {}):groups.setdefault(item['source'],set()).add(item['name'])
    changes=json.loads((m.CACHE/'recoveries.json').read_text()) if (m.CACHE/'recoveries.json').exists() else {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures={pool.submit(recover,s,n):(s,n) for s,n in groups.items()}
        for f in concurrent.futures.as_completed(futures):
            source,names=futures[f]
            try:r=f.result()
            except Exception as e:r={};print('FAILED',source,str(e)[:160],flush=True)
            for name,data in r.items():changes[source+'/'+name]=data
            (m.CACHE/'recoveries.json').write_text(json.dumps(changes,indent=2)+'\n')
            print('RECOVERED',source,len(r),'/',len(names),flush=True)
if __name__=='__main__':main()
