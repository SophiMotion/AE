import xml.etree.ElementTree as ET
from test_motion_v5_spec import source, plan
from worker.motion_spec_v5 import build_motion_model, compile_motion_program
from worker.physics_v5 import generate_sdf_v5, generate_urdf_v5


def test_all_active_axes_keep_source_offsets_and_held_axes_stay_fixed():
    model = build_motion_model(source(), ['a', 'b'])
    sdf = ET.fromstring(generate_sdf_v5(model, '/fixture', .5))
    joints = {j.get('name'):j for j in sdf.findall('world/model/joint')}
    assert joints['a'].get('type') == joints['b'].get('type') == 'revolute'
    assert joints['c'].get('type') == 'fixed'
    assert float(joints['b'].findtext('axis/limit/lower')) == -1.2
    assert float(joints['b'].findtext('axis/limit/upper')) == .8
    plugins = sdf.findall('world/model/plugin')
    assert [p.findtext('topic') for p in plugins] == ['/fixture/velocity_0','/fixture/velocity_1','/fixture/raw_joint_state']
    assert [j.text for j in plugins[-1].findall('joint_name')] == ['a','b']


def test_controller_hardware_is_bound_to_same_order_and_positions():
    model = build_motion_model(source(), ['a', 'b']); program = compile_motion_program(plan(), model)
    urdf = ET.fromstring(generate_urdf_v5(model,program,'/fixture'))
    control = urdf.find('ros2_control')
    assert control.findtext('hardware/plugin') == 'ae_motion_hardware/TopicSystem'
    assert [j.get('name') for j in control.findall('joint')] == ['a','b']
    assert [float(j.findtext('state_interface/param')) for j in control.findall('joint')] == [.1,.2]


def test_quintic_uses_every_axis_and_exact_waypoints():
    from worker.verification_motion_v5 import trajectory_at
    model=build_motion_model(source(),['a','b']);program=compile_motion_program(plan(),model)
    assert trajectory_at(program,0)[0]==[.1,.2]
    assert trajectory_at(program,2)[0]==[.4,.5]
    assert all(abs(a-b)<1e-12 for a,b in zip(trajectory_at(program,4)[0],[.1,.2]))
    assert trajectory_at(program,100)[0]==[.1,.2]


def test_action_success_without_measurements_cannot_pass():
    from worker.verification_motion_v5 import assess_case
    model=build_motion_model(source(),['a','b']);program=compile_motion_program(plan(),model)
    data={'states':[],'measurements':[],'audit':[],'errors':[],'namespace':'/test','gazebo_loaded':True,
        'task_events':[{'event':'submitted','start_s':1,'identity':{}},{'event':'completed','status':4,'error_code':0,'identity':{}}]}
    checks,metrics,series=assess_case(data,program,{},'no_data')
    assert not all(c['passed'] for c in checks)
    assert metrics['waypoints_reached']==0 and series==[]


def test_protocol_measurements_must_match_original_gazebo_audit():
    from worker.verification_motion_v5 import assess_case
    model=build_motion_model(source(),['a','b']);program=compile_motion_program(plan(),model)
    data={'states':[],'measurements':[], 'audit':[], 'errors':[], 'namespace':'/test',
        'gazebo_loaded':True,'task_events':[]}
    for i in range(30):
        position=[.1+i*.001,.2]
        data['measurements'].append({'seq':i,'time':i*.02,'positions':position})
        data['audit'].append({'kind':'raw','measurement_seq':i,'measurement_paused':False,
            'time':i*.02,'positions':position,'normalized_positions':position})
    def checked():
        checks,_,_=assess_case(data,program,{},'audit')
        return next(c['passed'] for c in checks if c['name']=='audit_gazebo_measurement_path')
    assert checked()
    # A static raw audit cannot corroborate moving protocol feedback.
    data['audit'][12]['positions']=[.1,.2]
    data['audit'][12]['normalized_positions']=[.1,.2]
    assert not checked()
    data['audit'][12]['normalized_positions']=data['measurements'][12]['positions']
    data['audit'][12]['time']+=.01
    assert not checked()


def test_fault_injection_waits_for_actual_motion_after_initial_hold():
    from worker.verification_motion_v5 import observed_motion
    data={'audit':[]}
    for i in range(30):
        data['audit'].append({'kind':'raw','_wall':i*.02,'time':i*.02,'positions':[.1,.2]})
    assert not observed_motion(data,.6)['moving']
    for i in range(10):
        data['audit'].append({'kind':'raw','_wall':.6+i*.02,'time':.6+i*.02,'positions':[.1+i*.003,.2]})
    assert observed_motion(data,.78)['moving']
    # Later stationary data must not inherit an old movement observation.
    for i in range(30):
        data['audit'].append({'kind':'raw','_wall':.8+i*.02,'time':.8+i*.02,'positions':[.127,.2]})
    assert not observed_motion(data,1.4)['moving']


def test_measurement_fault_only_accepts_the_expected_guard_rejection():
    from worker.verification_motion_v5 import assess_case
    model=build_motion_model(source(),['a','b']);program=compile_motion_program(plan(),model)
    data={'states':[],'measurements':[], 'audit':[], 'errors':[], 'namespace':'/test',
        'gazebo_loaded':True,'task_events':[], 'fault_wall':10.}
    def no_unexpected(fault):
        return next(c['passed'] for c in assess_case(data,program,{},'guard',fault)[0]
            if c['name']=='guard_no_runtime_errors')
    data['errors']=[{'event':'protocol_error','reason':'no_fresh_measurement','_wall':10.7}]
    assert no_unexpected('measurement_loss')
    assert not no_unexpected(None)
    data['errors'][0]['_wall']=9.
    assert not no_unexpected('measurement_loss')
    data['errors'][0].update(_wall=10.7,reason='wrong_identity')
    assert not no_unexpected('measurement_loss')


if __name__ == '__main__':
    import json
    from pathlib import Path
    from server.motion_v5 import motion_recipe
    from server.structures import get_structure
    from server.workflow import validate_workflow
    from worker.templates_motion_v5 import generate_motion_v5
    root=Path(__file__).resolve().parents[1]
    recipe=motion_recipe(root,'sophicore-reference','right',3)
    motion=recipe.get('motion_plan',recipe.get('plan'))
    model=build_motion_model(get_structure(root,'sophicore-reference'),motion['joint_names'])
    program=compile_motion_program(motion,model)
    spec={'pipeline_version':5,'task_type':'joint_sequence','execution_model':model,'motion_program':program,
        'hardware':{'board':'esp32s3','physical_io':False},'workflow':validate_workflow(None)}
    output=root/'runs'/'v5-runtime-preflight';output.mkdir(exist_ok=True)
    generate_motion_v5(output,spec)
    (output/'spec.json').write_text(json.dumps(spec,indent=2,ensure_ascii=False),encoding='utf-8')
    print(json.dumps({'output':str(output),'joints':program['joint_names'],'duration':program['timeout_s']}))
