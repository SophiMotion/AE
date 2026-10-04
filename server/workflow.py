"""Validated, editable local execution DAG. Client order is never authoritative."""
from __future__ import annotations

import copy
import hashlib
import json
import math

KINDS = ('requirements', 'rag', 'plan', 'review', 'generate', 'ros_build', 'esp_build', 'communication', 'simulation', 'report')
LABELS = dict(zip(KINDS, ('填写需求', '查找资料', '拆分工作', '人工核对', '生成程序', '编译 ROS', '编译 ESP32', '检查通信', '运行仿真', '生成报告')))


def default_workflow():
    nodes = [{'id': kind, 'type': kind, 'position': {'x': (i % 5)*220, 'y': (i // 5)*160}} for i, kind in enumerate(KINDS)]
    pairs = [('requirements', 'rag'), ('rag', 'plan'), ('plan', 'review'), ('review', 'generate'),
             ('generate', 'ros_build'), ('generate', 'esp_build'), ('ros_build', 'communication'),
             ('esp_build', 'communication'), ('communication', 'simulation'), ('simulation', 'report')]
    return validate_workflow({'schema_version': 1, 'nodes': nodes, 'edges': [{'source': a, 'target': b} for a, b in pairs]})


def validate_workflow(value):
    if value is None:
        return default_workflow()
    if not isinstance(value, dict) or value.get('schema_version', 1) != 1:
        raise ValueError('流程格式不正确，请恢复推荐流程。')
    if set(value) - {'schema_version', 'nodes', 'edges', 'execution_order', 'hash'}:
        raise ValueError('流程含未知配置，不能执行。')
    nodes, edges = value.get('nodes'), value.get('edges')
    if not isinstance(nodes, list) or len(nodes) != len(KINDS) or not isinstance(edges, list) or len(edges) > 45:
        raise ValueError('流程必须保留需求、资料、拆分、核对、生成、两端编译、通信、仿真和报告这十个步骤。')
    normalized = []
    for node in nodes:
        if not isinstance(node, dict) or node.get('id') not in KINDS or node.get('type') != node['id']:
            raise ValueError('流程存在未知步骤。')
        pos = node.get('position', {})
        if not isinstance(pos, dict) or any(isinstance(pos.get(k), bool) or not isinstance(pos.get(k), (int, float)) or not math.isfinite(pos[k]) or abs(pos[k]) > 10000 for k in ('x', 'y')):
            raise ValueError('流程节点的位置不正确。')
        normalized.append({'id': node['id'], 'type': node['id'], 'position': {'x': pos['x'], 'y': pos['y']}})
    if {n['id'] for n in normalized} != set(KINDS):
        raise ValueError('流程步骤不能重复或缺失。')
    adjacency = {kind: set() for kind in KINDS}
    incoming = {kind: 0 for kind in KINDS}
    for edge in edges:
        if not isinstance(edge, dict):
            raise ValueError('流程连线格式不正确。')
        source, target = edge.get('source'), edge.get('target')
        if not isinstance(source, str) or not isinstance(target, str) or source not in adjacency or target not in adjacency or source == target:
            raise ValueError('连线必须连接两个不同的已有步骤。')
        if target in adjacency[source]:
            raise ValueError('同一条连线不能重复。')
        adjacency[source].add(target)
        incoming[target] += 1
    pending, order = dict(incoming), []
    while len(order) < len(KINDS):
        ready = next((k for k in KINDS if k not in order and pending[k] == 0), None)
        if ready is None:
            raise ValueError('连线形成了绕圈，无法确定执行顺序；修改后再保存。')
        order.append(ready)
        for target in adjacency[ready]:
            pending[target] -= 1
    def reaches(source, target):
        found, todo = set(), [source]
        while todo:
            at = todo.pop()
            if at == target:
                return True
            if at not in found:
                found.add(at)
                todo.extend(adjacency[at])
        return False
    required = [('requirements', 'rag'), ('rag', 'plan'), ('plan', 'review'), ('review', 'generate')]
    required += [('generate', build) for build in ('ros_build', 'esp_build')]
    required += [(build, check) for build in ('ros_build', 'esp_build') for check in ('communication', 'simulation')]
    required += [(check, 'report') for check in ('communication', 'simulation')]
    for before, after in required:
        if not reaches(before, after):
            raise ValueError(f'必须先完成“{LABELS[before]}”，才能进入“{LABELS[after]}”；请补齐连线。')
    result = {'schema_version': 1, 'nodes': sorted(normalized, key=lambda n: KINDS.index(n['id'])),
              'edges': [{'id': f'{a}-{b}', 'source': a, 'target': b} for a in KINDS for b in sorted(adjacency[a], key=KINDS.index)],
              'execution_order': order}
    result['hash'] = hashlib.sha256(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return copy.deepcopy(result)
