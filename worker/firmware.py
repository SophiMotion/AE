"""Fixed ESP32 cross compiler and explicitly native protocol-core verification."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

ROOT=Path(__file__).resolve().parents[1]
TOOLS=ROOT/'.tools'/'arduino'
SOURCES=Path(__file__).parent
FQBNS={'esp32':'esp32:esp32:esp32','esp32s3':'esp32:esp32:esp32s3'}
CORE_VERSION='3.3.12'
LIBRARY_VERSION='7.4.3'


def probe_firmware_toolchain():
    """Safe on Windows as a manifest view; live executable probe on WSL."""
    result={'available':False,'environment':'WSL Ubuntu-22.04','core_version':CORE_VERSION,'arduinojson_version':LIBRARY_VERSION,'supported_boards':dict(FQBNS),'flashed':False,'esp32_execution_verified':False,'physical_verified':False}
    manifest=TOOLS/'toolchain.json'
    try:
        result.update(json.loads(manifest.read_text(encoding='utf-8')))
        result.update(flashed=False,esp32_execution_verified=False,physical_verified=False)
        shared_present=(TOOLS/'bin'/'arduino-cli').is_file() and (TOOLS/'user'/'libraries'/'ArduinoJson'/'src'/'ArduinoJson.h').is_file()
        platform=Path(result.get('platform_file',str(TOOLS/'data'/'packages'/'esp32'/'hardware'/'esp32'/CORE_VERSION/'platform.txt')))
        platform_present=platform.is_file() if os.name=='posix' else bool(result.get('installed_platform_size',0)>0 and result.get('verified_at'))
        result['available']=bool(result.get('core_installed') and shared_present and platform_present)
        if os.name=='posix' and result['available']:
            process=subprocess.run([str(TOOLS/'bin'/'arduino-cli'),'version'],capture_output=True,text=True,timeout=10)
            result['available']=process.returncode==0 and '1.5.1' in process.stdout
            result['cli_output']=process.stdout.strip()
        result['probe_scope']='live_cli_and_installed_paths' if os.name=='posix' else 'verified_WSL_install_manifest_and_shared_project_paths'
    except (OSError,ValueError,subprocess.SubprocessError) as error:
        result['error']=str(error)
    return result


def validate_hardware(hardware,kind):
    board=hardware.get('board')
    if board not in FQBNS:
        if board in (None,'未指定（模拟）','unspecified') and hardware.get('transport','simulated')=='simulated': return False
        raise ValueError('unsupported firmware board; choose esp32 or esp32s3')
    if hardware.get('transport') not in ('serial_jsonl','simulated'): raise ValueError('unsupported firmware transport')
    if hardware.get('physical_io',False) is not False: raise ValueError('physical IO is disabled')
    if hardware.get('baudrate',115200)!=115200: raise ValueError('only serial 115200 is supported')
    actuator='virtual_joint' if kind=='joint_position' else 'virtual_switch'
    sensor='simulated_encoder' if kind=='joint_position' else 'simulated_scalar'
    if hardware.get('actuator',actuator)!=actuator or hardware.get('sensor',sensor)!=sensor:
        raise ValueError('hardware actuator/sensor do not match approved task')
    return True


def generate_firmware(output,spec,firmware_code=None):
    base=output/'esp32';sketch=base/'ae_firmware';sketch.mkdir(parents=True,exist_ok=True)
    parameters=spec['parameters']
    source=(SOURCES/'ae_firmware.ino').read_text().replace('__JOINT__','true' if spec['task_type']=='joint_position' else 'false').replace('__THRESHOLD__',repr(parameters['threshold'])).replace('__LIMIT__',repr(parameters['max_velocity']))
    (sketch/'ae_firmware.ino').write_text(source,encoding='utf-8')
    v3=spec.get('pipeline_version')==3 or bool(spec.get('execution_model'))
    core_source=SOURCES/('protocol_core_v3.hpp' if v3 else 'protocol_core.hpp')
    shutil.copyfile(core_source,sketch/'protocol_core.hpp')
    shutil.copyfile(SOURCES/'host_protocol.cpp',base/'host_protocol.cpp')
    shutil.copyfile(core_source,base/'protocol_core.hpp')
    if v3:
        from .contract import project_contract
        from .device_logic import validate_device_logic
        if firmware_code is None: raise ValueError('V3 requires approved firmware_code')
        firmware_code=validate_device_logic(firmware_code)
        identity=project_contract(spec)['communication']['identity']
        model=spec.get('execution_model') or {};joint=next((j for j in model.get('joints',[]) if j['name']==model.get('selected_joint')),None)
        lower=joint['limits']['lower'] if joint else 0.0
        upper=joint['limits']['upper'] if joint else 1.0
        constants='#pragma once\n#define AE_PROTOCOL_V3 1\nstatic const ae::Binding ae_model_binding = {'+','.join([json.dumps(identity['joint_name']),json.dumps(identity['model_sha256']),json.dumps(identity['protocol_sha256']),repr(lower),repr(upper),'true' if spec['task_type']=='joint_position' else 'false'])+'};\n'
        for folder in (base,sketch):
            (folder/'model_binding.hpp').write_text(constants,encoding='utf-8')
            (folder/'device_logic.hpp').write_text('#pragma once\n'+firmware_code+'\n',encoding='utf-8')
    fqbn=FQBNS[spec['hardware']['board']]
    readme=f'''# ESP32 无实物测试固件

本固件使用虚拟关节/开关与模拟编码器/标量，不访问电机 GPIO 或真实传感器。编译目标 {fqbn} 是您选定的通用目标，不代表识别出实际板型。没有烧录、板端执行或实物动作验证。

Arduino CLI 1.5.1、ESP32 core 3.3.12、ArduinoJson 7.4.3。ae_firmware/protocol_core.hpp 与主机 PTY 测试使用同一源码；主机运行固件协议核心不等于 ESP32 芯片执行。实际编译命令、日志和产物 SHA256 在上一层 firmware-build.json、firmware-compile.log 中。

## 在本项目 WSL 工具链离线重新编译

从该轮目录（包含 esp32 的目录）执行，环境变量 AE_TOOLS 指向本项目已安装工具链：

```bash
AE_TOOLS="/mnt/d/Auto engineering/实际开发记录/.tools/arduino"
"$AE_TOOLS/bin/arduino-cli" --config-file "$AE_TOOLS/arduino-cli.yaml" compile --fqbn {fqbn} --jobs 1 --output-dir "$PWD/esp32/rebuilt-firmware" "$PWD/esp32/ae_firmware"
```

core 数据使用 WSL 默认 ~/.arduino15，编译缓存使用 ~/.cache/arduino；本机 Ubuntu-22.04 虚拟磁盘位于 D:\\WSL\\Ubuntu-22.04。项目 .tools/arduino/toolchain.json 记录实际路径；最终源码、日志与 BIN/ELF 均在项目目录。

若将 ZIP 带到另一台电脑，需先安装上述固定 CLI/core/library；ZIP 包含业务源码与固件产物，未打包约数 GB 的完整编译工具链。不要直接烧录到未知板型。今后拿到实物后，应先核对板型、Flash/PSRAM、供电、驱动与接线，再另行验证烧录、真实串口与设备行为。

串口波特率 115200，RX 命令为 JSONL {{seq,time,value}}；TX 状态为 {{kind:state,seq,time,value,applied,applied_seq}} 或事件 {{kind:event,event,seq,time,value,reason}}。每行最长 511 字节，严格递增序号、有限数值、600ms 失联清零，状态名义 20Hz。固件里的传感器值明确来自测试模型，不是真实测量。
'''
    if v3:
        old='串口波特率 115200，RX 命令为 JSONL {{seq,time,value}}；TX 状态为 {{kind:state,seq,time,value,applied,applied_seq}} 或事件 {{kind:event,event,seq,time,value,reason}}。每行最长 511 字节，严格递增序号、有限数值、600ms 失联清零，状态名义 20Hz。固件里的传感器值明确来自测试模型，不是真实测量。'.replace('{{','{').replace('}}','}')
        new='串口波特率 115200，V3 RX 必须为 JSONL {kind:command 或 measurement,seq,time,value,joint_name,model_sha256,protocol_sha256}；TX 状态/事件同样绑定后三个身份字段。每行最长 511 字节，拒绝未知/重复字段、错误身份和尾随垃圾。关节 measurement 来自 Gazebo 的所选关节，状态逐帧回传相同 seq/time/value，名义 20Hz；command 与 measurement 独立 600ms 失联清零。scalar 测试使用明确的软件序列；没有真实编码器、GPIO 或电机驱动。'
        readme=readme.replace(old,new)
    (base/'README.md').write_text(readme,encoding='utf-8')
    if v3:
        with (base/'README.md').open('a',encoding='utf-8') as stream:
            stream.write('\n## V3 同模型协议\n\n关节 '+identity['joint_name']+'；模型 SHA256 '+identity['model_sha256']+'；协议 SHA256 '+identity['protocol_sha256']+'。model_binding.hpp 固定这三个身份，ROS 与 UART 帧必须逐字段一致。joint_position 使用外部 measurement 帧读取 Gazebo 所选关节的绝对角；固件核心不自行积分位置。measurement 输入是软件测试台，并非编码器驱动。device_logic.hpp 是经受限验证的纯数值限幅函数；协议、失联保护和验收不由 AI 修改。\n')


def file_evidence(path,output):
    digest=hashlib.sha256()
    with path.open('rb') as stream:
        while True:
            block=stream.read(1024*1024)
            if not block: break
            digest.update(block)
    return {'path':str(path.relative_to(output)),'size':path.stat().st_size,'sha256':digest.hexdigest()}


def compile_firmware(spec,output,supervisor,environment):
    board=spec['hardware']['board'];fqbn=FQBNS[board]
    result={'passed':False,'board':board,'fqbn':fqbn,'core_version':CORE_VERSION,'arduinojson_version':LIBRARY_VERSION,'artifacts':[],'flashed':False,'esp32_execution_verified':False,'physical_verified':False}
    probe=probe_firmware_toolchain()
    if not probe['available']: raise RuntimeError('fixed Arduino toolchain unavailable; see .tools/firmware-toolchain-install.log')
    artifacts=output/'esp32'/'artifacts'/board
    artifacts.mkdir(parents=True,exist_ok=True)
    command=[str(TOOLS/'bin'/'arduino-cli'),'--config-file',str(TOOLS/'arduino-cli.yaml'),'compile','--fqbn',fqbn,'--jobs','1','--warnings','all','--output-dir',str(artifacts),str(output/'esp32'/'ae_firmware')]
    result['command']=command;result['source']=file_evidence(output/'esp32'/'ae_firmware'/'ae_firmware.ino',output)
    result['protocol_core']=file_evidence(output/'esp32'/'ae_firmware'/'protocol_core.hpp',output)
    if spec.get('pipeline_version')==3 or spec.get('execution_model'):
        from .contract import project_contract
        result['identity']=project_contract(spec)['communication']['identity']
        result['device_logic']=file_evidence(output/'esp32'/'ae_firmware'/'device_logic.hpp',output)
        result['model_binding']=file_evidence(output/'esp32'/'ae_firmware'/'model_binding.hpp',output)
    result['log']='firmware-compile.log'
    result['build_storage']='Arduino CLI default native WSL ~/.cache/arduino; Ubuntu VHD remains D:; final artifacts and logs in project'
    compiler_environment=dict(environment,TMPDIR=str(TOOLS/'tmp'))
    result['exit_code']=supervisor.run(command,output/'firmware-compile.log',compiler_environment,timeout=600)
    result['artifacts']=[file_evidence(path,output) for path in artifacts.iterdir() if path.is_file()]
    result['passed']=result['exit_code']==0 and any(item['path'].endswith('.bin') and item['size']>0 for item in result['artifacts']) and any(item['path'].endswith('.elf') and item['size']>0 for item in result['artifacts'])
    if not result['passed']:
        log=(output/'firmware-compile.log').read_text(encoding='utf-8',errors='replace')
        result['failure_scope']='firmware_code' if any('device_logic.' in line and ('error:' in line or 'fatal error:' in line) for line in log.splitlines()) else 'firmware'
    (output/'firmware-build.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    return result


def compile_host_core(output,supervisor,environment):
    library=TOOLS/'user'/'libraries'/'ArduinoJson'/'src'
    if not (library/'ArduinoJson.h').is_file(): raise RuntimeError('ArduinoJson 7.4.3 portable library is not installed')
    command=['g++','-std=c++17','-O2','-Wall','-Wextra','-Werror','-I',str(library),str(output/'esp32'/'host_protocol.cpp'),'-o',str(output/'esp32'/'host_protocol')]
    result=supervisor.run(command,output/'protocol-host-build.log',environment,timeout=45)
    if result: raise RuntimeError('native protocol core build failed; see protocol-host-build.log')
    return {'scope':'native_cpp_shared_protocol_not_esp32_execution','command':command,'exit_code':result,'core':file_evidence(output/'esp32'/'protocol_core.hpp',output),'binary':file_evidence(output/'esp32'/'host_protocol',output)}


def verify_device_logic(output,supervisor,environment):
    """Trusted fixed tests of the AI function, including out-of-domain clamp.

    Firmware parser rejects unsafe commands BEFORE calling the function. This
    separate native harness checks the pure function's complete numerical
    semantics without weakening that parser or performing any device IO.
    """
    source=output/'esp32'/'device_logic_check.cpp';binary=source.with_suffix('')
    source.write_text('''#include <cmath>
#include <cstdio>
#include "device_logic.hpp"
int main() {
  const double limits[]={0.1,0.8,1.0,2.0};
  unsigned failures=0;
  for(double limit:limits) {
    const double values[]={-2*limit,-limit,-limit/2,0,limit/2,limit,2*limit};
    for(double value:values) {
      const double expected=value<-limit?-limit:(value>limit?limit:value);
      const double actual=limit_command(value,limit);
      const bool passed=std::isfinite(actual) && std::fabs(actual-expected)<1e-12;
      std::printf("{\\"value\\":%.17g,\\"limit\\":%.17g,\\"expected\\":%.17g,\\"actual\\":%.17g,\\"finite\\":%s,\\"passed\\":%s}\\n",value,limit,expected,std::isfinite(actual)?actual:0.0,std::isfinite(actual)?"true":"false",passed?"true":"false");
      if(!passed) ++failures;
    }
  }
  return failures?1:0;
}
''',encoding='utf-8')
    exit_code=supervisor.run(['g++','-std=c++17','-O2','-Wall','-Wextra','-Werror',str(source),'-o',str(binary)],output/'device-logic-check-build.log',environment,timeout=45)
    if exit_code: return {'passed':False,'detail':'independent C++ numeric harness failed to compile; device-logic-check-build.log','cases':0}
    exit_code=supervisor.run([str(binary)],output/'device-logic-check.jsonl',environment,timeout=10)
    return {'passed':exit_code==0,'detail':'28 independent numeric cases: preserve valid values and clamp +/-2*max at four limits; device-logic-check.jsonl','cases':28}


if __name__=='__main__':
    print(json.dumps(probe_firmware_toolchain(),ensure_ascii=False))
