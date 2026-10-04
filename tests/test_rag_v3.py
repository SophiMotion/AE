"""Check the actual V3 corpus and scope filters; no model answer is mocked."""
import hashlib
import json
from pathlib import Path

import pytest

from server import retrieval
from worker.robot_model import SOURCE_SHA256

ROOT=Path(__file__).resolve().parents[1]


@pytest.fixture(scope='module')
def corpus(tmp_path_factory):
    root=tmp_path_factory.mktemp('rag-v3')
    (root/'knowledge').mkdir()
    for name in ('sources.json','evaluation.json'):
        (root/'knowledge'/name).write_bytes((ROOT/'knowledge'/name).read_bytes())
    return root


def test_whole_curated_corpus_fixed_questions_pass(corpus):
    report=retrieval.evaluate(corpus)
    assert report['total']>=35
    assert report['failed']==0, [r for r in report['results'] if not r['passed']]
    assert report['generation_tested'] is False


def test_sophicore_specific_values_require_both_model_and_source(corpus):
    kwargs={'task_type':'joint_position','board':'esp32s3','ros_distro':'humble','root':corpus,'limit':20}
    query='Sophicore 左肘关节 arm_l_elbow_bend limbPivots 坐标'
    matched=retrieval.retrieve(query,robot_model='sophicore_506',source_model_sha256=SOURCE_SHA256,**kwargs)
    assert any(h['document_id']=='sophicore-kinematics-v3' for h in matched)
    for options in ({},{'robot_model':'imported_other_robot','source_model_sha256':SOURCE_SHA256},
                    {'robot_model':'sophicore_506','source_model_sha256':'wrong_step_hash'},
                    {'robot_model':'sophicore_506'}):
        hits=retrieval.retrieve(query,**options,**kwargs)
        assert not any(h.get('robot_model')=='sophicore_506' for h in hits), options


@pytest.mark.parametrize('board,expected,excluded',[
    ('esp32','ae-esp32-build-v3','ae-esp32s3-build-v3'),
    ('ESP32-S3','ae-esp32s3-build-v3','ae-esp32-build-v3')])
def test_actual_firmware_notes_do_not_mix_boards(corpus,board,expected,excluded):
    hits=retrieval.retrieve('FQBN Arduino model_binding.hpp 板型编译','joint_position',20,board=board,root=corpus)
    ids={h['document_id'] for h in hits}
    assert expected in ids and excluded not in ids


def test_humble_project_contract_is_not_a_jazzy_api_reference(corpus):
    hits=retrieval.retrieve('joint_name protocol_sha256 measurement 通信','joint_position',20,
                            board='esp32s3',ros_distro='jazzy',root=corpus)
    assert not any(h['document_id'] in {'ae-serial-binding-v3','project-contract-original'} for h in hits)


def test_pinned_sources_and_source_positions_are_preserved(corpus):
    sources={x['id']:x for x in json.loads((ROOT/'knowledge/sources.json').read_text(encoding='utf-8'))['items']}
    original=sources['sophicore-limbs-original']
    raw=(ROOT/original['source_path']).read_bytes()
    assert original['source_file_sha256']==hashlib.sha256(raw).hexdigest()
    assert original['content']==raw.decode('utf-8')
    hits=retrieval.retrieve('limbPivots armOffset handShift','joint_position',20,board='esp32s3',root=corpus,
        robot_model='sophicore_506',source_model_sha256=SOURCE_SHA256)
    match=next(x for x in hits if x['document_id']=='sophicore-limbs-original')
    assert match['content'] in original['content']
    assert match['source_hash']==hashlib.sha256(original['content'].encode()).hexdigest()
    assert match['line_start']>=1 and match['line_end']>=match['line_start']
    assert match['source_commit'] in match['url']
    assert match['content_kind']=='original'


def test_local_simulation_evidence_does_not_claim_hardware_acceptance(corpus):
    hits=retrieval.retrieve('1 kg 质量惯量数值占位不是实际负载','joint_position',5,board='esp32s3',root=corpus)
    text=next(h['content'] for h in hits if h['document_id']=='ae-simulation-scope-v3')
    assert '1 kg' in text and 'hardware_verified=false' in text
    assert '尚未连接' in text and '不能证明真实扭矩' in text


def test_plan_approval_facts_are_retrievable_without_robot_specific_data(corpus):
    hits=retrieval.retrieve('人工核对 spec_revision plan_id blocking_issues 后编译','joint_position',5,board='esp32',root=corpus)
    assert any(h['document_id']=='ae-approval-workflow-v3' and h.get('robot_model')=='any' for h in hits)
