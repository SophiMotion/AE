"""Opt-in Sophicore motion admission and deterministic reviewed project generation."""
from __future__ import annotations
import copy
import json
import math
import re
from pathlib import Path

from .structures import get_structure
from .intake_details import mapping_source_fingerprint, source_fingerprints, GROUPS
from .schemas import parse_intake
from .workflow import validate_workflow
from worker.motion_spec_v5 import build_motion_model, compile_motion_program, motion_contract, digest

GENERATOR_VERSION = 'sophicore-taskprogram-v5.1'


def has_motion(value):
    return bool(((value.get('prd') or {}).get('intake') or {}).get('motion_plan'))


def _filled(value):
    if isinstance(value, dict): return any(_filled(v) for v in value.values())
    if isinstance(value, list): return any(_filled(v) for v in value)
    if isinstance(value, str): return bool(value.strip())
    return value is not None


def assess_motion(root, raw):
    form = parse_intake(raw['prd']['intake']).model_dump()
    plan, answers = form['motion_plan'], form['answers']
    missing, invalid, unsupported, resolved = [], [], [], []
    def issue(bucket, path, label, message, section=3):
        bucket.append(dict(path=path,label=label,message=message,section=section))
    path = 'prd.intake.motion_plan'
    for key,label in [('name','工程名称'),('request','原始需求')]:
        if len(str(raw.get(key) or '').strip()) < (5 if key=='request' else 1):
            issue(missing,key,label,'请填写'+label+'。',1)
    if form['mode'] != 'simulation':
        issue(unsupported,'prd.intake.mode','运行范围','本轮只允许本机模拟设备，不连接实物。',4)
    if answers['board'] not in ('esp32','esp32s3'):
        issue(missing,'prd.intake.answers.board','固件编译目标','请选择 ESP32 或 ESP32-S3 编译目标。',4)
    if not plan['reviewed']:
        issue(missing,path+'.reviewed','动作程序核对','请核对每个关节角度、阶段、次数和最后姿势，再确认这份程序对应原始需求。')
    model = program = structure = None
    try:
        structure = get_structure(root, answers['structure_id'])
        if plan['model_source_sha256'] != mapping_source_fingerprint(root,structure):
            raise ValueError('动作程序绑定的结构版本已变化，请重新选取姿势并核对。')
        model = build_motion_model(structure, plan['joint_names'])
        program = compile_motion_program(plan, model)
        resolved.append({'path':path,'label':'本次实际执行的多关节程序','value':program,'origin':'user','unit':None})
    except (ValueError, TypeError, KeyError) as error:
        issue(invalid,path,'多关节程序',str(error))
    action = form.get('action_draft')
    if action:
        if structure and action.get('model_source_sha256') and action['model_source_sha256'] not in source_fingerprints(root,structure):
            issue(invalid,'prd.intake.action_draft','原动作模型版本','原动作说明绑定了另一版结构，请重新整理并核对，不能沿用旧姿势。')
        if any(x.strip() for x in action['unresolved']):
            issue(missing,'prd.intake.action_draft.unresolved','原动作待核对事项','原动作说明仍有待核对内容；采用路点不会自动删除这些要求。')
        for index,stage in enumerate(action['stages']):
            if stage['confirmation_needed']:
                issue(missing,f'prd.intake.action_draft.stages.{index}.confirmation_needed','原动作阶段核对','请核对原动作阶段与实际执行程序是否一致。')
            if (stage.get('repetitions') or 1)>1:
                cycles=max((row['cycle_index'] for row in plan['waypoints']),default=0)
                if cycles!=stage['repetitions']:
                    issue(invalid,path+'.waypoints','原动作往返次数','原动作要求的往返次数与执行程序不一致，请修改路点或明确修正原要求。')
            if program and stage.get('target_rad') is not None:
                names=stage['joint_names']
                if len(names)!=1 or names[0] not in plan['joint_names'] or not any(
                    abs(row['positions'][plan['joint_names'].index(names[0])]-stage['target_rad'])<1e-8
                    for row in plan['waypoints']):
                    issue(invalid,path+'.waypoints','原动作目标角度','原动作中已有的具体角度没有进入执行路点，请重新核对；不会忽略该数值。')
        old_names={j['name'] for j in action['related_joints']}
        if not old_names.issubset(set(plan['joint_names'])):
            issue(invalid,path+'.joint_names','控制关节','执行程序遗漏了原动作清单中的关节，请修改程序或明确核对原动作。')
    # Additional custom behavior is retained, but not silently executed as a route.
    coverage=[]
    for group,(label,section) in GROUPS.items():
        detail=form['details'][group]
        if group=='motion':
            custom=detail['pattern'] in ('sequence','parallel') or detail['completion']=='custom' or bool(detail['steps']) or bool(detail['completion_note'].strip())
        elif group=='device_mapping':
            custom=detail['scope']=='required' or (bool(detail['entries']) and detail['scope']!='reference_only')
            for index,entry in enumerate(detail['entries']):
                if entry['status']=='documented' and not entry['source'].strip():
                    issue(invalid,f'prd.intake.details.device_mapping.entries.{index}.source',label,'有出处的硬件对应资料需填写来源。',section)
        else:
            custom=detail.get('selection')=='custom' or _filled({k:v for k,v in detail.items() if k!='selection'})
        if custom:
            issue(unsupported,'prd.intake.details.'+group,label,'这组额外要求尚未映射到 V5 路点/固定测试；已保留，不能用采用参考动作覆盖。',section)
        reference=group=='device_mapping' and detail['scope']=='reference_only'
        coverage.append({'group':group,'label':label,'section':section,'status':'unsupported' if custom else 'reference_only' if reference else 'confirmed',
            'summary':'补充要求需另行适配' if custom else '硬件对应仅保存参考，不参与本轮控制或作为已接线证明。' if reference else '采用本次 V5 多关节软件契约；实际运行后才判定通过',
            'fields':copy.deepcopy(detail)})
    for key,note in form['hardware_notes'].items():
        if note['status']=='documented' and (not note['source'].strip() or not note['value'].strip()):
            issue(invalid,'prd.intake.hardware_notes.'+key,'硬件资料出处','有出处的资料需同时填写内容和来源。',4)
    # Clearly unsupported task families must not be erased by choosing the route recipe.
    if re.search(r'导航|抓取|行走|走路|避障|抓住|搬运', raw.get('request','')):
        issue(unsupported,'request','原始需求','本轮仅接 Sophicore 关节动作；原文还含未适配的移动、感知或抓取要求。',1)
    try: validate_workflow(raw.get('workflow'))
    except ValueError as error: issue(invalid,'workflow','工程流程',str(error),5)
    ready=not (missing or invalid or unsupported)
    result={'schema_version':2,'status':'ready_for_plan' if ready else 'unsupported' if unsupported else 'incomplete',
        'can_save':True,'can_plan':ready,'execution_task':'joint_sequence' if ready else None,
        'missing':missing,'invalid':invalid,'unsupported':unsupported,'resolved':resolved,'detail_coverage':coverage,
        'notice':'确认动作路点后仍需核对两端分工，再生成、编译和实际仿真；没有实物运行。',
        'summary':{'action':f"多关节程序：{len(plan['joint_names'])} 个关节，{len(plan['waypoints'])} 个路点",
            'model':(structure or {}).get('name',(structure or {}).get('id','结构待确认')),
            'device':answers['board'] or '板型待选','criteria':'逐路点、阶段、往返次数、结束姿势与通信异常独立检查',
            'scope':'本机固定底座、零重力多关节软件台架；不连接实物','details':coverage}}
    return result, structure, model, program


