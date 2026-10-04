"""Independent adversarial tests of the compiled SAME protocol core."""
import json
import os
import time
from .binding import frame,parse_bound_frame
from .verification import check

def verify_core_faults_v3(output,spec,binding,supervisor,environment):
    import pty,tty
    master,slave=pty.openpty();tty.setraw(slave);os.set_blocking(slave,False)
    process=None;packets=[];buffer=bytearray();checks=[];parameters=spec['parameters'];joint=spec['task_type']=='joint_position'
    def collect(seconds):
        until=time.monotonic()+seconds
        while time.monotonic()<until:
            supervisor.ensure_active()
            try: block=os.read(slave,8192)
            except BlockingIOError: block=b''
            buffer.extend(block)
            while b'\n' in buffer:
                line,_,tail=buffer.partition(b'\n');buffer[:]=tail
                if line: packets.append(parse_bound_frame(line.decode(),binding))
            time.sleep(.005)
    def send(text): os.write(slave,(text+'\n').encode())
    def events(name): return [p for p in packets if p.get('event')==name]
    try:
        process=supervisor.spawn([str(output/'esp32'/'host_protocol'),str(master),spec['task_type'],str(parameters['threshold']),str(parameters['max_velocity'])],output/'protocol-v3-faults.log',environment,pass_fds=(master,))
        initial=binding['initial_position']
        if joint: send(frame(binding,'measurement',0,0,initial))
        else: collect(.1)
        command=min(.2,parameters['max_velocity']) if joint else 1.0
        valid=frame(binding,'command',0,0,command)
        # Deliberately split a real JSONL packet at arbitrary byte boundaries.
        os.write(slave,valid[:17].encode());collect(.02);os.write(slave,(valid[17:]+'\n').encode());collect(.1)
        applied=events('command_applied')
        checks.append(check('protocol_v3_fragmented_frame',len(applied)==1 and abs(applied[0]['value']-command)<1e-9,'same native/ESP header accepts fragmented identity-bound command'))
        send(frame(binding,'command',0,0,0));collect(.05)
        checks.append(check('protocol_v3_duplicate_command',len(events('command_applied'))==1 and events('command_duplicate') and events('command_duplicate')[-1]['value']==command,'duplicate sequence cannot reapply or extend command lease'))
        bad_identity=json.loads(frame(binding,'command',1,0,0));bad_identity['model_sha256']='0'*64
        invalid=[json.dumps(bad_identity),frame(binding,'command',1,0,0)+'garbage',frame(binding,'command',1,0,0)+frame(binding,'command',1,0,0),'{"seq":1,"seq":2}', 'x'*600, frame(binding,'command',1,0,0).replace('"value":0','"value":true')]
        for bad in invalid: send(bad)
        collect(.1)
        checks.append(check('protocol_v3_identity_and_malformed_rejected',len(events('protocol_error'))>=len(invalid) and len(events('command_applied'))==1,'wrong model hash, trailing garbage, two objects, duplicate keys, oversized line, boolean value'))
        if joint:
            collect(.1)
            states=[p for p in packets if p['kind']=='state']
            checks.append(check('protocol_v3_no_internal_joint_integration',len(states)==1 and states[0]['value']==initial,'command changes applied velocity, but no new joint state without Gazebo measurement'))
        collect(.8)
        if not joint: checks.append(check('protocol_v3_watchdog_zero',bool(events('device_timeout')) and events('device_timeout')[-1]['value']==0,'command silence exceeds fixed 600ms; applied value zero'))
        if joint:
            checks.append(check('protocol_v3_measurement_watchdog_zero',bool(events('measurement_timeout')) and events('measurement_timeout')[-1]['value']==0,'measurement silence zeroes and stops state output'))
            send(frame(binding,'measurement',1,1,initial));collect(.05)
            states=[p for p in packets if p['kind']=='state']
            checks.append(check('protocol_v3_measurement_recovery',len(states)==2 and states[-1]['seq']==1 and states[-1]['value']==initial,'fresh same-identity measurement recovers exact state'))
        # Fixed boundary semantics: shared generated numeric function must preserve
        # already-valid commands; faults are independent of generated code.
        expected=[-parameters['max_velocity'],0.0,parameters['max_velocity']] if joint else [0.0,1.0]
        before=len(events('command_applied'))
        for index,value in enumerate(expected,2):
            if joint: send(frame(binding,'measurement',index,float(index),initial))
            send(frame(binding,'command',index,float(index),value));collect(.06)
        actual=events('command_applied')[before:]
        checks.append(check('device_logic_fixed_boundaries',len(actual)==len(expected) and all(abs(p['value']-v)<1e-9 for p,v in zip(actual,expected)),'independent valid positive/zero/negative boundary commands must be preserved by limited function'))
        if joint:
            # Isolate command loss from measurement loss: continue REAL protocol
            # measurement inputs while withholding commands for over 600ms.
            for seq in range(5,10): send(frame(binding,'measurement',seq,float(seq),initial));collect(.2)
            checks.append(check('protocol_v3_watchdog_zero',bool(events('device_timeout')) and events('device_timeout')[-1]['value']==0,'fresh measurements continue; command silence independently exceeds fixed 600ms'))
        checks.append(check('protocol_v3_frame_identity',all(all(p.get(k)==v for k,v in binding['identity'].items()) for p in packets),'all actual state/event outputs use approved joint/model/protocol identity'))
    finally:
        if process: supervisor.stop(process)
        os.close(master);os.close(slave)
        (output/'protocol-v3-faults-trace.json').write_text(json.dumps({'packets':packets,'checks':checks},indent=2),encoding='utf-8')
    return checks
