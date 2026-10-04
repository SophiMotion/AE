"""Lifecycle unit tests use a declared worker double; no ROS success is claimed."""
import ast
import copy
import hashlib
import json
import threading

import pytest
from server import motion_v5, providers
from server.integrity import protected_snapshot, verify_run_integrity, IntegrityError
from server.jobs import Jobs
from server.store import Store, specification, spec_hash
from server.workflow import default_workflow
from test_motion_v5_api import draft
from test_motion_v5_spec import source
from worker.firmware import FQBNS


@pytest.fixture
def case(tmp_path,monkeypatch):
    monkeypatch.setattr(motion_v5,'get_structure',lambda *a,**k: source())
    p=motion_v5.materialize_motion(tmp_path,draft(tmp_path))
    p.update(id='p',spec_revision=1,status='approved',created_at='test')
    p['plan']=motion_v5.deterministic_plan(specification(p),[])
    p['plan'].update(plan_id='plan',spec_hash=spec_hash(p))
    p['approval']={'spec_revision':1,'spec_hash':spec_hash(p),'plan_id':'plan'}
    store=Store(tmp_path/'test.sqlite3');store.put('project',p)
    jobs=Jobs(tmp_path,store,lambda:{})
    run={'id':'run','project_id':'p','status':'queued','attempt':0,'created_at':'test',
        'spec_snapshot':specification(p),'approval':p['approval'],'events':[],
        'provenance':[],'code_versions':[],'artifacts':[],'result':None,'deployment':None}
    store.put('run',run)
    yield jobs,store,p,run
    jobs.close()


def evidence(spec):
    identity=spec['communication']['identity'];board=spec['hardware']['board']
    program=spec['motion_program']
    checks=[{'name':name,'passed':True,'detail':'unit worker double'} for name in sorted(motion_v5.required_result_checks())]
    fixture_hash=hashlib.sha256(b'unit fixture bytes').hexdigest()
    file=lambda path:{'path':path,'size':len(b'unit fixture bytes'),'sha256':fixture_hash}
    cases=[{'name':name,'namespace':'/ae_v5_'+format(i,'016x'),'trace_file':name+'-trace.json',
        'motion_completed':name.startswith('motion_'),'waypoints_reached':len(program['waypoints']),
        'total_waypoints':len(program['waypoints']),'completed_cycles':max(r['cycle_index'] for r in program['waypoints']),
        'expected_cycles':max(r['cycle_index'] for r in program['waypoints']),
        'cycle_evidence':[{'cycle_index':k,'departed':True,'returned':True} for k in range(1,max(r['cycle_index'] for r in program['waypoints'])+1)],
        'waypoints':[{'index':k,'stage_id':r['stage_id'],'cycle_index':r['cycle_index'],'passed':True,'max_position_error_rad':.001} for k,r in enumerate(program['waypoints'])]}
        for i,name in enumerate(motion_v5.MOTION_CASES)]
    return {'pipeline_version':5,'engine':'ros2_jtc_gazebo_fortress_multi_joint_shared_core',
        'passed':True,'ros_verified':True,'physics_simulation_verified':True,
        'checks':checks, 'identity':copy.deepcopy(identity),
        'execution_order':[x for x in spec['workflow']['execution_order'] if x in {'ros_build','esp_build','communication','simulation','report'}],
        'workflow':spec['workflow'],'execution_model':spec['execution_model'],'motion_program':spec['motion_program'],
        'firmware':{'passed':True,'identity':copy.deepcopy(identity),'board':board,'fqbn':FQBNS[board],
            'boards':[{'board':b,'fqbn':q,'passed':True,'exit_code':0,'artifacts':[
                file('esp32/artifacts/'+b+'/firmware.bin'),file('esp32/artifacts/'+b+'/firmware.elf')]} for b,q in FQBNS.items()]},
        'communication_test':{'passed':True,'identity':copy.deepcopy(identity),'checks':[c for c in checks if c['name'] in motion_v5.PROTOCOL_CHECKS]},
        'metrics':{'cleanup':{'all_exited':True},'cases':cases},
        'native_core_build':{'passed':True,'exit_code':0,'binary':file('esp32/host_protocol_v5')},
        'joint_names':program['joint_names'],
        'series':[{'time':i*.2,'positions':program['initial_positions'],'targets':program['initial_positions'],'commands':[0.]*len(program['joint_names'])} for i in range(30)]}


