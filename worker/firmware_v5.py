"""V5 vector firmware generation, real cross compilation and native fault proof."""
import json
import hashlib
import math
import os
from pathlib import Path
import re
import shutil
import tempfile
import time
from .firmware import ROOT, TOOLS, SOURCES, FQBNS, CORE_VERSION, file_evidence, probe_firmware_toolchain

BAUDRATE = 921600
MAX_LINE_BYTES = 2047


def binding_v5(spec):
    from .motion_spec_v5 import motion_contract
    program = spec['motion_program']
    names = program['joint_names']
    joints = {joint['name']: joint for joint in spec['execution_model']['joints']}
    result = {
        'identity': motion_contract(spec)['communication']['identity'],
        'joint_names': names, 'initial_positions': program['initial_positions'],
        'limits': [joints[name]['limits'] for name in names],
        'max_velocity_rad_s': program['max_velocity_rad_s'],
        'max_acceleration_rad_s2': program['max_acceleration_rad_s2'],
        'tolerance_rad': program['tolerance_rad'], 'physical_io': False,
        'watchdog_ms': 600, 'publish_hz': 50, 'baudrate': BAUDRATE,
    }
    validate_binding_v5(result)
    return result


def validate_binding_v5(binding):
    names = binding['joint_names']
    if not 1 <= len(names) <= 16 or len(set(names)) != len(names):
        raise ValueError('V5 requires 1..16 uniquely ordered joint names')
    if any(not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,98}', name) for name in names):
        raise ValueError('joint names must be portable ASCII identifiers')
    for key in ('model_sha256', 'program_sha256', 'protocol_sha256'):
        if not re.fullmatch('[0-9a-f]{64}', binding['identity'][key]):
            raise ValueError('invalid frozen identity hash')
    if len(binding['initial_positions']) != len(names) or len(binding['limits']) != len(names):
        raise ValueError('incomplete ordered joint binding')
    for value, limits in zip(binding['initial_positions'], binding['limits']):
        low, high = limits['lower'], limits['upper']
        if any(isinstance(n, bool) or not isinstance(n, (int, float)) or not math.isfinite(n) for n in (value, low, high)) or not low <= value <= high or low >= high:
            raise ValueError('invalid joint initial position or limits')
    for key in ('max_velocity_rad_s', 'max_acceleration_rad_s2', 'tolerance_rad'):
        value = binding[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
            raise ValueError('invalid servo limit')
    if binding.get('physical_io', False) is not False:
        raise ValueError('physical IO is disabled')
    for key, fixed in (('watchdog_ms', 600), ('publish_hz', 50), ('baudrate', BAUDRATE)):
        if binding.get(key, fixed) != fixed:
            raise ValueError(f'{key} must be {fixed}')
    return binding


def hello_frame(binding, session):
    return dict(kind='hello', protocol_version=5, session=session, joint_names=binding['joint_names'], **{key: binding['identity'][key] for key in ('model_sha256', 'program_sha256', 'protocol_sha256')})


def wire_frame(frame):
    return json.dumps(frame, ensure_ascii=True, allow_nan=False, separators=(',', ':'))


def generated_device_logic(spec):
    """Provenance artifact for the fixed reviewed core, never AI implementation."""
    binding=binding_v5(spec)
    digest=hashlib.sha256((SOURCES/'protocol_core_v5.hpp').read_bytes()).hexdigest()
    return '// Fixed platform V5 core, not AI generated.\n// program_sha256: '+binding['identity']['program_sha256']+'\n// protected_core_sha256: '+digest+'\n#include "protocol_core_v5.hpp"\n'


def serial_budget_v5(binding):
    """Conservative 8N1 budget; PTY has no real UART throughput guarantee."""
    count = len(binding['joint_names']);session = 'f' * 32
    # Max numeric text length of %.17g bounded finite doubles is <=24 chars.
    numeric = '-1.7976931348623157e+308'
    sample = {'kind': 'measurement', 'session': session, 'seq': 2147483647, 'time': 2147483647.999999, 'positions': [0] * count}
    rx = len(wire_frame(sample).encode()) + 1 + count * (len(numeric) - 1)
    state = {'kind': 'state', 'session': session, 'seq': 4294967295, 'time': 2147483647.999999, 'measurement_seq': 2147483647, 'applied_seq': 2147483647, 'command_fresh': False, 'measurement_fresh': False, 'active': False, 'positions': [0]*count, 'target_positions': [0]*count, 'velocities': [0]*count}
    tx = len(wire_frame(state).encode()) + 1 + 3 * count * (len(numeric)-1)
    hello = len(wire_frame(hello_frame(binding, session)).encode())+1
    if max(rx, tx, hello) > MAX_LINE_BYTES+1:
        raise ValueError('binding exceeds fixed line budget')
    # Full duplex UART capacity is checked independently in each direction.
    rx_bps = rx * 2 * 50;tx_bps = tx * 50
    capacity = BAUDRATE / 10
    return {'baudrate': BAUDRATE, 'uart_format': '8N1', 'bytes_per_second_per_direction': capacity,
            'max_input_frame_bytes': rx, 'max_state_frame_bytes': tx, 'hello_bytes_once': hello,
            'command_hz': 50, 'measurement_hz': 50, 'state_hz': 50,
            'max_rx_bytes_s': rx_bps, 'max_tx_bytes_s': tx_bps,
            'rx_utilization': rx_bps/capacity, 'tx_utilization': tx_bps/capacity,
            'event_budget_bytes_s': 256*50,
            'within_budget': rx_bps < capacity and tx_bps+256*50 < capacity,
            'scope': 'analytical full-duplex UART budget; PTY tests do not measure real UART latency/throughput'}


def generate_firmware_v5(output, spec, firmware_code=None):
    fixed_logic=generated_device_logic(spec)
    if firmware_code is not None and firmware_code != fixed_logic:
        raise ValueError('V5 device logic must match exact fixed platform core provenance')
    output = Path(output);binding = binding_v5(spec);budget = serial_budget_v5(binding)
    if not budget['within_budget']:
        raise ValueError('V5 channel count exceeds 921600 baud traffic budget')
    base = output/'esp32';sketch = base/'ae_firmware_v5';sketch.mkdir(parents=True, exist_ok=True)
    names = '{'+','.join(json.dumps(n) for n in binding['joint_names'])+'}'
    array = lambda values: '{'+','.join(repr(float(n)) for n in values)+'}'
    initializer = ','.join([*(json.dumps(binding['identity'][k]) for k in ('model_sha256','program_sha256','protocol_sha256')),str(len(binding['joint_names'])),names,array(binding['initial_positions']),array([l['lower'] for l in binding['limits']]),array([l['upper'] for l in binding['limits']]),repr(binding['max_velocity_rad_s']),repr(binding['max_acceleration_rad_s2']),repr(binding['tolerance_rad'])])
    header = '#pragma once\nstatic const ae5::Binding ae5_model_binding = {'+initializer+'};\n'
    for directory in (base, sketch):
        shutil.copyfile(SOURCES/'protocol_core_v5.hpp', directory/'protocol_core_v5.hpp')
        (directory/'model_binding_v5.hpp').write_text(header, encoding='utf-8')
        (directory/'device_logic.cpp').write_text(fixed_logic,encoding='utf-8')
    shutil.copyfile(SOURCES/'ae_firmware_v5.ino', sketch/'ae_firmware_v5.ino')
    shutil.copyfile(SOURCES/'host_protocol_v5.cpp', base/'host_protocol_v5.cpp')
    (base/'protocol-binding.json').write_text(json.dumps(binding, ensure_ascii=False, indent=2), encoding='utf-8')
    (base/'serial-budget.json').write_text(json.dumps(budget, indent=2), encoding='utf-8')
    (base/'README.md').write_text('# V5 多关节虚拟设备固件\n\n同一 protocol_core_v5.hpp 用于 Linux 主机与 ESP32 / ESP32-S3 编译。输入位置目标 rad 与软件测量 rad，输出 P=4 的限速度/加速度速度 rad/s；整组检查，600ms 独立命令/测量看门狗立即停速。50Hz 批量 JSONL，921600 8N1；详见 serial-budget.json。\n\n协议首次 hello 绑定冻结模型/程序/协议摘要和关节顺序、32hex 会话。后续帧含会话、独立递增 seq 和不倒退仿真 time、positions。PTY 只证明同源核心软件执行，不证明真实串口吞吐、ESP 芯片执行、烧录、引脚、供电或真实电机行为。未知硬件未接入，physical_io=false。\n', encoding='utf-8')
    return {'binding': binding, 'serial_budget': budget, 'core': file_evidence(base/'protocol_core_v5.hpp', output)}


def compile_host_v5(output, supervisor, environment):
    output = Path(output);base = output/'esp32'
    command = ['g++','-std=c++17','-O2','-Wall','-Wextra','-Werror',str(base/'host_protocol_v5.cpp'),'-o',str(base/'host_protocol_v5')]
    code = supervisor.run(command, output/'protocol-v5-host-build.log', environment, timeout=45)
    if code:
        raise RuntimeError('native V5 core build failed; see protocol-v5-host-build.log')
    return {'passed': True, 'scope': 'same_native_cpp_core_not_esp32_execution', 'command': command, 'exit_code': code, 'binary': file_evidence(base/'host_protocol_v5', output), 'core': file_evidence(base/'protocol_core_v5.hpp', output)}


def compile_firmware_v5(spec, output, supervisor, environment):
    output = Path(output)
    if not probe_firmware_toolchain()['available']:
        raise RuntimeError('fixed WSL ESP32 compiler is unavailable')
    result = {'passed': False, 'core_version': CORE_VERSION, 'boards': [], 'flashed': False, 'esp32_execution_verified': False, 'physical_verified': False}
    for board, fqbn in FQBNS.items():
        artifacts = output/'esp32'/'artifacts'/board;artifacts.mkdir(parents=True, exist_ok=True)
        # WSL's native /tmp lives in the D:-hosted VHD. Source, logs and final
        # artifacts remain in the approved runs folder; avoid DrvFS for compiler IO.
        with tempfile.TemporaryDirectory(prefix='ae-v5-arduino-') as scratch:
            command = [str(TOOLS/'bin'/'arduino-cli'),'--config-file',str(TOOLS/'arduino-cli.yaml'),'compile','--fqbn',fqbn,'--jobs','1','--warnings','all','--build-path',str(Path(scratch)/'build'),'--output-dir',str(artifacts),str(output/'esp32'/'ae_firmware_v5')]
            started=time.monotonic()
            code = supervisor.run(command, output/f'firmware-v5-{board}-compile.log', dict(environment,TMPDIR=scratch), timeout=600)
            elapsed=time.monotonic()-started
        evidence = [file_evidence(p,output) for p in artifacts.iterdir() if p.is_file()]
        passed = code==0 and any(e['path'].endswith('.bin') and e['size'] for e in evidence) and any(e['path'].endswith('.elf') and e['size'] for e in evidence)
        result['boards'].append({'board': board, 'fqbn': fqbn, 'command': command, 'exit_code': code, 'passed': passed, 'artifacts': evidence,'elapsed_s':elapsed,'build_storage':'native Linux temporary directory in D:-hosted WSL VHD; removed after build; final artifacts/logs remain in runs'})
        if not passed: break
    result['passed'] = len(result['boards'])==2 and all(b['passed'] for b in result['boards'])
    result['core'] = file_evidence(output/'esp32'/'protocol_core_v5.hpp',output)
    (output/'firmware-v5-build.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    return result


def wait_protocol_condition(predicate, collect, timeout=2.0):
    """Wait for observed evidence, with a wall-clock deadline and no resend."""
    deadline=time.monotonic()+timeout
    while not predicate():
        remaining=deadline-time.monotonic()
        if remaining<=0: return False
        collect(min(.02,remaining))
    return True


def verify_protocol_v5(output, spec, supervisor, environment):
    """Send real fragmented/adversarial PTY traffic to the built C++ core."""
    import pty
    import tty
    output = Path(output);binding = binding_v5(spec);session = '1234567890abcdef'*2
    master, slave = pty.openpty();tty.setraw(slave);os.set_blocking(slave,False)
    packets=[];buffer=bytearray();checks=[];waits=[];process=None
    def collect(seconds):
        until=time.monotonic()+seconds
        while time.monotonic()<until:
            supervisor.ensure_active()
            try: block=os.read(slave,8192)
            except BlockingIOError: block=b''
            buffer.extend(block)
            while b'\n' in buffer:
                line,_,tail=buffer.partition(b'\n');buffer[:]=tail
                if line: packets.append(json.loads(line))
            time.sleep(.003)
    def send(packet): os.write(slave, ((packet if isinstance(packet,str) else wire_frame(packet))+'\n').encode())
    def frame(kind,seq,stamp,positions): return {'kind':kind,'session':session,'seq':seq,'time':stamp,'positions':positions}
    def events(name): return [p for p in packets if p.get('event')==name]
    def await_signal(name,predicate,timeout=2.0):
        started=time.monotonic();observed=wait_protocol_condition(predicate,collect,timeout)
        waits.append({'name':name,'observed':observed,'elapsed_s':time.monotonic()-started,'deadline_s':timeout})
        return observed
    def state_matches(**fields):
        return any(p.get('kind')=='state' and all(p.get(k)==v for k,v in fields.items()) for p in packets)
    def rejected(reason): return any(p.get('reason')==reason for p in events('protocol_error'))
    def state_after_last_error():
        error_index=max((i for i,p in enumerate(packets) if p.get('event')=='protocol_error'),default=-1)
        return any(p.get('kind')=='state' for p in packets[error_index+1:])
    def check(name,passed,detail): checks.append({'name':name,'passed':bool(passed),'detail':detail})
    positions=list(binding['initial_positions'])
    targets=[min(l['upper'],v+.2) if v+.2<=l['upper'] else max(l['lower'],v-.2) for v,l in zip(positions,binding['limits'])]
    try:
        process=supervisor.spawn([str(output/'esp32'/'host_protocol_v5'),str(master)],output/'protocol-v5-faults.log',environment,pass_fds=(master,))
        send(frame('command',0,0,targets))
        seen=await_signal('unbound_command_rejection',lambda:rejected('session'))
        check('protocol_v5_requires_handshake',seen and not events('command_applied'),'observed native rejection of unbound command')
        hello=hello_frame(binding,session);bad=dict(hello,program_sha256='0'*64);send(bad)
        seen=await_signal('wrong_identity_rejection',lambda:rejected('identity'))
        check('protocol_v5_wrong_identity',seen and not events('hello_ack'),'observed rejection of wrong program identity')
        text=wire_frame(hello);os.write(slave,text[:19].encode());collect(.04)
        prefix_no_ack=not events('hello_ack')
        os.write(slave,(text[19:]+'\n').encode())
        seen=await_signal('fragmented_hello_ack',lambda:len(events('hello_ack'))>=1)
        check('protocol_v5_fragmented_handshake',prefix_no_ack and seen and len(events('hello_ack'))==1,'no ACK before newline/tail; observed native ACK after actual fragmented PTY input')
        send(frame('measurement',0,0,positions));send(frame('command',0,0,targets))
        seen=await_signal('first_vector_active',lambda:len(events('command_applied'))>=1 and state_matches(active=True,applied_seq=0,measurement_seq=0))
        check('protocol_v5_vector_applied',seen and len(events('command_applied'))==1,'complete vector accepted and associated active state observed')
        first_applied_state=next((p['seq'] for p in packets if p.get('kind')=='state' and p.get('active') and p.get('applied_seq')==0),math.inf)
        invalid_vector=targets[:-1]+[binding['limits'][-1]['upper']+1]
        malformed=[frame('command',1,1,invalid_vector),frame('command',1,1,targets[:-1]),frame('command',0,1,targets),frame('command',1,-1,targets),dict(frame('command',1,1,targets),session='f'*32),wire_frame(frame('command',1,1,targets))+'garbage','{"kind":"command","kind":"measurement"}','x'*2100,wire_frame(frame('command',1,1,targets)).replace('"seq":1','"seq":true'),
            json.dumps(frame('command',1,1,[float('nan')]+targets[1:])),json.dumps(frame('command',1,1,[float('inf')]+targets[1:])),frame('measurement',0,2,positions),frame('measurement',1,2,positions[:-1]+[binding['limits'][-1]['upper']+1]),dict(frame('command',1,1,targets),extra=1)]
        before_errors=len(events('protocol_error'))
        for bad in malformed: send(bad)
        seen=await_signal('all_malformed_frames_rejected',lambda:len(events('protocol_error'))-before_errors>=len(malformed) and state_after_last_error())
        states=[p for p in packets if p['kind']=='state' and p['seq']>=first_applied_state]
        check('protocol_v5_atomic_rejection',len(events('command_applied'))==1 and states and all(p['target_positions']==targets and p['applied_seq']==0 for p in states),'late-axis range fault, missing axis, replay, time, session, duplicate key, oversize, boolean do not partially commit')
        check('protocol_v5_each_bad_frame_rejected',seen and len(events('protocol_error'))-before_errors==len(malformed),'awaited every independent malformed/nonfinite/duplicate/late-axis/measurement-replay/unknown-field rejection')
        send(frame('measurement',1,1,positions));send(frame('command',1,1,targets))
        seen=await_signal('valid_vector_recovery',lambda:len(events('command_applied'))>=2 and state_matches(active=True,applied_seq=1,measurement_seq=1))
        check('protocol_v5_bad_frame_recovery',seen and len(events('command_applied'))==2,'observed fresh accepted vector and state without parser reset')
        # Keep measurements fresh while commands stop, proving independent lease.
        for seq in range(2,7): send(frame('measurement',seq,float(seq),positions));collect(.15)
        seen=await_signal('command_timeout_zero_state',lambda:bool(events('command_timeout')) and state_matches(active=False,command_fresh=False,measurement_fresh=True,measurement_seq=6,velocities=[0.]*len(positions)),timeout=.35)
        check('protocol_v5_command_watchdog',seen,'real 600ms command silence, observed timeout plus zero state while measurements remain fresh')
        send(frame('command',2,7,targets))
        seen=await_signal('command_recovery_state',lambda:len(events('command_applied'))>=3 and state_matches(active=True,applied_seq=2,measurement_seq=6))
        check('protocol_v5_command_recovery',seen and len(events('command_applied'))==3,'observed recovery command only with fresh measurement')
        # Keep commands fresh while measurements stop.
        for seq in range(3,8): send(frame('command',seq,7.0,targets));collect(.15)
        seen=await_signal('measurement_timeout_zero_state',lambda:bool(events('measurement_timeout')) and state_matches(active=False,measurement_fresh=False,measurement_seq=6,velocities=[0.]*len(positions)))
        check('protocol_v5_measurement_watchdog',seen,'real 600ms measurement silence independently zeroes complete vector')
        before=len(events('command_applied'));send(frame('measurement',7,20,positions))
        seen=await_signal('measurement_alone_state',lambda:state_matches(active=False,command_fresh=False,measurement_fresh=True,measurement_seq=7))
        check('protocol_v5_measurement_alone_no_restart',seen,'observed fresh feedback with inactive output: target cannot resurrect')
        send(frame('command',9,20,targets))
        seen=await_signal('full_recovery_active_state',lambda:len(events('command_applied'))>=before+1 and state_matches(active=True,applied_seq=9,measurement_seq=7))
        check('protocol_v5_full_recovery',seen and len(events('command_applied'))==before+1,'observed new measurement and command required after feedback loss')
        all_states=[p for p in packets if p['kind']=='state']
        check('protocol_v5_velocity_limit',all(abs(v)<=binding['max_velocity_rad_s']+1e-9 for p in all_states for v in p['velocities']),'every emitted velocity respects frozen maximum')
        check('protocol_v5_state_identity',all(p['session']==session for p in all_states),'every state binds established session')
        check('protocol_v5_no_fake_feedback',all(p['positions']==positions for p in all_states),'core never integrates/synthesizes Gazebo position')
    finally:
        if process: supervisor.stop(process)
        os.close(master);os.close(slave)
        (output/'protocol-v5-faults-trace.json').write_text(json.dumps({'packets':packets,'checks':checks,'bounded_waits':waits},indent=2),encoding='utf-8')
    return checks
