"""Independent observation of actual JTC, Gazebo and same-source firmware."""
import json
import math
import os
from pathlib import Path
import time
import uuid
from .physics_v5 import generate_sdf_v5,generate_urdf_v5
from .templates_motion_v5 import controller_parameters,bridge_arguments


def check(name, passed, detail):
    return {'name':name,'passed':bool(passed),'detail':detail if isinstance(detail,str) else json.dumps(detail,ensure_ascii=False,allow_nan=False)}


def trajectory_at(program, elapsed):
    previous=program['initial_positions']; stamp=0.
    for row in program['waypoints']:
        if elapsed<=row['time_from_start_s']:
            ratio=max(0.,min(1.,(elapsed-stamp)/(row['time_from_start_s']-stamp)))
            blend=10*ratio**3-15*ratio**4+6*ratio**5
            return [a+(b-a)*blend for a,b in zip(previous,row['positions'])],row
        previous=row['positions'];stamp=row['time_from_start_s']
    return previous,program['waypoints'][-1]


def observed_motion(data, wall):
    """Require recent raw Gazebo movement, not a planned or sent command."""
    samples=[a for a in data['audit'] if a.get('kind')=='raw' and wall-.3<=a.get('_wall',-1)<=wall]
    speeds=[max(abs(a-b)/(right['time']-left['time']) for a,b in zip(left['positions'],right['positions']))
        for left,right in zip(samples,samples[1:]) if right['time']>left['time']]
    displacement=max((max(s['positions'][i] for s in samples)-min(s['positions'][i] for s in samples)
        for i in range(len(samples[0]['positions']))),default=0.) if samples else 0.
    speed=max(speeds,default=0.)
    return {'moving':len(samples)>=3 and displacement>1e-5 and speed>.001,
        'samples':len(samples),'position_span_rad':displacement,'max_measured_rad_s':speed}