@pytest.mark.parametrize('field',['identity','workflow','firmware','communication_test','execution_model','motion_program','metrics','checks'])
def test_result_missing_required_independent_evidence_is_not_accepted(case,field):
    _,_,_,run=case;spec=run['spec_snapshot'];result=evidence(spec)
    assert motion_v5.result_evidence_valid(spec,result)
    result.pop(field)
    assert not motion_v5.result_evidence_valid(spec,result)


@pytest.mark.parametrize('mutate',[
    lambda r:r.update(checks=[{'name':'arbitrary','passed':True}]),
    lambda r:r['metrics']['cases'].pop(),
    lambda r:r['metrics']['cases'][0].update(completed_cycles=999),
    lambda r:r['metrics']['cases'][0]['waypoints'][0].update(max_position_error_rad=.9),
    lambda r:r['communication_test']['checks'].pop(),
    lambda r:r['firmware']['boards'][0].update(artifacts=[]),
    lambda r:r['firmware']['boards'][0]['artifacts'][0].update(size=0),
    lambda r:r['firmware']['boards'][1].update(board='esp32'),
    lambda r:r['native_core_build'].update(passed=False),
    lambda r:r.update(series=[]),
])
def test_v5_success_needs_full_specific_evidence_not_flags(case,mutate):
    _,_,_,run=case;spec=run['spec_snapshot'];result=evidence(spec)
    mutate(result)
    assert not motion_v5.result_evidence_valid(spec,result)


@pytest.mark.parametrize('name',[
    *(case+'_gazebo_measurement_path' for case in motion_v5.MOTION_CASES),
    *(case+'_fault_during_motion' for case in ('command_loss','measurement_loss','cancel')),
])
def test_v5_requires_simulator_measurement_origin_and_active_fault_injection(case,name):
    _,_,_,run=case;spec=run['spec_snapshot'];result=evidence(spec)
    assert motion_v5.result_evidence_valid(spec,result)
    result['checks']=[item for item in result['checks'] if item['name']!=name]
    assert not motion_v5.result_evidence_valid(spec,result)


def replay_sample():
    return [{'t':4.588,'time':4.588,'positions':{'a':.9},'targets':{'a':.9579111132400319},
        'velocities':{'a':.058},'commands':{'a':.058},'stage_id':'prepare','cycle_index':0,
        'value':.9,'target':.9579111132400319,'command':.058}]


def test_reconstructed_quintic_target_allows_only_platform_roundoff():
    replayed=replay_sample();recorded=copy.deepcopy(replayed)
    recorded[0]['targets']['a']=.9579111132400311
    recorded[0]['target']=.9579111132400311
    assert motion_v5._replayed_series_equal(replayed,recorded)
    recorded[0]['targets']['a']+=2e-12
    assert not motion_v5._replayed_series_equal(replayed,recorded)


@pytest.mark.parametrize('field',['positions','velocities','commands','time','t','value','command','stage_id','cycle_index'])
def test_replayed_measured_fields_stay_exact(field):
    replayed=replay_sample();recorded=copy.deepcopy(replayed)
    old=recorded[0][field]
    if isinstance(old,dict):old['a']+=1e-15
    elif isinstance(old,str):recorded[0][field]='different'
    elif isinstance(old,int):recorded[0][field]+=1
    else:recorded[0][field]+=1e-15
    assert not motion_v5._replayed_series_equal(replayed,recorded)


@pytest.mark.parametrize('bad',[float('nan'),float('inf'),-float('inf'),True,None,'0.95',1,[],{}])
@pytest.mark.parametrize('field',['target','targets'])
def test_replayed_target_rejects_invalid_numbers_and_type_changes(field,bad):
    replayed=replay_sample();recorded=copy.deepcopy(replayed)
    if field=='targets':recorded[0][field]['a']=bad
    else:recorded[0][field]=bad
    assert not motion_v5._replayed_series_equal(replayed,recorded)


def test_replayed_structure_and_numeric_types_remain_exact():
    replayed=replay_sample();recorded=copy.deepcopy(replayed)
    recorded[0]['cycle_index']=False
    assert not motion_v5._replayed_series_equal(replayed,recorded)
    recorded=copy.deepcopy(replayed);recorded[0]['targets']['unexpected']=0.
    assert not motion_v5._replayed_series_equal(replayed,recorded)
    assert not motion_v5._replayed_series_equal(replayed,[])
    recorded=copy.deepcopy(replayed);recorded[0]['extra']=None
    assert not motion_v5._replayed_series_equal(replayed,recorded)


