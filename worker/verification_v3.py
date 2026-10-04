"""Independent V3 acceptance: physical simulator and PTY core are ONE loop."""
import json
import math
import os
import time
import uuid
from .binding import parse_bound_frame,frame
from .physics_v3 import generate_sdf
from .verification import RosVerifier,check

class ObserverSchedule:
    """Lifecycle scans are bounded to 50ms; callbacks run between scans."""
    interval=.05
    spin_limit=.01
    def __init__(self,now): self.next_check=now;self.last_check=None;self.max_gap=0;self.checks=0
    def due(self,now): return now>=self.next_check
    def record(self,now):
        if self.last_check is not None: self.max_gap=max(self.max_gap,now-self.last_check)
        self.last_check=now;self.next_check=now+self.interval;self.checks+=1
    def timeout(self,now): return max(0,min(self.spin_limit,self.next_check-now))

class ModelVerifier(RosVerifier):
    def __init__(self,supervisor,environment,output,spec,binding):
        super().__init__(supervisor,environment,output,spec['task_type'],spec['parameters'])
        self.spec=spec;self.model=spec.get('execution_model');self.binding=binding
    def case(self,name,duration,parameters=None,action=None,task=True):
        import pty,tty
        from rclpy.node import Node
        from rclpy.executors import SingleThreadedExecutor
        from std_msgs.msg import String,Float64
        namespace='/ae_'+uuid.uuid4().hex[:16];observer=Node('verifier',namespace=namespace,context=self.context,enable_rosout=False)
        executor=SingleThreadedExecutor(context=self.context);executor.add_node(observer)
        data={'states':{},'commands':{},'measurements':{},'velocities':[],'events':[],'errors':[],'namespace':namespace,'expected_exit_pids':[],
              'observer':{'check_interval_seconds':ObserverSchedule.interval,'spin_limit_seconds':ObserverSchedule.spin_limit,'callbacks':0,'supervisor_checks':0,'max_check_gap_seconds':0,'max_check_duration_seconds':0}}
        def receive(message,destination,kind):
            data['observer']['callbacks']+=1
            try:
                packet=parse_bound_frame(message.data,self.binding,kind)
                if packet['seq'] in data[destination]: raise ValueError('duplicate '+kind+' sequence')
                if destination=='states':
                    lo,hi=self.binding['value_bounds']
                    if not lo-1e-6<=packet['value']<=hi+1e-6: raise ValueError('state beyond approved bounds')
                    if data[destination]:
                        previous=next(reversed(data[destination].values()))
                        if packet['seq']<=previous['seq'] or packet['time']<previous['time']: raise ValueError('nonmonotonic state')
                if kind=='command' and (abs(packet['value'])>self.parameters['max_velocity']+1e-9 if self.kind=='joint_position' else packet['value'] not in (0,1)): raise ValueError('command range')
                data[destination][packet['seq']]=packet
            except Exception as error: data['errors'].append(destination+': '+str(error))
        def event(message):
            data['observer']['callbacks']+=1
            try:
                packet=parse_bound_frame(message.data,self.binding,'event');data['events'].append(packet)
                if packet.get('event') in ('task_error','device_error','bridge_error','protocol_error','device_logic_error'): data['errors'].append(str(packet))
            except Exception as error: data['errors'].append('event: '+str(error))
        observer.create_subscription(String,'state',lambda m:receive(m,'states','state'),10)
        observer.create_subscription(String,'command',lambda m:receive(m,'commands','command'),10)
        observer.create_subscription(String,'bench_measurement',lambda m:receive(m,'measurements','measurement'),10)
        observer.create_subscription(String,'event',event,10)
        def velocity(message):
            data['observer']['callbacks']+=1;data['velocities'].append({'time':time.monotonic(),'value':message.data})
        observer.create_subscription(Float64,'velocity',velocity,10)
        state_pub=observer.create_publisher(String,'state',10);command_pub=observer.create_publisher(String,'command',10)
        processes=[];descriptors=[];started=time.monotonic();values=dict(self.parameters);values.update(parameters or {})
        physics=self.kind=='joint_position';environment=dict(self.environment,IGN_PARTITION=namespace[1:],GZ_PARTITION=namespace[1:])
        try:
            master,slave=pty.openpty();descriptors=[master,slave];tty.setraw(slave);device_path=os.ttyname(slave)
            host=self.supervisor.spawn([str(self.output/'esp32'/'host_protocol'),str(master),self.kind,str(values['threshold']),str(values['max_velocity'])],self.output/(name+'-host-core.log'),environment,pass_fds=(master,));processes.append(host);data['host_pid']=host.pid
            if physics:
                world=self.output/(name+'.sdf');world.write_text(generate_sdf(self.model,namespace,values['max_velocity']),encoding='utf-8')
                gazebo=self.supervisor.spawn(['ign','gazebo','-s','-r','-v','3',str(world)],self.output/(name+'-gazebo.log'),environment);processes.append(gazebo);data['gazebo_pid']=gazebo.pid
                processes.append(self.supervisor.spawn(['/opt/ros/humble/lib/ros_gz_bridge/parameter_bridge',namespace+'/velocity@std_msgs/msg/Float64]ignition.msgs.Double',namespace+'/raw_joint_state@sensor_msgs/msg/JointState[ignition.msgs.Model'],self.output/(name+'-gz-bridge.log'),environment))
            executables=['serial_bridge']+(['gazebo_device'] if physics else [])+(['task_node'] if task else [])
            for executable in executables:
                args=[str(self.output/'ros_ws'/'install'/'lib'/'ae_generated'/executable),'--ros-args','-r','__ns:='+namespace]
                if executable=='serial_bridge': args.extend(['-p','device_path:='+device_path])
                if executable=='task_node':
                    for key in ('target','threshold','max_velocity'): args.extend(['-p',key+':='+str(float(values[key]))])
                child=self.supervisor.spawn(args,self.output/(name+'-'+executable+'.log'),environment);processes.append(child);data[executable+'_pid']=child.pid
            ready_at=None;schedule=ObserverSchedule(time.monotonic())
            while ready_at is None or time.monotonic()-ready_at<duration:
                now=time.monotonic()
                if schedule.due(now):
                    schedule.record(now)
                    try: self.supervisor.ensure_active()
                    except Exception:
                        data['observer']['stop_detected_monotonic']=time.monotonic();raise
                    data['observer']['max_check_duration_seconds']=max(data['observer']['max_check_duration_seconds'],time.monotonic()-now)
                    data['observer']['supervisor_checks']=schedule.checks;data['observer']['max_check_gap_seconds']=schedule.max_gap
                    for process in processes:
                        if process.poll() is not None and process.pid not in data['expected_exit_pids']: raise RuntimeError(f'V3 child exited early: {process.pid}, exit={process.returncode}, case={name}')
                executor.spin_once(timeout_sec=schedule.timeout(time.monotonic()))
                if ready_at is None:
                    if data['states'] and (not task or data['commands']) and (not physics or data['measurements']):
                        ready_at=time.monotonic()
                        (self.output/(name+'-ready.json')).write_text(json.dumps({'case':name,'namespace':namespace,'state_count':len(data['states']),'command_count':len(data['commands']),'measurement_count':len(data['measurements']),'identity':self.binding['identity'],'physical_io':False}),encoding='utf-8')
                    elif time.monotonic()-started>8: raise TimeoutError('ROS endpoint discovery exceeded 8 seconds in '+name)
                if action and ready_at is not None: action(time.monotonic()-ready_at,state_pub,command_pub,data)
        finally:
            for process in reversed(processes): self.supervisor.stop(process)
            executor.shutdown(timeout_sec=1);observer.destroy_node()
            for descriptor in descriptors: os.close(descriptor)
            data['elapsed']=time.monotonic()-started;self.received_count+=len(data['states'])
            self.cases.append({'name':name,'duration':duration,'namespace':namespace,'state_count':len(data['states']),'command_count':len(data['commands']),'measurement_count':len(data['measurements']),'errors':data['errors'],'events':data['events']})
            (self.output/(name+'-trace.json')).write_text(json.dumps(data,indent=2),encoding='utf-8')
        return data
    def inspect_loop(self,data,name,target,threshold,primary=False):
        self.inspect_task_case(data,name,target,threshold,primary_series=primary)
        accepted=[event for event in data['events'] if event.get('event')=='command_applied']
        self.checks.append(check(name+'_firmware_applied',len(accepted)>=10,'at least ten actual firmware-confirmed command events; missing events are a communication failure'))
        known=[event for event in accepted if event['seq'] in data['commands']]
        self.checks.append(check(name+'_device_logic_preservation',all(abs(event['value']-data['commands'][event['seq']]['value'])<1e-9 for event in known),'actual paired firmware confirmations must preserve valid ROS task commands; missing pairs do not falsely blame numeric C++ function'))
        if self.kind=='joint_position':
            matched=[(state,data['measurements'][seq]) for seq,state in data['states'].items() if seq in data['measurements']]
            mismatch_count=sum(s['value']!=m['value'] or s['time']!=m['time'] for s,m in matched)
            self.checks.append(check(name+'_same_model_feedback',len(matched)>=10 and len(matched)>=len(data['states'])-2 and mismatch_count==0,f'Gazebo measurement and firmware state exact seq/time/value/identity; matched={len(matched)},states={len(data["states"])},measurements={len(data["measurements"])},mismatches={mismatch_count}; core never integrates joint'))
            applied_values=[event['value'] for event in accepted]
            self.checks.append(check(name+'_firmware_drives_gazebo',len(data['velocities'])>=10 and all(v['value']==0 or any(abs(v['value']-a)<1e-9 for a in applied_values) for v in data['velocities']),'only firmware-confirmed applied events drive ROS velocity; safety zero permitted'))
            log=(self.output/(name+'-gazebo.log')).read_text(errors='replace')
            self.checks.append(check(name+'_gazebo_backend_loaded','[Err]' not in log and 'Failed to find plugin' not in log,'Fortress/DART selected-joint world; log must have no physics/plugin error'))
    def simulation_cases(self):
        primary=self.case('model_primary',self.parameters['duration']);self.inspect_loop(primary,'model_primary',self.parameters['target'],self.parameters['threshold'],True)
        if self.kind=='joint_position':
            initial=self.binding['initial_position'];lo,hi=self.binding['value_bounds'];alternate=max(lo,min(hi,initial+(.15 if initial+.15<=hi else -.15)))
            data=self.case('model_alternate',4,{'target':alternate});self.inspect_loop(data,'model_alternate',alternate,self.parameters['threshold'])
            data=self.case('model_already',2,{'target':initial});self.inspect_loop(data,'model_already',initial,self.parameters['threshold'])
            initial_value=next(iter(data['states'].values()),{}).get('value',math.inf)
            self.checks.append(check('model_source_initial_position',abs(initial_value-initial)<1e-6,f'already-target case actual first Gazebo logical value={initial_value}; source initial={initial}; no discovery-order motion'))
        else:
            threshold=.7 if self.parameters['threshold']<.6 else .3
            data=self.case('model_alternate_threshold',3.5,{'threshold':threshold});self.inspect_loop(data,'model_alternate_threshold',self.parameters['target'],threshold)
    def communication_cases(self):
        start=len(self.checks)
        target=self.binding['initial_position'] if self.kind=='joint_position' else self.parameters['target']
        data=self.case('communication_loop',2,{'target':target});self.inspect_loop(data,'communication_loop',target,self.parameters['threshold'])
        sent={'done':False}
        def disconnect(elapsed,state_pub,command_pub,data):
            if elapsed>1 and not sent['done']:
                pid=data['gazebo_pid'] if self.kind=='joint_position' else data['host_pid'];process=next(p for p in self.supervisor.processes if p.pid==pid)
                data['expected_exit_pids'].append(pid);self.supervisor.stop(process);sent['done']=True
        lost=self.case('communication_measurement_loss',2.5,{'target':target},action=disconnect)
        timeout=any(event.get('event')=='task_timeout' for event in lost['events']);last=next(reversed(lost['commands'].values()),{})
        self.checks.append(check('serial_state_loss_safe_zero',timeout and last.get('value')==0,'producer stopped; real ROS task must stop'))
        if self.kind=='joint_position': self.checks.append(check('measurement_loss_firmware_safe_zero',any(e.get('event')=='measurement_timeout' and e['value']==0 for e in lost['events']) and any(v['value']==0 for v in lost['velocities']),'Gazebo measurement loss stops firmware state and drives zero through same adapter'))
        return {'passed':all(c['passed'] for c in self.checks[start:]),'checks':self.checks[start:],'scope':'gazebo_selected_joint_ros_pty_host_protocol_core' if self.kind=='joint_position' else 'host_protocol_core_pty_ros','identity':self.binding['identity'],'samples':len(data['states']),'physical_verified':False,'physical_io':False,'flashed':False,'esp32_execution_verified':False}
