"""Windows parallel/range downloader; official URLs and index SHA256 only."""
from concurrent.futures import ThreadPoolExecutor,as_completed
import hashlib
import json
import os
from pathlib import Path
import time
import urllib.request

ROOT=Path(__file__).resolve().parents[1]
TOOLS=ROOT/'.tools'/'arduino'
CHUNK=8*1024*1024


def sha(path):
    digest=hashlib.sha256()
    with path.open('rb') as stream:
        while block:=stream.read(1024*1024): digest.update(block)
    return digest.hexdigest()


def archives():
    packages=[]
    for name in ('package_index.json','package_esp32_index.json'):
        packages+=json.loads((TOOLS/'data'/name).read_text())['packages']
    esp=next(item for item in packages if item['name']=='esp32')
    platform=next(item for item in esp['platforms'] if item['version']=='3.3.12')
    chosen=[platform]
    preference=['x86_64-pc-linux-gnu','x86_64-linux-gnu','x86_64-linux','i686-linux-gnu']
    for dependency in platform['toolsDependencies']:
        package=next(item for item in packages if item['name']==dependency['packager'])
        tool=next(item for item in package['tools'] if item['name']==dependency['name'] and item['version']==dependency['version'])
        system=next((system for host in preference for system in tool['systems'] if system['host']==host),None)
        if not system: raise RuntimeError('Linux archive not found: '+dependency['name'])
        chosen.append(system)
    return [{'url':item['url'],'name':item['archiveFileName'],'size':int(item['size']),'sha256':item['checksum'].split(':',1)[1].lower()} for item in chosen]


def download_part(item,index):
    target=TOOLS/'downloads'/'packages'/item['name']
    part=target.with_name(target.name+f'.part-{index}')
    start=index*CHUNK;end=min(start+CHUNK,item['size'])-1
    expected=end-start+1
    if part.exists() and part.stat().st_size==expected: return
    for attempt in range(4):
        try:
            request=urllib.request.Request(item['url'],headers={'Range':f'bytes={start}-{end}','User-Agent':'AE-Firmware-Cache/1.0'})
            with urllib.request.urlopen(request,timeout=180) as response:
                content_range=response.headers.get('Content-Range','')
                if response.status!=206 or not content_range.startswith(f'bytes {start}-{end}/'):
                    raise RuntimeError(f'range not honored: {response.status} {content_range}')
                with part.open('wb') as stream:
                    while block:=response.read(1024*1024): stream.write(block)
            if part.stat().st_size!=expected: raise RuntimeError('truncated range response')
            return
        except Exception:
            if attempt==3: raise
            time.sleep(1+attempt)


def main():
    (TOOLS/'downloads'/'packages').mkdir(parents=True,exist_ok=True)
    items=archives()
    (TOOLS/'cache-download-manifest.json').write_text(json.dumps(items,indent=2),encoding='utf-8')
    pending=[];complete=[]
    for item in items:
        target=TOOLS/'downloads'/'packages'/item['name']
        if target.is_file() and target.stat().st_size==item['size'] and sha(target)==item['sha256']: complete.append(item)
        else: pending.append(item)
    print(f'Official archives: {len(items)}, reuse verified: {len(complete)}, pending bytes: {sum(item["size"] for item in pending)}',flush=True)
    jobs=[(item,index) for item in pending for index in range((item['size']+CHUNK-1)//CHUNK)]
    started=time.monotonic()
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures={pool.submit(download_part,item,index):(item,index) for item,index in jobs}
        for count,future in enumerate(as_completed(futures),1):
            future.result()
            item,index=futures[future]
            print(f'Range {count}/{len(jobs)} verified-length: {item["name"]} part={index}, elapsed={time.monotonic()-started:.1f}s',flush=True)
    for item in pending:
        target=TOOLS/'downloads'/'packages'/item['name']
        assembled=target.with_name(target.name+'.assembling')
        with assembled.open('wb') as destination:
            for index in range((item['size']+CHUNK-1)//CHUNK):
                part=target.with_name(target.name+f'.part-{index}')
                with part.open('rb') as source:
                    while block:=source.read(1024*1024): destination.write(block)
        if sha(assembled)!=item['sha256']: raise RuntimeError('official checksum mismatch: '+item['name'])
        os.replace(assembled,target)
        for index in range((item['size']+CHUNK-1)//CHUNK): target.with_name(target.name+f'.part-{index}').unlink()
        print('SHA256 VERIFIED '+item['name'],flush=True)
    print('All official Linux archives ready for WSL cached install',flush=True)


if __name__=='__main__': main()