def assess_case(data,program,identity,name,fault=None):
    states=data['states'];raw=data['measurements'];audit=data['audit']; events=data['task_events']
    submitted=next((e for e in events if e.get('event')=='submitted'),None)
    finished=next((e for e in events if e.get('event')=='completed'),None)
    start=submitted['start_s'] if submitted else None
    # Deliberately pausing measurements must cause the core to reject late
    # commands. Preserve that event in the trace; only this exact injected
    # fault/guard combination is expected, never unrelated protocol errors.
    errors=[e for e in data['errors'] if not (fault=='measurement_loss' and isinstance(e,dict)
        and e.get('event')=='protocol_error' and e.get('reason')=='no_fresh_measurement'
        and e.get('_wall',0)>=data.get('fault_wall',math.inf))]
    checks=[check(name+'_observed_all_channels',len(states)>25 and len(raw)>25,'actual complete vectors from ROS topics'),
        check(name+'_no_runtime_errors',not errors,errors or 'no unexpected errors; injected measurement loss may reject commands without fresh feedback'),
        check(name+'_action_identity',submitted and all(e.get('identity')==identity for e in events),'action events bound to frozen model/program/protocol'),
        check(name+'_gazebo_backend_loaded',data.get('gazebo_loaded',False),'actual DART physics plugin log')]
    measured={m['seq']:m for m in raw}; matched=[]
    for state in states:
        source=measured.get(state['measurement_seq'])
        if source:
            matched.append(state['positions']==source['positions'] and abs(state['time']-source['time'])<1e-7)
    checks.append(check(name+'_same_core_feedback',len(matched)>25 and all(matched),'core measurement seq/time/positions equal source Gazebo vector'))
    raw_audit=[a for a in audit if a.get('kind')=='raw']
    raw_by_sequence={a['measurement_seq']:a for a in raw_audit if not a.get('measurement_paused',False)}
    measured_from_gazebo=[m['seq'] in raw_by_sequence and m['positions']==raw_by_sequence[m['seq']]['normalized_positions']
        and abs(m['time']-raw_by_sequence[m['seq']]['time'])<1e-9 for m in raw]
    checks.append(check(name+'_gazebo_measurement_path',len(measured_from_gazebo)>25 and all(measured_from_gazebo),
        {'measurements':len(raw),'matched':sum(measured_from_gazebo),'scope':'every protocol measurement matches raw Gazebo audit sequence, time and normalized position vector'}))
    normalization=[max(abs(a-b) for a,b in zip(item['positions'],item['normalized_positions'])) for item in raw_audit]
    checks.append(check(name+'_simulator_roundoff_only',bool(normalization) and max(normalization)<=1e-6,
        {'max_boundary_correction_rad':max(normalization,default=None),'allowed_rad':1e-6,'scope':'raw vector retained; DART constraint-solver boundary allowance below 0.00006 degree; command limits unchanged'}))
    measured_speeds=[max(abs(a-b)/(right['time']-left['time']) for a,b in zip(left['positions'],right['positions']))
        for left,right in zip(raw_audit,raw_audit[1:]) if right['time']>left['time']]
    checks.append(check(name+'_measured_velocity_bound',bool(measured_speeds) and max(measured_speeds)<=program['max_velocity_rad_s']+.001,
        {'max_measured_rad_s':max(measured_speeds,default=None),'numerical_allowance_rad_s':.001}))
    by_sequence={s['seq']:s for s in states};applied=[]
    for item in audit:
        if item.get('kind')=='applied' and item['core_seq'] in by_sequence:
            applied.append(item['velocities']==by_sequence[item['core_seq']]['velocities'])
    checks.append(check(name+'_core_actuator_path',len(applied)>25 and all(applied),'Gazebo actuator vector matches authenticated firmware output'))
    limit=program['max_velocity_rad_s'];accel=program['max_acceleration_rad_s2']
    checks.append(check(name+'_velocity_bound',bool(states) and all(abs(v)<=limit+1e-6 for s in states for v in s['velocities']),'every core output within reviewed rad/s cap'))
    # Stop watchdog overrides slew. Ordinary active samples with new simulation
    # measurements must obey the same acceleration contract at any real-time factor.
    max_acc=0.;previous=None
    for state in states:
        if previous and state['active'] and previous['active'] and state['time']>previous['time']:
            dt=state['time']-previous['time']
            max_acc=max(max_acc,max(abs(a-b)/dt for a,b in zip(state['velocities'],previous['velocities'])))
        if previous is None or state['time']>previous['time']:previous=state
    checks.append(check(name+'_acceleration_bound',max_acc<=accel+1e-4,f'max observed active slew {max_acc:.6g} rad/s²; emergency stop is immediate'))
    series=[];reached=[]
    if start is not None:
        for state in states:
            t=state['time']-start
            if t<0:continue
            target,row=trajectory_at(program,t)
            series.append({'t':round(t,6),'time':round(t,6),'positions':dict(zip(program['joint_names'],state['positions'])),
                'targets':dict(zip(program['joint_names'],target)),'velocities':dict(zip(program['joint_names'],state['velocities'])),
                'commands':dict(zip(program['joint_names'],state['velocities'])),
                'stage_id':row['stage_id'],'cycle_index':row['cycle_index'],
                'value':state['positions'][0],'target':target[0],'command':state['velocities'][0]})
        for index,row in enumerate(program['waypoints']):
            samples=[s for s in states if abs(s['time']-start-row['time_from_start_s'])<.15]
            err=min((max(abs(a-b) for a,b in zip(s['positions'],row['positions'])) for s in samples),default=math.inf)
            reached.append({'index':index,'stage_id':row['stage_id'],'cycle_index':row['cycle_index'],
                'max_position_error_rad':err if math.isfinite(err) else None,'passed':err<=program['tolerance_rad']})
    completed_cycles=sorted({r['cycle_index'] for r in reached if r['cycle_index']>0 and all(s['passed'] for s in reached if s['cycle_index']==r['cycle_index'])})
    expected_cycles=sorted({r['cycle_index'] for r in program['waypoints'] if r['cycle_index']>0})
    cycle_evidence=[]
    for cycle in expected_cycles:
        indices=[i for i,row in enumerate(program['waypoints']) if row['cycle_index']==cycle]
        first,last=indices[0],indices[-1]
        before=program['waypoints'][first-1] if first else {'positions':program['initial_positions'],'time_from_start_s':0.}
        samples=[s for s in states if start is not None and before['time_from_start_s']-.05<=s['time']-start<=program['waypoints'][last]['time_from_start_s']+.15]
        departed=any(max(abs(a-b) for a,b in zip(s['positions'],before['positions']))>program['tolerance_rad'] for s in samples)
        returned=bool(reached) and reached[last]['passed']
        cycle_evidence.append({'cycle_index':cycle,'departed':departed,'returned':returned})
    completed_cycles=[c for c in completed_cycles if next(e for e in cycle_evidence if e['cycle_index']==c)['departed']]
    if fault is None:
        checks.extend([check(name+'_jtc_succeeded',finished and finished.get('status')==4 and finished.get('error_code')==0,finished or 'no action completion observed'),
            check(name+'_all_waypoints',len(reached)==len(program['waypoints']) and all(r['passed'] for r in reached),reached),
            check(name+'_all_cycles',completed_cycles==expected_cycles,{'observed':completed_cycles,'expected':expected_cycles}),
            check(name+'_cycle_motion_evidence',all(e['departed'] and e['returned'] for e in cycle_evidence),cycle_evidence),
            check(name+'_within_action_deadline',not any(e.get('event') in ('startup_timeout','timed_out') for e in events),'runtime enforces frozen simulation deadline and bounded wall-clock startup'),
            check(name+'_final_pose',bool(series) and max(abs(series[-1]['positions'][n]-v) for n,v in zip(program['joint_names'],program['waypoints'][-1]['positions']))<=program['tolerance_rad'],'all participating joints at last pose')])
    elif fault in ('command_loss','measurement_loss'):
        after=[s for s in states if s.get('_wall',0)>data['fault_wall']+.8]
        raw_after=[a for a in audit if a.get('kind')=='raw' and a.get('_wall',0)>data['fault_wall']+1.]
        spread=max((max(r['positions'][i] for r in raw_after)-min(r['positions'][i] for r in raw_after) for i in range(len(program['joint_names']))),default=math.inf) if raw_after else math.inf
        checks.extend([check(name+'_watchdog_zero',bool(after) and all(not s['active'] and all(v==0 for v in s['velocities']) for s in after),'core stops all channels after 600ms silence'),
            check(name+'_simulator_stopped',len(raw_after)>10 and spread<.005,{'post_stop_position_spread_rad':spread if math.isfinite(spread) else None})])
    else:
        checks.append(check(name+'_action_cancelled',finished and finished.get('status')==5,'actual FollowJointTrajectory cancellation'))
        tail=series[-20:]
        checks.append(check(name+'_cancel_hold',len(tail)==20 and max(max(s['positions'][n] for s in tail)-min(s['positions'][n] for s in tail) for n in program['joint_names'])<program['tolerance_rad'],'measured positions settle after cancellation'))
    if fault is not None:
        evidence=observed_motion(data,data.get('fault_wall',-math.inf))
        checks.append(check(name+'_fault_during_motion',evidence['moving'],evidence))
    metrics={'name':name,'motion_completed':fault is None and bool(finished) and finished.get('status')==4,
        'waypoints_reached':sum(r['passed'] for r in reached),'total_waypoints':len(program['waypoints']),
        'completed_cycles':len(completed_cycles),'expected_cycles':len(expected_cycles),'waypoints':reached,
        'cycle_evidence':cycle_evidence,
        'namespace':data['namespace'],'duration_s':series[-1]['t'] if series else 0,'trace_file':name+'-trace.json'}
    return checks,metrics,series