def materialize_motion(root, raw):
    readiness, structure, model, program=assess_motion(root,raw)
    form=parse_intake(raw['prd']['intake']).model_dump(); a=form['answers']
    prd={**raw['prd'],'intake':form,'structure_id':a['structure_id'],'joint_name':a['joint_name']}
    out={'name':raw['name'],'request':raw['request'],'prd':prd,'task_type':'joint_sequence','pipeline_version':5,
        'parameters':{'duration':form['motion_plan']['timeout_s'],'tolerance':form['motion_plan']['tolerance_rad'],
            'max_velocity':form['motion_plan']['max_velocity_rad_s'],'max_acceleration':form['motion_plan']['max_acceleration_rad_s2']},
        'hardware':{'board':a['board'],'ros_distro':'humble','transport':'serial_motion_v5','baudrate':921600,
            'actuator':'virtual_joint_array','sensor':'simulated_encoders','physical_io':False},
        'structure':structure,'workflow':validate_workflow(raw.get('workflow')), 'execution_model':None,'motion_program':None,'manifest':None}
    if readiness['can_plan']:
        out.update(execution_model=model,motion_program=program)
        out['manifest']=build_motion_manifest(out)
    return out


def build_motion_manifest(spec):
    contract=motion_contract(spec)
    from worker.firmware import FQBNS,CORE_VERSION,LIBRARY_VERSION
    board=spec['hardware']['board']
    if board not in FQBNS or spec['hardware'].get('physical_io') is not False:
        raise ValueError('需要明确的 ESP 编译目标，并保持虚拟输入输出。')
    result={'schema_version':5,'task_type':'joint_sequence','model_sha256':spec['execution_model']['model_sha256'],
        'program_sha256':spec['motion_program']['program_sha256'],'protocol_sha256':contract['communication']['protocol_sha256'],
        'active_joint_names':spec['motion_program']['joint_names'], 'selected_joint':None,
        'workflow_hash':spec['workflow']['hash'],'execution_order':spec['workflow']['execution_order'],
        'modules':[{'id':'ros','label':'ROS 多关节轨迹工程','runtime':'ROS 2 Humble','language':'Python / C++','role':'执行已核对的路点和轨迹',
            'generated_scope':'类型化任务程序和固定 ROS 模板；不是任意 AI 源码'},
            {'id':'esp32','label':'ESP32 多通道固件','board':board,'fqbn':FQBNS[board],'role':'原子命令检查、位置伺服和反馈；本轮虚拟设备'},
            {'id':'connection','label':'多通道通信','identity':contract['communication']['identity'],'transport':'serial_motion_v5','baudrate':921600}],
        'dependencies':{'ros_distro':'humble','esp32_core':CORE_VERSION,'arduinojson':LIBRARY_VERSION},
        'preflight':{'passed':True,'scope':'仅规格检查；实际编译运行另行验收','checks':[
            {'id':'program','passed':True,'label':'路点已通过模型范围和速度检查','detail':'需要人工核对后实际运行'},
            {'id':'scope','passed':True,'label':'本机模拟设备','detail':'固定底座、零重力；没有接线或实物控制'}]},
        'missing_for_hardware':['板型细节与接线','实际驱动及反馈标定','板上性能与实物动作验收'],
        'provenance':{'kind':'deterministic_motion_program','tool':GENERATOR_VERSION}}
    result['hash']=digest(result)
    return result


