"""Download source archives and map CSV rows to SKILL.md. Never install or execute skills."""
import csv, json, hashlib, re, subprocess, zipfile, io, time, posixpath
from pathlib import Path, PurePosixPath
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse, urljoin, quote

ROOT = Path(__file__).resolve().parents[1]
CAT = ROOT / 'skills/catalog'
PACK = ROOT / 'skills/packages'
CACHE = ROOT / '.local/skill-downloads'
for d in [CAT, PACK, CACHE]: d.mkdir(parents=True, exist_ok=True)
ROWS = list(csv.DictReader((CAT/'skills-directory-zh.csv').open(encoding='utf-8-sig')))
MAX_DOWNLOAD = 150_000_000

def sha(data): return hashlib.sha256(data).hexdigest()
def safe_path(path):
    return bool(path) and not path.startswith('/') and '\\' not in path and '\x00' not in path and all(p not in {'.','..'} for p in path.split('/'))
def fetch(url, dest, limit=MAX_DOWNLOAD):
    parsed=urlparse(url)
    if parsed.scheme != 'https' or parsed.username or parsed.password: raise ValueError('Unsupported URL')
    tmp=dest.with_suffix(dest.suffix+'.part')
    result=subprocess.run(['curl','--fail','--silent','--show-error','--location','--proto','=https','--proto-redir','=https','--max-time','150','--connect-timeout','15','--max-filesize',str(limit),url,'-o',str(tmp)],capture_output=True,text=True)
    if result.returncode:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(result.stderr.strip()[:240])
    if tmp.stat().st_size>limit: tmp.unlink(); raise ValueError('Download too large')
    tmp.replace(dest)
    return dest.read_bytes()
def frontmatter(text):
    if not text.startswith('---'): return {}
    match=re.search(r'^name:\s*[\'\"]?([^\r\n\'\"]+)',text.split('---',2)[1],re.M)
    return {'name':match[1].strip()} if match else {}
def archive_skills(data):
    z=zipfile.ZipFile(io.BytesIO(data))
    docs=[]
    if sum(i.file_size for i in z.infolist())>1_000_000_000: raise ValueError('Archive expanded size exceeds limit')
    for info in z.infolist():
        if info.filename.endswith('/SKILL.md') or info.filename=='SKILL.md':
            if not safe_path(info.filename) or info.file_size>2_000_000: continue
            if any(part in {'tests','test','fixtures'} for part in PurePosixPath(info.filename).parts):continue
            content=z.read(info).decode('utf-8-sig',errors='replace')
            if not content.strip():continue
            docs.append({'path':info.filename,'name':frontmatter(content).get('name'),'hash':sha(content.encode())})
    return docs

def github(source, rows):
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+',source): raise ValueError('Invalid GitHub source')
    path=PACK/(source.replace('/','--')+'.zip')
    url=f'https://codeload.github.com/{source}/zip/HEAD'
    if not path.exists():
        cached=CACHE/(source.replace('/','--')+'.zip')
        if cached.exists():path.write_bytes(cached.read_bytes())
        else:fetch(url,path)
    data=path.read_bytes();docs=archive_skills(data);digest=sha(data)
    output=[]
    for row in rows:
        name=row['英文名称']
        exact=[d for d in docs if d['name']==name]
        candidates=exact or [d for d in docs if PurePosixPath(d['path']).parent.name==name]
        if not candidates:
            output.append((row,{'status':'failed','error':'source_skill_not_found'}));continue
        if len(set(d['hash'] for d in candidates))>1:
            # Prefer the actual named skill directory over demos with copied frontmatter.
            named=[d for d in candidates if PurePosixPath(d['path']).parent.name==name]
            if len(named)==1:candidates=named
            else:
                output.append((row,{'status':'failed','error':'ambiguous_skill_paths','candidates':[d['path'] for d in candidates]}));continue
        doc=sorted(candidates,key=lambda d:(len(d['path']),d['path']))[0]
        output.append((row,{'status':'downloaded','packagePath':path.relative_to(ROOT).as_posix(),'sha256':digest,'packageBytes':len(data),'sourceUrl':url,'skillFile':doc['path'],'skillRoot':str(PurePosixPath(doc['path']).parent),'declaredName':doc['name'],'match':'frontmatter' if exact else 'directory','skillSha256':doc['hash']}))
    return output

