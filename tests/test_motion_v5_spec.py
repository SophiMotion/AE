"""V5 motion contracts reject tampering and preserve the old scalar contract."""
import copy
import importlib.util
import math

import pytest


def module():
    assert importlib.util.find_spec('worker.motion_spec_v5'), 'V5 motion contract is not implemented'
    from worker import motion_spec_v5
    return motion_spec_v5


def source():
    links = [{'name': name, 'visuals': []} for name in ('base', 'upper', 'lower', 'held')]
    return {'id': 'fixture', 'content_sha256': 'c'*64, 'format': 'sophicore-kinematic', 'links': links, 'joints': [
        {'name': 'a', 'type': 'revolute', 'parent': 'base', 'child': 'upper', 'axis': [1, 0, 0], 'lower': -2, 'upper': 2, 'initial_position': .1},
        {'name': 'b', 'type': 'revolute', 'parent': 'upper', 'child': 'lower', 'axis': [0, 1, 0], 'lower': -1, 'upper': 1, 'initial_position': .2},
        {'name': 'c', 'type': 'revolute', 'parent': 'base', 'child': 'held', 'axis': [0, 1, 0], 'lower': -1, 'upper': 1, 'initial_position': .3},
    ]}


def plan():
    return {'schema_version': 1, 'recipe_id': 'custom', 'model_source_sha256': 'a' * 64, 'reviewed': True,
        'joint_names': ['a', 'b'], 'waypoints': [
            {'positions': [.4, .5], 'time_from_start_s': 2., 'stage_id': 'prepare', 'cycle_index': 0},
            {'positions': [.1, .2], 'time_from_start_s': 4., 'stage_id': 'finish', 'cycle_index': 0}],
        'tolerance_rad': .035, 'max_velocity_rad_s': .5, 'max_acceleration_rad_s2': 1., 'timeout_s': 8.}


def test_frozen_multi_model_keeps_source_initials_and_only_other_joints_held():
    m = module().build_motion_model(source(), ['b', 'a'])
    assert m['active_joint_names'] == ['b', 'a']
    assert m['held_positions'] == {'c': .3}
    assert m['schema_version'] == 5
    assert module().validate_motion_model(m) == m
    bad = copy.deepcopy(m); bad['joints'][0]['initial_position'] = .9
    with pytest.raises(ValueError): module().validate_motion_model(bad)


def test_declared_frozen_communication_cannot_drift_from_program():
    api=module();model=api.build_motion_model(source(),['a','b'])
    spec={'execution_model':model,'motion_program':api.compile_motion_program(plan(),model)}
    spec.update(api.motion_contract(spec))
    spec['communication']['identity']['program_sha256']='f'*64
    with pytest.raises(ValueError,match='通信'):
        api.motion_contract(spec)


def test_program_has_vector_source_initial_and_rechecks_digest():
    api = module(); m = api.build_motion_model(source(), ['a', 'b'])
    p = api.compile_motion_program(plan(), m)
    assert p['initial_positions'] == [.1, .2]
    assert len(p['waypoints']) == 2 and p['waypoints'][-1]['positions'] == [.1, .2]
    assert api.validate_motion_program(p, m) == p
    p['waypoints'][0]['positions'][0] = .2
    with pytest.raises(ValueError): api.validate_motion_program(p, m)


@pytest.mark.parametrize('rows',[
    [(1,[.4,.5])],
    [(3,[.4,.5]),(3,[.1,.2])],
    [(1,[.4,.5]),(1,[.2,.3])],
    [(1,[.4,.5]),(0,[.1,.2]),(1,[.4,.5]),(1,[.1,.2])],
    [(1,[.4,.5]),(1,[.1,.2]),(3,[.4,.5]),(3,[.1,.2])],
])
def test_cycle_labels_cannot_fake_completed_round_trips(rows):
    p=plan();p['timeout_s']=30
    p['waypoints']=[{'positions':v,'time_from_start_s':(i+1)*3.,'stage_id':'wave','cycle_index':n} for i,(n,v) in enumerate(rows)]
    with pytest.raises(ValueError,match='往返'):
        module().compile_motion_program(p,module().build_motion_model(source(),p['joint_names']))


def test_cycle_motion_must_be_distinguishable_from_position_tolerance():
    p=plan();p['waypoints'][0].update(positions=[.101,.201],cycle_index=1)
    p['waypoints'][1]['cycle_index']=1
    with pytest.raises(ValueError,match='误差'):
        module().compile_motion_program(p,module().build_motion_model(source(),p['joint_names']))


@pytest.mark.parametrize('change', [
    lambda p: p['waypoints'][0].update(positions=[.2]),
    lambda p: p['waypoints'][0].update(positions=[float('nan'), .2]),
    lambda p: p['waypoints'][0].update(positions=[3., .2]),
    lambda p: p['waypoints'][1].update(time_from_start_s=1.),
    lambda p: p['waypoints'][0].update(time_from_start_s=.01),
    lambda p: p.update(timeout_s=3.),
    lambda p: p.update(joint_names=['b', 'a']),
    lambda p: p['waypoints'][0].update(cycle_index=-1),
])
def test_program_rejects_unknown_or_unreachable_numbers(change):
    api = module(); m = api.build_motion_model(source(), ['a', 'b']); p = plan(); change(p)
    with pytest.raises(ValueError): api.compile_motion_program(p, m)


def test_legacy_contract_remains_scalar_and_v5_is_distinct():
    from worker.contract import project_contract
    before = project_contract()
    api = module(); m = api.build_motion_model(source(), ['a', 'b']); p = api.compile_motion_program(plan(), m)
    c = api.motion_contract({'execution_model': m, 'motion_program': p})
    assert before['communication']['schema_version'] == 1
    assert c['communication']['schema_version'] == 5
    assert c['communication']['identity']['joint_names'] == ['a', 'b']
    assert c['communication']['identity']['program_sha256'] == p['program_sha256']
    assert project_contract() == before
