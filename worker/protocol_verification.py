"""Independent malformed/fragment/duplicate/watchdog tests of the native core."""
import json
import os
import pty
import select
import time
import tty
from .verification import check


def verify_core_faults(output,kind,parameters,supervisor,environment):
    master,slave=pty.openpty();tty.setraw(slave)
    process=None;events=[];states=[];buffer=bytearray()
    def collect(seconds):
        deadline=time.monotonic()+seconds
        while time.monotonic()<deadline:
            supervisor.ensure_active()
            if process.poll() is not None: raise RuntimeError('native protocol process exited unexpectedly')
            ready,_,_=select.select([slave],[],[],min(.03,max(0,deadline-time.monotonic())))
            if ready:
                buffer.extend(os.read(slave,4096))
                while b'\n' in buffer:
                    line,_,rest=buffer.partition(b'\n');buffer[:]=rest
                    frame=json.loads(line)
                    if frame['kind']=='event': events.append(frame)
                    elif frame['kind']=='state': states.append(frame)
    def send(frame): os.write(slave,(json.dumps(frame,allow_nan=False)+'\n').encode())
    checks=[];value=min(.2,parameters['max_velocity']) if kind=='joint_position' else 1.0
    try:
        process=supervisor.spawn([str(output/'esp32'/'host_protocol'),str(master),kind,str(parameters['threshold']),str(parameters['max_velocity'])],output/'protocol-core-faults.log',environment,pass_fds=(master,))
        wire=json.dumps({'seq':100,'time':0,'value':value}).encode()
        os.write(slave,wire[:10]);collect(.12)
        checks.append(check('protocol_fragment_waits_for_newline',not any(event['event']=='command_applied' for event in events),'partial JSON fragment must not apply a command'))
        os.write(slave,wire[10:]+b'\n');collect(.12)
        applied=[event for event in events if event['event']=='command_applied' and event['seq']==100]
        checks.append(check('protocol_fragment_reassembly',len(applied)==1 and applied[0]['value']==value,'two writes form exactly one accepted command'))
        send({'seq':100,'time':0,'value':0});send({'seq':99,'time':0,'value':0});collect(.08)
        duplicate=[event for event in events if event['event']=='command_duplicate']
        checks.append(check('protocol_duplicate_and_old_rejected',len(duplicate)==2 and all(event['value']==value for event in duplicate),'duplicate/older seq cannot replace held command'))
        malformed=[b'{}\n',b'{"seq":true,"time":0,"value":0}\n',b'{"seq":-1,"time":0,"value":0}\n',b'{"seq":2147483648,"time":0,"value":0}\n',b'{"seq":101,"time":-1,"value":0}\n',b'{"seq":101,"time":0,"value":1e999}\n',b'{"seq":101,"time":0,"value":"1"}\n']
        before=len([event for event in events if event['event']=='protocol_error'])
        malformed.extend([b'{"seq":101,"time":0,"value":0}garbage\n',b'{"seq":101,"time":0,"value":0}{"seq":102,"time":0,"value":0}\n',b'{"seq":101,"seq":102,"time":0,"value":0}\n',b'{"seq":101.0,"time":0,"value":0}\n',b'{"seq":101,"time":0,"value":+1}\n'])
        for raw in malformed: os.write(slave,raw)
        send({'seq':101,'time':0,'value':parameters['max_velocity']+1 if kind=='joint_position' else .5})
        collect(.08)
        errors=[event for event in events if event['event']=='protocol_error']
        checks.append(check('protocol_invalid_frames_rejected',len(errors)-before==len(malformed)+1 and all(event['seq']==100 for event in errors),'missing/bool/negative/large-seq/time/nonfinite/string/range/trailing/concatenated/duplicate-key/float-seq/plus invalid frames rejected'))
        os.write(slave,b'x'*700+b'\n')
        send({'seq':101,'time':0,'value':value});collect(.12)
        checks.append(check('protocol_oversize_recovery',any(event.get('reason')=='oversize_or_nul' for event in events) and any(event['event']=='command_applied' and event['seq']==101 for event in events),'oversized line discarded; next valid line accepted'))
        collect(.75)
        checks.append(check('protocol_watchdog_safe_zero',any(event['event']=='device_timeout' and event['value']==0 for event in events) and states[-1]['applied']==0,'command silence exceeds 600ms, shared core applies zero'))
        send({'seq':102,'time':1,'value':value});collect(.12)
        checks.append(check('protocol_reconnect_higher_seq',any(event['event']=='command_applied' and event['seq']==102 for event in events) and states[-1]['applied']==value,'valid newer command restores protocol after watchdog'))
        checks.append(check('protocol_state_contract',len(states)>=10 and all(type(frame['seq']) is int and frame['time']>=0 and 'applied_seq' in frame for frame in states),'real native core emitted state frames through PTY'))
    finally:
        if process is not None: supervisor.stop(process)
        os.close(master);os.close(slave)
    (output/'protocol-fault-trace.json').write_text(json.dumps({'events':events,'states':states,'checks':checks},indent=2),encoding='utf-8')
    return checks