def test_binary_evidence_is_checked_against_actual_output(case,tmp_path):
    _,_,_,run=case;spec=run['spec_snapshot'];result=evidence(spec)
    assert not motion_v5.result_evidence_valid(spec,result,tmp_path)
    for build in result['firmware']['boards']:
        for item in build['artifacts']:
            path=tmp_path/item['path'];path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b'unit fixture bytes')
    (tmp_path/result['native_core_build']['binary']['path']).write_bytes(b'unit fixture bytes')
    for case in result['metrics']['cases']:
        (tmp_path/case['trace_file']).write_text('{}')
    # Even correctly hashed binaries do not turn empty trace files into proof.
    assert not motion_v5.result_evidence_valid(spec,result,tmp_path)
    assert motion_v5._file_evidence_valid(result['firmware']['boards'][0]['artifacts'][0],tmp_path)
    (tmp_path/result['firmware']['boards'][0]['artifacts'][0]['path']).write_bytes(b'tampered')
    assert not motion_v5.result_evidence_valid(spec,result,tmp_path)
    assert not motion_v5._file_evidence_valid(result['firmware']['boards'][0]['artifacts'][0],tmp_path)


def test_v5_artifacts_generated_once_without_ai_then_bound_to_export(case,monkeypatch):
    jobs,store,p,run=case
    monkeypatch.setattr(providers,'generate_code',lambda *a,**k:pytest.fail('V5 must not call AI'))
    calls=[]
    def execute(pid,rid,specpath,code,out,cancel):
        spec=json.loads(specpath.read_text(encoding='utf-8'));calls.append(spec)
        node=ast.parse(code.read_text(encoding='utf-8'))
        assert len(node.body)==1 and isinstance(node.body[0],ast.Assign)
        assert ast.literal_eval(node.body[0].value)==spec['motion_program']
        result=evidence(spec)
        (out/'result.json').write_text(json.dumps(result),encoding='utf-8')
        return result
    monkeypatch.setattr(jobs,'execute',execute)
    jobs._run(p,run,{},threading.Event(),None)
    saved=store.get('run','run')
    assert saved['status']=='passed',saved.get('error')
    assert len(calls)==1 and saved['attempt']==1
    assert saved['provenance'][0]['ai_generated'] is False
    assert saved['provenance'][0]['prompt'] is None
    assert verify_run_integrity(jobs.root,saved)['identity']==saved['spec_snapshot']['communication']['identity']
    (jobs.root/'runs'/'run'/'attempt-1'/'algorithm.py').write_text('MOTION_PROGRAM = {}',encoding='utf-8')
    with pytest.raises(IntegrityError): verify_run_integrity(jobs.root,saved)


def test_failed_v5_does_not_rewrite_approved_program(case,monkeypatch):
    jobs,store,p,run=case;calls=[]
    def execute(*args,**kwargs):
        calls.append(1);return {'passed':False,'checks':[{'name':'real_failure','passed':False}]}
    monkeypatch.setattr(jobs,'execute',execute)
    jobs._run(p,run,{},threading.Event(),None)
    result=store.get('run','run')
    assert result['status']=='failed' and len(calls)==1 and result['attempt']==1
    assert result['spec_snapshot']['motion_program']==run['spec_snapshot']['motion_program']


def test_precancelled_motion_never_generates_or_launches(case,monkeypatch):
    jobs,store,p,run=case
    monkeypatch.setattr(motion_v5,'generated_sources',lambda *a:pytest.fail('must not generate'))
    token=threading.Event();token.set();jobs._run(p,run,{},token,None)
    assert store.get('run','run')['status']=='cancelled'


def test_original_protected_dependency_set_does_not_expand_to_new_executor(tmp_path):
    folder=tmp_path/'worker';folder.mkdir();old=folder/'execute.py';old.write_text('old')
    saved=protected_snapshot(tmp_path)
    (folder/'execute_motion_v5.py').write_text('new unrelated adapter')
    assert protected_snapshot(tmp_path,recorded_paths=saved)==saved
    old.write_text('old changed')
    assert protected_snapshot(tmp_path,recorded_paths=saved)!=saved