def motion_recipe(root, structure_id, side='right', cycles=3):
    if side not in ('right','left') or type(cycles) is not int or not 1<=cycles<=10:
        raise ValueError('请选择左/右臂，以及 1 到 10 次往返。')
    structure=get_structure(root,structure_id)
    limb='arm_r' if side=='right' else 'arm_l'
    names=[limb+'_'+suffix for suffix in ('shoulder_lift','shoulder_swing','arm_twist','elbow_bend','wrist_rotation','clamp')]
    model=build_motion_model(structure,names)
    velocity,acceleration=math.radians(30),1.
    initial=[next(j['initial_position'] for j in model['joints'] if j['name']==name) for name in names]
    # Authored model-space example, explicitly offered for visual human review.
    pose_a=list(map(math.radians,[55,-10,-15,75,-20,0]))
    pose_b=list(map(math.radians,[55,-10,15,75,20,0]))
    down=list(map(math.radians,[5,-5,0,5,0,0]))
    rows=[]; previous=initial;stamp=0.
    def add(positions,stage,cycle):
        nonlocal stamp,previous
        delta=max(abs(a-b) for a,b in zip(positions,previous))
        dt=max(1.,1.875*delta/velocity,math.sqrt((10/math.sqrt(3))*delta/acceleration))+.2
        stamp=round(stamp+dt,3)
        rows.append({'positions':positions,'time_from_start_s':stamp,'stage_id':stage,'cycle_index':cycle})
        previous=positions
    add(pose_a,'prepare',0)
    for cycle in range(1,cycles+1):
        add(pose_b,'wave_b',cycle);add(pose_a,'wave_a',cycle)
    add(down,'finish',0)
    p={'schema_version':1,'recipe_id':'sophicore-'+side+'-wave-v1','model_source_sha256':mapping_source_fingerprint(root,structure),
        'reviewed':False,'joint_names':names,'waypoints':rows,'tolerance_rad':math.radians(2),
        'max_velocity_rad_s':velocity,'max_acceleration_rad_s2':acceleration,'timeout_s':round(stamp+4,3)}
    compile_motion_program(p,model)
    return {'motion_plan':p,'label':('右' if side=='right' else '左')+f'臂抬起、招手 {cycles} 次、放下参考动作',
        'structure_id':structure_id,'source':{'kind':'authored_model_reference','tool':GENERATOR_VERSION,
            'model_source_sha256':p['model_source_sha256'],'ai_generated':False},
        'notes':['这组角度是可修改的模型参考动作，请在 3D 中核对抬手与放下姿势。',
            '每次 A→B→A 为一次往返；到位由实际反馈检查，不是仅发送目标。',
            '放下角度是明确的参考姿势，不等于机械零位或实物标定。原始文字与额外要求保留。']}


