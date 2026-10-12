"""Merge verified downloads and source descriptions; never install or execute skill code."""
import importlib.util,json,zipfile,re,time
spec=importlib.util.spec_from_file_location('downloads',__file__.replace('finalize-skill-catalog.py','download-skill-catalog.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

def description(text):
    if not text.startswith('---'):return ''
    header=text.split('---',2)[1]
    match=re.search(r'^description:\s*(.*?)(?=\n[^\s#][^\n]*:|\Z)',header,re.M|re.S)
    if not match:return ''
    value=match[1].strip()
    if value.startswith(('>','|')):value=value.split('\n',1)[-1]
    value=' '.join(value.split()).strip('\"\'')
    return value if value and re.search('[A-Za-z]',value) and not re.search('[\u4e00-\u9fff]',value) else ''

def main():
    path=m.CAT/'catalog.json';catalog=json.loads(path.read_text())
    assert len(catalog['items'])==len(m.ROWS),'Wait for initial download to finish before merging'
    updates={}
    for filename in ['recoveries.json','subset-recoveries.json','remaining-recoveries.json','extra-recoveries.json','hyperframes-recoveries.json','impeccable-recoveries.json','removed-recoveries.json','final-two-recoveries.json']:
        f=m.CACHE/filename
        if f.exists():updates.update(json.loads(f.read_text()))
    archives={}
    translations=json.loads((m.CAT/'description-translations.en.json').read_text())
    for item in catalog['items']:
        key=item['source']+'/'+item['name']
        if key in updates and updates[key]['status']=='downloaded':item['download']=updates[key]
        d=item['download']
        if d['status']=='downloaded':
            p=d['packagePath']
            if p not in archives:archives[p]=zipfile.ZipFile(m.ROOT/p)
            text=archives[p].read(d['skillFile']).decode('utf-8-sig',errors='replace')
            english=description(text)
            if english:item['descriptionEn']=english;item['descriptionEnBasis']='source-frontmatter'
        if item['name'] in translations and (not item.get('descriptionEn') or item.get('descriptionEnBasis')=='skill-name'):
            item['descriptionEn']=translations[item['name']];item['descriptionEnBasis']='translated-csv-label'
        if not item.get('descriptionEn'):item['descriptionEn']=item['name'].replace('-',' ');item['descriptionEnBasis']='skill-name'
    for z in archives.values():z.close()
    catalog['generatedAt']=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
    tmp=path.with_suffix('.json.tmp');tmp.write_text(json.dumps(catalog,ensure_ascii=False,indent=2)+'\n');tmp.replace(path)
    items=catalog['items'];downloaded=[i for i in items if i['download']['status']=='downloaded']
    report={'generatedAt':catalog['generatedAt'],'directoryRows':len(items),'downloaded':len(downloaded),'installed':0,'executed':0,'uniqueArchives':len({i['download']['packagePath'] for i in downloaded}),'historicalVersions':sum(bool(i['download'].get('historical')) for i in downloaded),'englishSourceDescriptions':sum(i['descriptionEnBasis']=='source-frontmatter' for i in items),'englishTranslatedLabels':sum(i['descriptionEnBasis']=='translated-csv-label' for i in items),'englishNameFallbacks':sum(i['descriptionEnBasis']=='skill-name' for i in items),'unavailable':[{'number':i['number'],'name':i['name'],'source':i['source'],'error':i['download'].get('error')} for i in items if i['download']['status']!='downloaded']}
    (m.CAT/'download-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(json.dumps(report,ensure_ascii=False))
if __name__=='__main__':main()
