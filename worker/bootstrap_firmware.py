"""Explicit one-time setup, confined to the approved project's .tools/arduino."""
import hashlib
import argparse
import json
import os
from pathlib import Path
import subprocess
import tarfile
import urllib.request

ROOT=Path(__file__).resolve().parents[1]
TOOLS=ROOT/'.tools'/'arduino'
DATA=Path.home()/'.arduino15'
CLI_VERSION='1.5.1'
CORE_VERSION='3.3.12'
CLI_SHA256='28a8e119c498a25607821c36cb2dc49e8463941b261a0d99091baa7bc692dd2b'
LIBRARY_VERSION='7.4.3'


def run(arguments, environment):
    print('RUN '+ ' '.join(map(str,arguments)),flush=True)
    process=subprocess.run(list(map(str,arguments)),env=environment)
    if process.returncode: raise RuntimeError('tool setup command failed: '+str(process.returncode))


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--cached',action='store_true',help='Use existing indexes and SHA-verified archive cache; do not refresh indexes')
    arguments=parser.parse_args()
    for name in ('bin','data','downloads','user','cache','tmp'):
        (TOOLS/name).mkdir(parents=True,exist_ok=True)
    archive=TOOLS/'downloads'/f'arduino-cli_{CLI_VERSION}_Linux_64bit.tar.gz'
    url=f'https://downloads.arduino.cc/arduino-cli/arduino-cli_{CLI_VERSION}_Linux_64bit.tar.gz'
    if not archive.exists():
        print('Downloading '+url,flush=True)
        with urllib.request.urlopen(url,timeout=60) as response,archive.with_suffix('.part').open('wb') as stream:
            while True:
                block=response.read(1024*1024)
                if not block: break
                stream.write(block)
        archive.with_suffix('.part').replace(archive)
    actual=hashlib.sha256(archive.read_bytes()).hexdigest()
    if actual!=CLI_SHA256: raise RuntimeError('Arduino CLI checksum mismatch')
    with tarfile.open(archive,'r:gz') as source:
        executable=source.extractfile('arduino-cli')
        (TOOLS/'bin'/'arduino-cli').write_bytes(executable.read())
    (TOOLS/'bin'/'arduino-cli').chmod(0o755)
    config=TOOLS/'arduino-cli.yaml'
    DATA.mkdir(parents=True,exist_ok=True)
    if arguments.cached:
        import shutil
        for name in ('package_index.json','package_index.json.sig','package_esp32_index.json','library_index.json','library_index.json.sig'):
            source=TOOLS/'data'/name
            if source.is_file(): shutil.copyfile(source,DATA/name)
    config.write_text('board_manager:\n  additional_urls:\n    - https://espressif.github.io/arduino-esp32/package_esp32_index.json\ndirectories:\n'+''.join('  '+key+': '+json.dumps(str(path),ensure_ascii=False)+'\n' for key,path in [('data',DATA),('downloads',TOOLS/'downloads'),('user',TOOLS/'user')])+'network:\n  connection_timeout: 120s\n',encoding='utf-8')
    environment=dict(os.environ,TMPDIR=str(TOOLS/'tmp'))
    command=[TOOLS/'bin'/'arduino-cli','--config-file',config]
    run(command+['version'],environment)
    if not arguments.cached:
        run(command+['core','update-index'],environment)
    elif not all((DATA/name).is_file() for name in ('package_index.json','package_esp32_index.json')):
        raise RuntimeError('cached installation requires existing official indexes')
    library_version=LIBRARY_VERSION
    run(command+['lib','install','ArduinoJson@'+library_version],environment)
    # Install the portable library before the large ESP32 platform download so
    # native C++/PTY verification can proceed while cross tools are downloading.
    manifest={'cli_version':CLI_VERSION,'cli_archive_sha256':actual,'core_version':CORE_VERSION,'arduinojson_version':library_version,'core_installed':False,'environment':'WSL Ubuntu-22.04','download_source':url,'data_directory':str(DATA),'platform_file':str(DATA/'packages'/'esp32'/'hardware'/'esp32'/CORE_VERSION/'platform.txt'),'data_storage':'Ubuntu-22.04 VHD at D:/WSL/Ubuntu-22.04; native ext4 default Arduino directory'}
    (TOOLS/'toolchain.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
    run(command+['core','install','esp32:esp32@'+CORE_VERSION],environment)
    manifest['core_installed']=True
    if not Path(manifest['platform_file']).is_file(): raise RuntimeError('installed platform.txt is missing')
    manifest['installed_platform_size']=Path(manifest['platform_file']).stat().st_size
    from datetime import datetime,timezone
    manifest['verified_at']=datetime.now(timezone.utc).isoformat()
    (TOOLS/'toolchain.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
    run(command+['core','list'],environment)


if __name__=='__main__': main()
