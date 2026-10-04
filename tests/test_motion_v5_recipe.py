"""Forward-kinematic checks for the offered model-space reference, not hardware."""
import copy
import math
from pathlib import Path

import pytest
from server.motion_v5 import motion_recipe
from server.structures import get_structure
from worker.motion_spec_v5 import build_motion_model, compile_motion_program
from worker.physics_v3 import source_poses

ROOT=Path(__file__).resolve().parents[1]


def positions(model,names,values):
    posed=copy.deepcopy(model)
    for name,value in zip(names,values):
        next(j for j in posed['joints'] if j['name']==name)['initial_position']=value
    _,matrices=source_poses(posed)
    return {name:[matrix[i][3] for i in range(3)] for name,matrix in matrices.items()}


@pytest.mark.parametrize('side,sign',[('right',-1),('left',1)])
def test_recipe_raises_wrist_waves_laterally_and_returns_to_body_side(side,sign):
    recipe=motion_recipe(ROOT,'sophicore-reference',side,3); p=recipe['motion_plan']
    assert p['reviewed'] is False and recipe['source']['ai_generated'] is False
    model=build_motion_model(get_structure(ROOT,'sophicore-reference'),p['joint_names'])
    program=compile_motion_program(p,model)
    initial=positions(model,p['joint_names'],program['initial_positions'])
    a,b,down=[positions(model,p['joint_names'],p['waypoints'][i]['positions']) for i in (0,1,-1)]
    shoulder,elbow,wrist=p['joint_names'][0],p['joint_names'][3],p['joint_names'][4]
    # Physical meaning from the source's Z-up tree: hand rises ~0.75 m and
    # traverses laterally ~0.19 m; wrist rotation alone would not satisfy this.
    assert a[wrist][2]-initial[wrist][2]>.6
    assert b[wrist][2]>=b[shoulder][2]-.05
    assert abs(a[wrist][0]-b[wrist][0])>.15
    # End is below elbow/shoulder, outside torso, and close to source hanging pose.
    assert down[wrist][2]<down[elbow][2]-.3<down[shoulder][2]
    assert sign*down[wrist][0]>.3
    assert math.dist(down[wrist],initial[wrist])<.15
    assert [row['cycle_index'] for row in p['waypoints']]==[0,1,1,2,2,3,3,0]
    assert p['waypoints'][1]['stage_id']=='wave_b'
    assert p['waypoints'][-1]['stage_id']=='finish'


def test_reference_is_rejected_for_non_sophicore_or_unknown_side():
    with pytest.raises(ValueError): motion_recipe(ROOT,'builtin-joint')
    with pytest.raises(ValueError): motion_recipe(ROOT,'sophicore-reference','both')