def motion_coverage(spec):
    """Record explicit human mapping, not an invented semantic AI assessment."""
    from .requirements import source_fields
    program=spec['motion_program']; motion_contract(spec)
    checks=[
        ('motion_waypoints','每个阶段到位',f"{len(program['waypoints'])} 个路点，全部关节误差不超过 {program['tolerance_rad']} rad"),
        ('motion_order','阶段与往返次数','按路点时间、阶段和循环编号，从实际反馈逐项判断'),
        ('motion_limits','速度与加速度','轨迹与设备输出分别检查配置上限'),
        ('ros_build','ROS 工程构建','colcon 真实构建退出码为 0'),
        ('esp_build','ESP 固件构建','选定通用目标产生 BIN/ELF；未烧录或板上运行'),
        ('communication','两端通信','同一身份、完整关节向量、序号、时间、坏包拒绝和失联归零'),
        ('local_scope','测试范围','固定底座、零重力、无接线的多关节软件台架'),
    ]
    items=[{'id':'requirement-'+str(i+1),'source_field':key,'text':value,'status':'covered',
        'check_ids':['motion_waypoints','motion_order','motion_limits','local_scope'],
        'reason':'用户已确认原文与下面的明确路点一致；平台只自动检查路点和固定测试，不把文字理解当成已验证。'}
        for i,(key,value) in enumerate(source_fields(spec).items()) if value.strip()]
    return {'schema_version':5,'scope':'用户核对原文与路点的对应；数值由固定观察器验收。',
        'checks':[{'id':key,'label':label,'expected':expected} for key,label,expected in checks],
        'items':items,'blocking_issues':[],
        'review_note':'请对照原始需求逐项确认实际关节、路点、循环和最后姿势。额外任务不能靠文字自动变成已实现的能力。'}