def test_motion_experience_preserves_order_and_program_identity(case,monkeypatch):
    from server.experiences import preview_experience,publish_experience
    from server.retrieval import document_detail
    jobs,store,p,run=case
    run=copy.deepcopy(run);run['id']='e'*32;store.put('run',run)
    def execute(pid,rid,specpath,code,out,cancel):
        result=evidence(json.loads(specpath.read_text(encoding='utf-8')))
        (out/'result.json').write_text(json.dumps(result),encoding='utf-8')
        return result
    monkeypatch.setattr(jobs,'execute',execute)
    jobs._run(p,run,{},threading.Event(),None)
    preview=preview_experience(jobs.root,store,run['id'])
    assert preview['result']['passed'] is True
    assert preview['motion_program']['joint_names']==['a','b']
    assert preview['motion_program']['program_sha256']==run['spec_snapshot']['motion_program']['program_sha256']
    assert preview['code_versions'][0]['ros_excerpt']==''
    published=publish_experience(jobs.root,store,run['id'],preview['preview_hash'])
    document=document_detail(jobs.root,published['document_id'])['document']
    assert document['task_types']==['joint_sequence']
    assert document['physical_verified'] is False and document['esp32_execution_verified'] is False


@pytest.mark.parametrize('outdated',['templates','evidence',None])
def test_live_runner_reuses_only_a_current_pass(monkeypatch,outdated):
    import sophicore_v5_live_acceptance as runner
    import server.integrity as integrity
    state={'project_id':'p','program_sha256':'program','run_id':'old','run_passed':True}
    project={'pipeline_version':5,'motion_program':{'program_sha256':'program'},'approval':{'reviewed':True}}
    old={'id':'old','status':'passed','attempt':1,'spec_snapshot':{},'result':{}}
    final={'id':'new','status':'passed','attempt':1,'spec_snapshot':{},'result':{'checks':[],'identity':{}},'integrity':{}}
    calls=[]
    def api(client,method,path,body=None):
        calls.append((method,path))
        if path=='/api/projects/p':return project
        if path=='/api/runs/old':return old
        if method=='POST' and path=='/api/projects/p/run':return {'id':'new','status':'queued'}
        pytest.fail('Unexpected API operation: '+path)
    def verify(root,run,check_templates):
        assert run is old and check_templates is True
        if outdated=='templates':raise IntegrityError('protected template changed')
    monkeypatch.setattr(runner,'api',api)
    monkeypatch.setattr(runner,'persist',lambda state:None)
    monkeypatch.setattr(runner,'wait_run',lambda *args:final)
    monkeypatch.setattr(integrity,'verify_run_integrity',verify)
    monkeypatch.setattr(motion_v5,'result_evidence_valid',lambda spec,result,output:outdated!='evidence' or result is final['result'])
    runner.run_phase(None,None,state)
    if outdated:
        assert state['run_id']=='new' and state['previous_run_ids']==['old']
        assert ('POST','/api/projects/p/run') in calls
        assert old['status']=='passed'
    else:
        assert state['run_id']=='old' and not any(method=='POST' for method,_ in calls)
    assert state['run_passed'] is True


def test_live_export_validates_the_actual_attempt(monkeypatch,tmp_path):
    import io
    from types import SimpleNamespace
    import zipfile
    import sophicore_v5_live_acceptance as runner
    stream=io.BytesIO()
    with zipfile.ZipFile(stream,'w') as archive:
        for name in ('spec.json','approval.json','motion-program.json','bundle-manifest.json',
                     'attempt-2/algorithm.py','attempt-2/device_logic.cpp'):
            archive.writestr(name,'{}')
        archive.writestr('run-record.json',json.dumps({'id':'r','attempt':2}))
    payload=stream.getvalue()
    client=SimpleNamespace(get=lambda path:SimpleNamespace(status_code=200,content=payload))
    (tmp_path/'runs'/'r').mkdir(parents=True)
    monkeypatch.setattr(runner,'ROOT',tmp_path)
    monkeypatch.setattr(runner,'persist',lambda state:None)
    def api(client,method,path,body):
        if path.endswith('/preview'):return {'preview_hash':'preview'}
        return {'id':'imported','approval':None,'plan':None,'status':'draft','motion_program':{'program_sha256':'program'}}
    monkeypatch.setattr(runner,'api',api)
    state={'run_id':'r','run_passed':True,'project_id':'original','program_sha256':'program'}
    runner.export_phase(client,None,state)
    assert state['imported_project_id']=='imported'
    assert (tmp_path/'runs'/'r'/'sophicore-v5-accepted.zip').read_bytes()==payload