class MotionVerifier:
    def __init__(self,supervisor,environment,output,spec,binding):
        import rclpy
        from rclpy.context import Context
        self.supervisor=supervisor;self.environment=environment;self.output=Path(output);self.spec=spec;self.binding=binding
        os.environ['ROS_LOCALHOST_ONLY']='1'
        self.context=Context();rclpy.init(args=[],context=self.context,domain_id=78)

    def close(self):
        self.context.try_shutdown()

    def case(self,name,fault=None):
        from rclpy.node import Node
        from rclpy.executors import SingleThreadedExecutor
        from std_msgs.msg import String
        from rcl_interfaces.srv import SetParameters
        from rcl_interfaces.msg import Parameter,ParameterValue,ParameterType
        namespace='/ae_v5_'+uuid.uuid4().hex[:16]
        observer=Node('verifier',namespace=namespace,context=self.context,enable_rosout=False)
        executor=SingleThreadedExecutor(context=self.context);executor.add_node(observer)
        data={'namespace':namespace,'states':[],'commands':[],'measurements':[],'events':[],'task_events':[],'audit':[],'errors':[]}
        def receive(message,key):
            try:
                item=json.loads(message.data);item['_wall']=time.monotonic();data[key].append(item)
                if item.get('kind')=='error' or item.get('event') in ('bridge_error','protocol_error'):data['errors'].append(item)
            except Exception as error:data['errors'].append(str(error))
        for topic,key in [('state','states'),('command','commands'),('measurement','measurements'),('event','events'),('task_event','task_events'),('physics_audit','audit')]:
            observer.create_subscription(String,topic,lambda m,k=key:receive(m,k),100)
        env=dict(self.environment,IGN_PARTITION=namespace[1:],GZ_PARTITION=namespace[1:])
        processes=[];expected=set();task=None;controller=None;faulted=False;started=time.monotonic()
        model=self.spec['execution_model'];program=self.spec['motion_program']
        package=self.output/'ros_ws'/'install'/'lib'/'ae_generated'
        urdf=generate_urdf_v5(model,program,namespace)
        config=controller_parameters(self.spec,namespace)
        config[namespace+'/controller_manager']['ros__parameters']['robot_description']=urdf
        config_path=self.output/(name+'-controllers.yaml');config_path.write_text(json.dumps(config),encoding='utf-8')
        world=self.output/(name+'.sdf');world.write_text(generate_sdf_v5(model,namespace,program['max_velocity_rad_s']),encoding='utf-8')
        def spawn(args,label):
            process=self.supervisor.spawn(args,self.output/(name+'-'+label+'.log'),env);processes.append(process);return process
        pause_client=observer.create_client(SetParameters,'gazebo_motion/set_parameters')
        cancel_client=observer.create_client(SetParameters,'motion_task/set_parameters')
        injection_future=None
        try:
            gazebo=spawn(['ign','gazebo','-s','-r','-v','3',str(world)],'gazebo')
            spawn(['/opt/ros/humble/lib/ros_gz_bridge/parameter_bridge',*bridge_arguments(namespace,len(program['joint_names'])),'--ros-args','-r','/clock:='+namespace+'/clock'],'gazebo-bridge')
            spawn([str(package/'serial_bridge'),'--ros-args','-r','__ns:='+namespace,'-p','host_binary:='+str(self.output/'ros_ws'/'install'/'lib'/'ae_motion_hardware'/'host_protocol_v5')],'serial')
            spawn([str(package/'gazebo_motion'),'--ros-args','-r','__ns:='+namespace],'physics')
            controller=spawn(['/opt/ros/humble/lib/controller_manager/ros2_control_node','--ros-args','-r','__ns:='+namespace,'--params-file',str(config_path),'-r','/clock:='+namespace+'/clock'],'controller')
            loader=spawn(['/opt/ros/humble/lib/controller_manager/spawner','trajectory','--controller-manager',namespace+'/controller_manager','--controller-manager-timeout','30'],'spawner')
            expected.add(loader.pid)
            next_check=0;post_complete=None
            while True:
                executor.spin_once(timeout_sec=.005)
                now=time.monotonic()
                if now>=next_check:
                    self.supervisor.ensure_active();next_check=now+.05
                    if not data.get('physics_backend_maps'):
                        owned=[gazebo.pid]+[pid for pid,info in self.supervisor.owned_descendants.items() if info['owner']==gazebo.pid]
                        libraries=set()
                        for pid in owned:
                            try:
                                libraries.update(line.rsplit(' ',1)[-1].strip() for line in Path(f'/proc/{pid}/maps').read_text().splitlines() if 'dartsim-plugin' in line)
                            except (FileNotFoundError,PermissionError):pass
                        data['physics_backend_maps']=sorted(libraries)
                    for process in processes:
                        if process.poll() is not None and process.pid not in expected:raise RuntimeError(f'{name}: child {process.pid} exited {process.returncode}; inspect logs')
                    if loader.poll() not in (None,0):raise RuntimeError('trajectory controller failed to activate')
                if task is None and loader.poll()==0 and len(data['states'])>10:
                    args=[str(package/'motion_task'),'--ros-args','-r','__ns:='+namespace,'-p','use_sim_time:=true','-r','/clock:='+namespace+'/clock']
                    task=spawn(args,'task')
                submitted=next((e for e in data['task_events'] if e.get('event')=='submitted'),None)
                if submitted and fault and not faulted and data['states'] and data['states'][-1]['time']-submitted['start_s']>.1 and observed_motion(data,now)['moving']:
                    faulted=True;data['fault_wall']=now
                    if fault=='command_loss':
                        expected.add(controller.pid);self.supervisor.stop(controller)
                    elif fault=='measurement_loss':
                        request=SetParameters.Request();request.parameters=[Parameter(name='pause_measurement',value=ParameterValue(type=ParameterType.PARAMETER_BOOL,bool_value=True))]
                        if not pause_client.service_is_ready():raise RuntimeError('measurement pause service missing')
                        injection_future=pause_client.call_async(request)
                    else:
                        elapsed=data['states'][-1]['time']-submitted['start_s']
                        request=SetParameters.Request();request.parameters=[Parameter(name='cancel_after_s',value=ParameterValue(type=ParameterType.PARAMETER_DOUBLE,double_value=float(elapsed)))]
                        if not cancel_client.service_is_ready():raise RuntimeError('motion cancellation parameter service missing')
                        injection_future=cancel_client.call_async(request)
                if injection_future is not None and injection_future.done():
                    response=injection_future.result()
                    if not response or not response.results or not all(r.successful for r in response.results):raise RuntimeError('fault injection parameter request failed')
                    injection_future=None
                if faulted and now-data['fault_wall']>2.5:break
                completed=next((e for e in data['task_events'] if e.get('event')=='completed'),None)
                if any(e.get('event') in ('startup_timeout','timed_out','rejected') for e in data['task_events']):
                    raise RuntimeError('motion action rejected or exceeded its frozen deadline')
                if completed:
                    post_complete=post_complete or now
                    if now-post_complete>(2. if fault=='cancel' else .6):break
                if task is None and now-started>45:raise TimeoutError('JTC discovery/measurement readiness timeout')
                if submitted and data['states'] and data['states'][-1]['time']-submitted['start_s']>program['timeout_s']+3:break
                if now-started>program['timeout_s']*5+60:raise TimeoutError('motion wall-clock deadline')
        finally:
            for process in reversed(processes):self.supervisor.stop(process)
            drain_until=time.monotonic()+.2
            while time.monotonic()<drain_until:executor.spin_once(timeout_sec=.005)
            executor.shutdown(timeout_sec=1);observer.destroy_node()
            log=(self.output/(name+'-gazebo.log')).read_text(encoding='utf-8',errors='replace')
            data['gazebo_loaded']=bool(data.get('physics_backend_maps')) and '[Err]' not in log
            (self.output/(name+'-trace.json')).write_text(json.dumps(data,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf-8')
        return assess_case(data,program,self.binding['identity'],name,fault)