def deterministic_plan(spec, sources):
    program=spec['motion_program']; contract=motion_contract(spec)
    return {'ros_tasks':['根据已核对的完整路点生成 ROS 2 多关节轨迹工程。',
            '使用 joint_trajectory_controller，读取仿真实际反馈检查每个阶段。'],
        'esp32_tasks':['生成固定多通道协议核心与选定板型工程，真实编译固件。',
            '共享核心在主机运行虚拟设备，检查限幅、序号、坏包和失联处理。'],
        'communication':['ROS 发送完整位置向量，设备核心返回位置与速度。',
            '模型、动作程序、协议和关节顺序必须一致；任一不符均拒绝。'],
        'checks':[c['label']+'：'+c['expected'] for c in motion_coverage(spec)['checks']],
        'missing_information':[],'citations':[], 'blocking_issues':[],
        'motion_program':copy.deepcopy(program),'identity':contract['communication']['identity'],
        'requirement_coverage':motion_coverage(spec),
        'provenance':{'kind':'deterministic_motion_program','tool':GENERATOR_VERSION,'ai_generated':False,
            'prompt':None,'source':'用户核对的 motion_plan 与受保护的固定模板；本轮没有调用 AI 服务'},
        'scope':'本机 ROS / Gazebo 与共享 ESP 固件核心。没有实际 ESP 板、接线、板上运行或实物动作验收。'}


def generated_sources(spec):
    """The only generated Python value is data; it is never evaluated as code."""
    from pprint import pformat
    from worker.firmware_v5 import generated_device_logic
    motion_contract(spec)
    code='# Generated by '+GENERATOR_VERSION+'; approved data only.\nMOTION_PROGRAM = '+pformat(spec['motion_program'],sort_dicts=True,width=100)+'\n'
    return {'code':code,'firmware_code':generated_device_logic(spec),
        'explanation':'按已批准的完整动作程序与固定 ROS/ESP 模板生成；没有使用 AI 生成任意执行代码。',
        'provenance':{'kind':'deterministic_motion_program','tool':GENERATOR_VERSION,'ai_generated':False,
            'prompt':None,'program_sha256':spec['motion_program']['program_sha256']}}


PROTOCOL_CHECKS = frozenset('protocol_v5_'+suffix for suffix in (
    'requires_handshake','wrong_identity','fragmented_handshake','vector_applied','atomic_rejection',
    'each_bad_frame_rejected','bad_frame_recovery','command_watchdog','command_recovery',
    'measurement_watchdog','measurement_alone_no_restart','full_recovery','velocity_limit','state_identity','no_fake_feedback'))
MOTION_CASES = ('motion_1','motion_2','motion_3','command_loss','measurement_loss','cancel')
COMMON_CASE_CHECKS = ('observed_all_channels','no_runtime_errors','action_identity','gazebo_backend_loaded',
    'gazebo_measurement_path','same_core_feedback','core_actuator_path','velocity_bound','measured_velocity_bound','acceleration_bound','simulator_roundoff_only')


def required_result_checks():
    names={'frozen_motion_source','ros_build','esp32_and_s3_builds','owned_process_cleanup',*PROTOCOL_CHECKS}
    for case in MOTION_CASES:
        suffixes=COMMON_CASE_CHECKS + (('jtc_succeeded','all_waypoints','all_cycles','final_pose','cycle_motion_evidence','within_action_deadline') if case.startswith('motion_')
            else ('fault_during_motion','action_cancelled','cancel_hold') if case=='cancel' else ('fault_during_motion','watchdog_zero','simulator_stopped'))
        names.update(case+'_'+suffix for suffix in suffixes)
    return names


def _file_evidence_valid(row, output=None):
    from pathlib import PurePosixPath
    if not isinstance(row,dict) or not isinstance(row.get('path'),str): return False
    path=PurePosixPath(row['path'])
    if path.is_absolute() or '\\' in row['path'] or ':' in row['path'] or '..' in path.parts:
        return False
    if type(row.get('size')) is not int or row['size']<=0 or not re.fullmatch('[a-f0-9]{64}',str(row.get('sha256',''))):
        return False
    if output is not None:
        from .integrity import file_hash
        target=Path(output)/row['path'];base=Path(output).resolve()
        if not target.resolve().is_relative_to(base) or target.is_symlink() or not target.is_file(): return False
        if target.stat().st_size!=row['size'] or file_hash(target)!=row['sha256']: return False
    return True


