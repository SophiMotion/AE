"""Foreground live acceptance: real API/Jobs/ROS, no listening web server.

All mutations are new, named QA objects. Original project/run records are hashed
before preparation and checked after each phase. No physical hardware or Feishu.
Run phases separately; --prepare does not launch a robot worker.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
from pathlib import Path
import sys
import time
import zipfile

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
REPORT=ROOT/'.tools'/'sophicore-v5-live-acceptance.json'
QA_NAME='Sophicore V5 真实 API 验收 · 右臂招手三次'
REQUEST='让机器人抬起右臂，来回招手三次，最后把手臂放到身体旁边。仅在本机固定底座、零重力模型中验证，不连接实物。'


def digest(value):
    return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()


def persist(state):
    from server.store import now
    state['updated_at']=now()
    # Runtime acceptance history is private and excluded from Git / Pages.
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(state,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf-8')


def api(client,method,path,body=None):
    response=client.request(method,path,**({'json':body} if body is not None else {}))
    if response.status_code!=200:
        raise RuntimeError(f'{method} {path} returned {response.status_code}: {response.text[:3500]}')
    return response.json()


def originals(store):
    return {kind:{row['id']:digest(row) for row in store.list(kind)} for kind in ('project','run')}


def verify_originals(store,state):
    changed=[]
    for kind,rows in state['original_records'].items():
        for ident,expected in rows.items():
            try:actual=digest(store.get(kind,ident))
            except KeyError:actual=None
            if actual!=expected:changed.append(kind+':'+ident)
    state['original_records_unchanged']=not changed
    state['original_record_differences']=changed
    if changed:raise RuntimeError('An original record changed during QA; retained without repair: '+', '.join(changed))


def no_foreign_active(store,state):
    from server.store import ACTIVE
    owned={state.get(k) for k in ('project_id','run_id','imported_project_id','retest_run_id')}
    foreign=[kind+':'+r['id'] for kind in ('project','run') for r in store.list(kind)
        if r.get('status') in ACTIVE and r['id'] not in owned]
    if foreign:raise RuntimeError('Other work is active; this QA will not recover/cancel it: '+', '.join(foreign))


def wait_project(client,pid,timeout=120):
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        project=api(client,'GET','/api/projects/'+pid)
        if project['status']!='planning':return project
        time.sleep(.25)
    raise TimeoutError('QA planning did not finish')


def approve_qa(client,pid,state,label):
    api(client,'POST',f'/api/projects/{pid}/plan')
    project=wait_project(client,pid)
    if project['status']!='awaiting_approval' or project['plan']['blocking_issues']:
        raise RuntimeError('QA did not obtain a reviewable plan: '+str(project.get('error') or project.get('plan'))[:3000])
    if project['plan']['provenance'].get('kind')!='deterministic_motion_program':
        raise RuntimeError('Unexpected generator; do not invoke an AI service in this QA')
    api(client,'POST',f'/api/projects/{pid}/approve',{'spec_revision':project['spec_revision'],'plan_id':project['plan']['plan_id']})
    state[label+'_approval']={'actor':'explicitly authorized QA integration runner; not the original user project',
        'spec_revision':project['spec_revision'],'plan_id':project['plan']['plan_id'],'spec_hash':project['plan']['spec_hash']}
    persist(state)


def wait_run(client,rid,state,key,timeout=1000):
    from server.store import ACTIVE
    deadline=time.monotonic()+timeout;last=None
    while time.monotonic()<deadline:
        run=api(client,'GET','/api/runs/'+rid)
        if run['status']!=last:
            last=run['status'];state[key+'_status']=last;persist(state)
            print(json.dumps({'run_id':rid,'status':last},ensure_ascii=False),flush=True)
        if run['status'] not in ACTIVE:return run
        time.sleep(1)
    # Only this runner's own QA worker may be cancelled.
    api(client,'POST','/api/runs/'+rid+'/cancel')
    raise TimeoutError('QA worker exceeded foreground integration deadline; own run cancellation requested')


def prepare(client,store,state):
    if state.get('project_id'):
        existing=api(client,'GET','/api/projects/'+state['project_id'])
        if existing['name']!=QA_NAME:raise RuntimeError('Stored QA id no longer names the expected QA project')
        return
    recipe=api(client,'GET','/api/motion-v5/recipe?structure_id=sophicore-reference&side=right&cycles=3')
    plan=recipe['motion_plan'];plan['reviewed']=True
    body={'name':QA_NAME,'request':REQUEST,'prd':{'use_case':'自动化集成验收，不替换用户原工程',
        'intake':{'schema_version':2,'intent':'oscillate','mode':'simulation','motion_plan':plan,
            'answers':{'board':'esp32s3','structure_id':'sophicore-reference','joint_name':'arm_r_shoulder_lift'}}}}
    project=api(client,'POST','/api/projects',body)
    state.update(project_id=project['id'],program_sha256=project['motion_program']['program_sha256'],
        motion_program=project['motion_program'],recipe_source=recipe['source'],recipe_notes=recipe['notes'],status='prepared')
    persist(state)
    if not project['intake_readiness']['can_plan']:raise RuntimeError('Fresh QA recipe is not ready for plan')
    approve_qa(client,project['id'],state,'initial')


def run_phase(client,store,state,imported=False):
    from server.motion_v5 import result_evidence_valid
    from server.integrity import IntegrityError, verify_run_integrity
    pid=state.get('imported_project_id' if imported else 'project_id')
    if not pid:raise RuntimeError('Run --export before --retest' if imported else 'Run --prepare first')
    project=api(client,'GET','/api/projects/'+pid)
    if project.get('pipeline_version')!=5 or project.get('motion_program',{}).get('program_sha256')!=state['program_sha256']:
        raise RuntimeError('QA frozen motion identity changed; refusing unrelated execution')
    key='retest_run' if imported else 'run';old_id=state.get(key+'_id')
    if old_id:
        old=api(client,'GET','/api/runs/'+old_id)
        if old['status']=='passed':
            previous_output=ROOT/'runs'/old_id/('attempt-'+str(old['attempt']))
            try:
                verify_run_integrity(ROOT,old,check_templates=True)
                if not result_evidence_valid(old['spec_snapshot'],old.get('result') or {},previous_output):
                    raise ValueError('Previous pass does not meet the current independent evidence checks')
            except (IntegrityError,ValueError,KeyError,TypeError) as error:
                previous_ids=state.setdefault('previous_run_ids',[])
                if old_id not in previous_ids:previous_ids.append(old_id)
                state.setdefault('previous_run_notes',[]).append({'run_id':old_id,'phase':key,'reason':str(error),
                    'action':'retained unchanged; a new run will verify the current templates'})
                state[key+'_passed']=False
                # A passed history is immutable: never repair or overwrite it.
                old_id=None
                persist(state)
            else:
                state[key+'_passed']=True
                state[key+'_status']='passed'
                persist(state)
                return
    if not project.get('approval'):approve_qa(client,pid,state,'retest' if imported else 'initial')
    run=api(client,'POST','/api/runs/'+old_id+'/repair') if old_id and old['status'] in ('failed','cancelled','interrupted') else api(client,'POST',f'/api/projects/{pid}/run')
    state[key+'_id']=run['id'];state[key+'_status']=run['status'];persist(state)
    finished=wait_run(client,run['id'],state,key)
    output=ROOT/'runs'/run['id']/('attempt-'+str(finished['attempt']))
    accepted=finished['status']=='passed' and result_evidence_valid(finished['spec_snapshot'],finished.get('result') or {},output)
    state[key+'_passed']=bool(accepted)
    state[key+'_evidence']={'checks':len((finished.get('result') or {}).get('checks',[])),
        'identity':(finished.get('result') or {}).get('identity'),'integrity':(finished.get('integrity') or {}).get('fingerprint'),
        'directory':str(output),'error':finished.get('error') or (finished.get('result') or {}).get('error')}
    state['status']='retest_passed' if accepted and imported else 'run_passed' if accepted else 'failed'
    persist(state)
    if not accepted:raise RuntimeError('Actual QA run did not pass; inspect '+str(output))


def export_phase(client,store,state):
    rid=state.get('run_id')
    if not rid or not state.get('run_passed'):raise RuntimeError('The first real run must pass before export')
    response=client.get('/api/runs/'+rid+'/export')
    if response.status_code!=200:raise RuntimeError('Artifact export rejected: '+response.text[:3000])
    payload=response.content
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        bad=archive.testzip()
        if bad:raise RuntimeError('ZIP CRC failed: '+bad)
        filenames=archive.namelist()
        record=json.loads(archive.read('run-record.json').decode('utf-8'))
        attempt=record.get('attempt')
        if record.get('id')!=rid or isinstance(attempt,bool) or not isinstance(attempt,int) or attempt<1:
            raise RuntimeError('ZIP run identity or attempt number is invalid')
        required={'spec.json','approval.json','motion-program.json','bundle-manifest.json','run-record.json',
            f'attempt-{attempt}/algorithm.py',f'attempt-{attempt}/device_logic.cpp'}
        if not required.issubset(filenames):raise RuntimeError('ZIP omitted required generated files')
    path=ROOT/'runs'/rid/'sophicore-v5-accepted.zip';path.write_bytes(payload)
    data={'filename':path.name,'content_base64':base64.b64encode(payload).decode()}
    preview=api(client,'POST','/api/projects/import/preview',data)
    imported=api(client,'POST','/api/projects/import',{**data,'confirm':True,'preview_hash':preview['preview_hash']})
    if imported['id']==state['project_id'] or imported['approval'] is not None or imported['plan'] is not None or imported['status']!='draft':
        raise RuntimeError('Import improperly restored approval/execution state')
    if imported['motion_program']['program_sha256']!=state['program_sha256']:
        raise RuntimeError('Imported route differs from exported approved route')
    state.update(imported_project_id=imported['id'],status='exported_and_imported_as_draft',
        export={'path':str(path),'bytes':len(payload),'sha256':hashlib.sha256(payload).hexdigest(),
            'crc_passed':True,'files':len(filenames),'preview_hash':preview['preview_hash'],
            'notice':'ZIP import recovered data only; package code was not executed by import'})
    persist(state)


def deployment_phase(client,store,state):
    from server.integrity import verify_run_integrity
    from server.motion_v5 import result_evidence_valid
    rid=state.get('run_id')
    if not rid or not state.get('run_passed') or not state.get('export'):
        raise RuntimeError('Complete the real run and pinned export before deployment retest')
    run=api(client,'GET','/api/runs/'+rid)
    sealed=verify_run_integrity(ROOT,run,check_templates=True)
    if run.get('status')=='deployed' and state.get('deployment_passed'):return
    parent=ROOT/'runs'/rid
    before=set(parent.glob('deployment-*'))
    api(client,'POST','/api/runs/'+rid+'/deploy',{'confirm':True,'fingerprint':sealed['fingerprint']})
    finished=wait_run(client,rid,state,'deployment')
    outputs=set(parent.glob('deployment-*'))-before
    if len(outputs)!=1:raise RuntimeError('Cannot attribute deployment evidence to exactly one new output directory')
    output=outputs.pop();result=(finished.get('deployment') or {}).get('result') or {}
    accepted=finished['status']=='deployed' and result_evidence_valid(finished['spec_snapshot'],result,output)
    verify_run_integrity(ROOT,finished,check_templates=True)
    state.update(deployment_passed=bool(accepted),status='deployment_passed' if accepted else 'deployment_failed',
        deployment_evidence={'directory':str(output),'checks':len(result.get('checks',[])),
            'identity':result.get('identity'),'original_seal_unchanged':finished['integrity']==sealed,
            'error':result.get('error') or (finished.get('deployment') or {}).get('error')})
    persist(state)
    if not accepted:raise RuntimeError('Actual platform deployment retest did not pass: '+str(output))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    group=parser.add_mutually_exclusive_group(required=True)
    for phase in ('prepare','run','export','retest','deploy'):group.add_argument('--'+phase,action='store_true')
    args=parser.parse_args()
    from fastapi.testclient import TestClient
    from server.app import create_app
    app=create_app(ROOT);store=app.state.store
    state=json.loads(REPORT.read_text(encoding='utf-8')) if REPORT.exists() else {
        'schema_version':1,'scope':'new QA projects only; real local ROS/ESP builds; no hardware, no Feishu, no network listener',
        'original_records':originals(store),'status':'not_started'}
    no_foreign_active(store,state);verify_originals(store,state)
    # Deliberately do not enter TestClient's lifespan: store.recover() belongs
    # only to a real service startup and must never touch unrelated live records.
    client=TestClient(app)
    try:
        phase=next(name for name in ('prepare','run','export','retest','deploy') if getattr(args,name))
        state['phase']=phase;state.pop('last_error',None);persist(state)
        if phase=='prepare':prepare(client,store,state)
        elif phase=='export':export_phase(client,store,state)
        elif phase=='deploy':deployment_phase(client,store,state)
        else:run_phase(client,store,state,imported=phase=='retest')
        verify_originals(store,state);persist(state)
        print(json.dumps({k:state.get(k) for k in ('phase','status','project_id','run_id','imported_project_id','retest_run_id','original_records_unchanged')},ensure_ascii=False),flush=True)
        return 0
    except Exception as error:
        state['last_error']=str(error);persist(state)
        print(json.dumps({'phase':state.get('phase'),'error':str(error),'report':str(REPORT)},ensure_ascii=False),flush=True)
        return 1
    finally:
        app.state.jobs.close();client.close()


if __name__=='__main__':raise SystemExit(main())