def wellknown(source, rows):
    if source not in {'open.feishu.cn','uizze.sh','agent.qq.com','cli.sentry.dev'}:raise ValueError('Unsupported publisher')
    index=None
    for prefix in ['.well-known/agent-skills','.well-known/skills']:
        indexurl=f'https://{source}/{prefix}/index.json'
        try:
            data=fetch(indexurl,CACHE/(source+'.json'),5_000_000)
            candidate=json.loads(data)
            if isinstance(candidate.get('skills'),list):index=candidate;break
        except Exception:continue
    if index is None:raise RuntimeError('Publisher discovery index unavailable')
    output=[]
    for row in rows:
        name=row['英文名称'];entries=[e for e in index['skills'] if e.get('name')==name]
        if len(entries)!=1:
            output.append((row,{'status':'failed','error':'source_skill_not_found'}));continue
        entry=entries[0]
        path=PACK/(source+'--'+name+'.zip')
        try:
            files={}
            if 'files' in entry:
                for rel in entry['files']:
                    if not safe_path(rel):raise ValueError('Unsafe artifact path')
                    url=f'https://{source}/{prefix}/{quote(name)}/{quote(rel,safe="/")}'
                    files[rel]=fetch(url,CACHE/(sha(url.encode())+'.data'),30_000_000)
                buf=io.BytesIO()
                with zipfile.ZipFile(buf,'w',zipfile.ZIP_DEFLATED) as z:
                    for rel,value in files.items():z.writestr(rel,value)
                data=buf.getvalue();sourceurl=indexurl
            else:
                sourceurl=urljoin(indexurl,entry['url'])
                if urlparse(sourceurl).hostname!=source:raise ValueError('Cross-host artifact requires review')
                blob=fetch(sourceurl,CACHE/(sha(sourceurl.encode())+'.data'))
                if entry.get('digest')!='sha256:'+sha(blob):raise ValueError('Publisher digest mismatch')
                if entry['type']=='skill-md':
                    buf=io.BytesIO()
                    with zipfile.ZipFile(buf,'w',zipfile.ZIP_DEFLATED) as z:z.writestr('SKILL.md',blob)
                    data=buf.getvalue()
                else:data=blob
            docs=archive_skills(data)
            matches=[d for d in docs if d['name']==name]
            if len(matches)!=1:raise ValueError('Skill identity not verified')
            path.write_bytes(data);doc=matches[0]
            output.append((row,{'status':'downloaded','packagePath':path.relative_to(ROOT).as_posix(),'sha256':sha(data),'packageBytes':len(data),'sourceUrl':sourceurl,'skillFile':doc['path'],'skillRoot':str(PurePosixPath(doc['path']).parent),'declaredName':doc['name'],'match':'frontmatter','skillSha256':doc['hash']}))
        except Exception as e:output.append((row,{'status':'failed','error':str(e)[:240]}))
    return output

def make_record(row, result):
    return {'id':sha(row['详情链接'].encode())[:24], 'number':int(row['序号']), 'category':row['整理分类'], 'name':row['英文名称'],'descriptionZh':row['中文释义'],'source':row['发布来源'],'sameNameCount':int(row['同名条目数']),'detailUrl':row['详情链接'],'descriptionBasis':row['释义依据'],'kind':'capability','download':result}

def main():
    groups={}
    for r in ROWS:groups.setdefault(r['发布来源'],[]).append(r)
    records=[]
    with ThreadPoolExecutor(max_workers=6) as executor:
        futures={executor.submit(github if '/' in source else wellknown,source,rows):(source,rows) for source,rows in groups.items()}
        for future in as_completed(futures):
            source,rows=futures[future]
            try:results=future.result()
            except Exception as e:results=[(r,{'status':'failed','error':str(e)[:240]}) for r in rows]
            records.extend(make_record(r,result) for r,result in results)
            document={'schemaVersion':1,'sourceFile':'skills-directory-zh.csv','generatedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'items':sorted(records,key=lambda r:r['number'])}
            tmp=CAT/'catalog.json.tmp';tmp.write_text(json.dumps(document,ensure_ascii=False,indent=2)+'\n');tmp.replace(CAT/'catalog.json')
            print(f'{source}: {sum(x[1]["status"]=="downloaded" for x in results)}/{len(results)} ({len(records)}/600)',flush=True)
    print('DONE',sum(x['download']['status']=='downloaded' for x in records),len(records),flush=True)
if __name__=='__main__':main()