def _replayed_series_equal(replayed, recorded):
    """Only derived quintic targets tolerate cross-platform libm rounding.

    The observer's measured positions, velocities, commands, times and stage
    identity remain exact, including their JSON types and complete structure.
    This numerical reconstruction allowance is not an acceptance tolerance.
    """
    def equal(left,right,derived=False):
        if type(left) is not type(right):return False
        if isinstance(left,dict):
            return left.keys()==right.keys() and all(equal(value,right[key],derived) for key,value in left.items())
        if isinstance(left,list):
            return len(left)==len(right) and all(equal(a,b,derived) for a,b in zip(left,right))
        if derived:
            return type(left) in (int,float) and math.isfinite(left) and math.isfinite(right) and math.isclose(left,right,rel_tol=0.,abs_tol=1e-12)
        if isinstance(left,float) and (not math.isfinite(left) or not math.isfinite(right)):return False
        return left==right
    if type(replayed) is not list or type(recorded) is not list or len(replayed)!=len(recorded):return False
    for expected,actual in zip(replayed,recorded):
        if type(expected) is not dict or type(actual) is not dict or expected.keys()!=actual.keys():return False
        if any(not equal(value,actual[key],key in ('target','targets')) for key,value in expected.items()):return False
    return True


def _motion_trace_valid(program, result, output=None):
    cases=result['metrics'].get('cases')
    if not isinstance(cases,list) or len(cases)!=len(MOTION_CASES) or [c.get('name') for c in cases if isinstance(c,dict)]!=list(MOTION_CASES): return False
    namespaces=[c.get('namespace') for c in cases]
    if any(not isinstance(n,str) or not re.fullmatch('/ae_v5_[a-f0-9]{16}',n) for n in namespaces) or len(set(namespaces))!=6: return False
    for case in cases:
        if case.get('trace_file')!=case['name']+'-trace.json': return False
        if output is not None:
            trace=Path(output)/case['trace_file']
            if trace.is_symlink() or not trace.is_file() or trace.stat().st_size==0: return False
            # Re-evaluate the stored observer trace. A nonempty '{}' file and
            # hand-written success booleans cannot substitute for observations.
            try:
                from worker.verification_motion_v5 import assess_case
                data=json.loads(trace.read_text(encoding='utf-8'))
                if not isinstance(data,dict) or data.get('namespace')!=case['namespace']:return False
                replay_checks,replay_metrics,replay_series=assess_case(data,program,result['identity'],case['name'],
                    None if case['name'].startswith('motion_') else case['name'])
                if replay_metrics!=case or any(c.get('passed') is not True for c in replay_checks):return False
                actual={c['name']:c for c in result['checks']}
                if any(actual.get(c['name'])!=c for c in replay_checks):return False
                if case['name']=='motion_1' and not _replayed_series_equal(replay_series,result.get('series')):return False
            except (ValueError,TypeError,KeyError,IndexError,AttributeError,OSError,ImportError):
                return False
        if case['name'].startswith('motion_'):
            count=len(program['waypoints']);cycles=max(r['cycle_index'] for r in program['waypoints'])
            if case.get('motion_completed') is not True or case.get('waypoints_reached')!=count or case.get('total_waypoints')!=count or case.get('completed_cycles')!=cycles or case.get('expected_cycles')!=cycles: return False
            rows=case.get('waypoints')
            if not isinstance(rows,list) or len(rows)!=count:return False
            for index,(observed,target) in enumerate(zip(rows,program['waypoints'])):
                if not isinstance(observed,dict) or observed.get('index')!=index or observed.get('stage_id')!=target['stage_id'] or observed.get('cycle_index')!=target['cycle_index'] or observed.get('passed') is not True:return False
                error=observed.get('max_position_error_rad')
                if type(error) not in (float,int) or not math.isfinite(error) or not 0<=error<=program['tolerance_rad']:return False
            observed_cycles=case.get('cycle_evidence')
            if not isinstance(observed_cycles,list) or len(observed_cycles)!=cycles:return False
            if any(not isinstance(c,dict) or c.get('cycle_index')!=i+1 or c.get('departed') is not True or c.get('returned') is not True for i,c in enumerate(observed_cycles)):return False
    series=result.get('series');names=program['joint_names']
    if result.get('joint_names')!=names or not isinstance(series,list) or len(series)<26:return False
    previous=-1.
    for row in series:
        if not isinstance(row,dict):return False
        stamp=row.get('time',row.get('t'))
        if type(stamp) not in (int,float) or not math.isfinite(stamp) or stamp<0 or stamp<previous:return False
        previous=stamp
        for field in ('positions','targets','commands'):
            values=row.get(field)
            if isinstance(values,dict):
                if set(values)!=set(names):return False
                values=list(values.values())
            if not isinstance(values,list) or len(values)!=len(names) or any(type(v) not in (int,float) or not math.isfinite(v) for v in values):return False
    return True


def result_evidence_valid(spec, result, output=None):
    """No success flag can replace the separate build/runtime evidence."""
    from worker.firmware import FQBNS
    contract=motion_contract(spec);identity=contract['communication']['identity']; board=spec['hardware']['board']
    checks=result.get('checks')
    if any(not isinstance(result.get(k),dict) for k in ('workflow','firmware','communication_test','execution_model','motion_program','metrics')):
        return False
    if not isinstance(checks,list) or any(not isinstance(c,dict) or c.get('passed') is not True for c in checks):return False
    named=[c.get('name') for c in checks]
    if any(not isinstance(n,str) for n in named) or len(set(named))!=len(named) or not required_result_checks().issubset(set(named)):return False
    protocol=result['communication_test'].get('checks')
    if not isinstance(protocol,list) or len(protocol)!=len(PROTOCOL_CHECKS) or any(not isinstance(c,dict) or c.get('passed') is not True for c in protocol) or {c.get('name') for c in protocol}!=PROTOCOL_CHECKS:return False
    if any(next(c for c in checks if c['name']==p['name'])!=p for p in protocol):return False
    builds=result['firmware'].get('boards')
    if not isinstance(builds,list) or len(builds)!=len(FQBNS) or {b.get('board') for b in builds if isinstance(b,dict)}!=set(FQBNS):return False
    for build in builds:
        if build.get('passed') is not True or type(build.get('exit_code')) is not int or build['exit_code']!=0 or build.get('fqbn')!=FQBNS[build['board']]:return False
        artifacts=build.get('artifacts')
        if not isinstance(artifacts,list) or not artifacts or any(not _file_evidence_valid(a,output) for a in artifacts):return False
        if any(not a['path'].startswith('esp32/artifacts/'+build['board']+'/') for a in artifacts):return False
        if not any(a['path'].endswith('.bin') for a in artifacts) or not any(a['path'].endswith('.elf') for a in artifacts):return False
    native=result.get('native_core_build')
    if not isinstance(native,dict) or native.get('passed') is not True or native.get('exit_code')!=0 or not _file_evidence_valid(native.get('binary'),output):return False
    if not _motion_trace_valid(spec['motion_program'],result,output):return False
    stages={'ros_build','esp_build','communication','simulation','report'}
    return (result.get('pipeline_version')==5
        and result.get('engine')=='ros2_jtc_gazebo_fortress_multi_joint_shared_core'
        and result.get('ros_verified') is True and result.get('physics_simulation_verified') is True
        and isinstance(checks,list) and bool(checks) and all(isinstance(c,dict) and c.get('passed') is True for c in checks)
        and result.get('identity')==identity
        and result.get('execution_order')==[s for s in spec['workflow']['execution_order'] if s in stages]
        and result.get('workflow',{}).get('hash')==spec['workflow']['hash']
        and result.get('firmware',{}).get('passed') is True and result.get('firmware',{}).get('identity')==identity
        and result.get('firmware',{}).get('board')==board and result.get('firmware',{}).get('fqbn')==FQBNS[board]
        and result.get('communication_test',{}).get('passed') is True and result.get('communication_test',{}).get('identity')==identity
        and result.get('execution_model',{}).get('model_sha256')==identity['model_sha256']
        and result.get('execution_model',{}).get('active_joint_names')==identity['joint_names']
        and result.get('motion_program',{}).get('program_sha256')==identity['program_sha256']
        and result.get('metrics',{}).get('cleanup',{}).get('all_exited') is True)
