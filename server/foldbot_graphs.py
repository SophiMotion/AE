"""AE editor diagrams describe source wiring and project gates, never device commands."""
from __future__ import annotations

import json
import re
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

STAGES = ('requirements', 'hardware', 'wiring', 'preview', 'program', 'deploy', 'control')
COMPONENTS = ('controller', 'fold-driver-1', 'fold-driver-2', 'arm-bus', 'chassis-left', 'chassis-right')


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def identifier(value):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,79}', value):
        raise ValueError('invalid_graph_identifier')
    return value


class StrictGraphModel(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)


class HardwareGraphNode(StrictGraphModel):
    id: str = Field(min_length=1, max_length=80)
    component: Literal['controller', 'fold-driver-1', 'fold-driver-2', 'arm-bus', 'chassis-left', 'chassis-right', 'custom']
    label: str = Field(max_length=120)

    _id = field_validator('id')(identifier)

    @field_validator('label')
    @classmethod
    def no_nul(cls, value):
        if '\x00' in value:
            raise ValueError('invalid_graph_label')
        return value


class GraphEdge(StrictGraphModel):
    id: str = Field(min_length=1, max_length=80)
    source: str = Field(min_length=1, max_length=80)
    sourcePort: str = Field(min_length=1, max_length=64)
    target: str = Field(min_length=1, max_length=80)
    targetPort: str = Field(min_length=1, max_length=64)

    _ids = field_validator('id', 'source', 'target')(identifier)

    @field_validator('sourcePort', 'targetPort')
    @classmethod
    def port_identifier(cls, value):
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.+-]*', value):
            raise ValueError('invalid_graph_port')
        return value


class StageNode(StrictGraphModel):
    id: str = Field(min_length=1, max_length=80)
    kind: Literal['stage']
    stage: Literal['requirements', 'hardware', 'wiring', 'preview', 'program', 'deploy', 'control']
    _id = field_validator('id')(identifier)


class ActionNode(StrictGraphModel):
    id: str = Field(min_length=1, max_length=80)
    kind: Literal['action']
    ref: Literal['workflow.action_group']
    _id = field_validator('id')(identifier)


class ConditionNode(StrictGraphModel):
    id: str = Field(min_length=1, max_length=80)
    kind: Literal['condition']
    check: Literal['requirements_ready', 'wiring_reviewed']
    _id = field_validator('id')(identifier)


BehaviorNode = Annotated[StageNode | ActionNode | ConditionNode, Field(discriminator='kind')]


class WiringGraph(StrictGraphModel):
    nodes: list[HardwareGraphNode] = Field(max_length=64)
    edges: list[GraphEdge] = Field(max_length=160)

    @model_validator(mode='after')
    def unique_ids(self):
        if len({n.id for n in self.nodes}) != len(self.nodes) or len({e.id for e in self.edges}) != len(self.edges):
            raise ValueError('duplicate_graph_id')
        return self


class BehaviorGraph(StrictGraphModel):
    nodes: list[BehaviorNode] = Field(max_length=64)
    edges: list[GraphEdge] = Field(max_length=160)

    @model_validator(mode='after')
    def unique_ids(self):
        if len({n.id for n in self.nodes}) != len(self.nodes) or len({e.id for e in self.edges}) != len(self.edges):
            raise ValueError('duplicate_graph_id')
        return self


class ProjectGraphs(StrictGraphModel):
    schema_version: int = Field(ge=1, le=1)
    wiring: WiringGraph
    behavior: BehaviorGraph


SOURCE_CONNECTIONS = [
    ('controller', 'gpio3', 'fold-driver-1', 'dir+'),
    ('controller', 'gpio8', 'fold-driver-1', 'pul+'),
    ('controller', 'gpio10', 'fold-driver-1', 'ena+'),
    ('controller', 'gpio4', 'fold-driver-2', 'dir+'),
    ('controller', 'gpio5', 'fold-driver-2', 'pul+'),
    ('controller', 'gpio9', 'fold-driver-2', 'ena+'),
    *[('controller', 'gnd', axis, port) for axis in ('fold-driver-1', 'fold-driver-2') for port in ('dir-', 'pul-', 'ena-')],
    ('controller', 'gpio6', 'arm-bus', 'rx'),
    ('controller', 'gpio7', 'arm-bus', 'tx'),
    ('controller', 'gnd', 'arm-bus', 'gnd'),
    ('controller', 'm1', 'chassis-left', 'motor'),
    ('controller', 'm2', 'chassis-right', 'motor'),
]
PORTS = {
    'controller': {
        **{f'gpio{pin}': ('digital', 'out') for pin in (3, 8, 10, 4, 5, 9)},
        'gpio6': ('uart', 'out'), 'gpio7': ('uart', 'in'), 'gnd': ('ground', 'bidirectional'),
        'm1': ('motor', 'out'), 'm2': ('motor', 'out'),
    },
    **{axis: {**{f'{name}+': ('digital', 'in') for name in ('dir', 'pul', 'ena')},
              **{f'{name}-': ('ground', 'bidirectional') for name in ('dir', 'pul', 'ena')}}
       for axis in ('fold-driver-1', 'fold-driver-2')},
    'arm-bus': {'rx': ('uart', 'in'), 'tx': ('uart', 'out'), 'gnd': ('ground', 'bidirectional')},
    'chassis-left': {'motor': ('motor', 'in')}, 'chassis-right': {'motor': ('motor', 'in')}, 'custom': {},
}


def connection_key(a, ap, b, bp):
    return canonical(sorted([{'node': a, 'port': ap}, {'node': b, 'port': bp}], key=canonical))


def normalized_wiring_value(wiring):
    wiring = wiring.model_dump() if isinstance(wiring, WiringGraph) else wiring
    return {
        'nodes': sorted([{'id': n['id'], 'component': n['component']} for n in wiring['nodes']], key=canonical),
        'edges': sorted([sorted([{'node': e['source'], 'port': e['sourcePort']}, {'node': e['target'], 'port': e['targetPort']}], key=canonical) for e in wiring['edges']], key=canonical),
    }


def readiness_issues(graphs):
    """Incomplete diagrams can be stored. Only supported diagrams can produce an artifact."""
    graphs = graphs if isinstance(graphs, ProjectGraphs) else ProjectGraphs.model_validate(graphs)
    value = graphs.model_dump()
    issues = []

    def add(scope, code, node_id=None, edge_id=None):
        issues.append({'scope': scope, 'code': code, **({'nodeId': node_id} if node_id else {}), **({'edgeId': edge_id} if edge_id else {})})

    wiring = value['wiring']
    nodes = {n['id']: n for n in wiring['nodes']}
    for component in COMPONENTS:
        if sum(n['component'] == component for n in nodes.values()) != 1:
            add('wiring', 'required_component')
    for node in nodes.values():
        if node['component'] == 'custom':
            add('wiring', 'unadapted_component', node['id'])
    source_keys = {connection_key(*c) for c in SOURCE_CONNECTIONS}
    wire_keys = set()
    for edge in wiring['edges']:
        a, b = nodes.get(edge['source']), nodes.get(edge['target'])
        ap = PORTS[a['component']].get(edge['sourcePort']) if a else None
        bp = PORTS[b['component']].get(edge['targetPort']) if b else None
        if not a or not b:
            add('wiring', 'missing_endpoint', edge_id=edge['id'])
        elif a['id'] == b['id']:
            add('wiring', 'self_connection', edge_id=edge['id'])
        elif not ap or not bp:
            add('wiring', 'unknown_port', edge_id=edge['id'])
        elif ap[0] != bp[0] or ap[1] == bp[1] == 'out':
            add('wiring', 'port_mismatch', edge_id=edge['id'])
        elif connection_key(a['component'], edge['sourcePort'], b['component'], edge['targetPort']) not in source_keys:
            add('wiring', 'unadapted_connection', edge_id=edge['id'])
        key = connection_key(edge['source'], edge['sourcePort'], edge['target'], edge['targetPort'])
        if key in wire_keys:
            add('wiring', 'duplicate_connection', edge_id=edge['id'])
        wire_keys.add(key)
    roles = {n['component']: n for n in nodes.values()}
    for index, (a, ap, b, bp) in enumerate(SOURCE_CONNECTIONS):
        if a in roles and b in roles and connection_key(roles[a]['id'], ap, roles[b]['id'], bp) not in wire_keys:
            add('wiring', 'missing_connection', edge_id=f'wire-{index + 1}')

    behavior = value['behavior']
    nodes = {n['id']: n for n in behavior['nodes']}
    stage_nodes = [[n for n in nodes.values() if n['kind'] == 'stage' and n['stage'] == stage] for stage in STAGES]
    for found in stage_nodes:
        if len(found) != 1:
            add('behavior', 'required_stage')
    for edge in behavior['edges']:
        a, b = nodes.get(edge['source']), nodes.get(edge['target'])
        if not a or not b:
            add('behavior', 'missing_endpoint', edge_id=edge['id'])
        elif a['id'] == b['id'] or edge['sourcePort'] != ('true' if a['kind'] == 'condition' else 'next') or edge['targetPort'] != 'in':
            add('behavior', 'invalid_flow_port', edge_id=edge['id'])
    for node in nodes.values():
        ins = sum(e['target'] == node['id'] for e in behavior['edges'])
        outs = sum(e['source'] == node['id'] for e in behavior['edges'])
        start = node['kind'] == 'stage' and node['stage'] == 'requirements'
        end = node['kind'] == 'stage' and node['stage'] == 'control'
        if ins != (0 if start else 1) or outs != (0 if end else 1):
            add('behavior', 'incomplete_flow', node['id'])
    if all(len(found) == 1 for found in stage_nodes):
        path, visited = [], set()
        node = stage_nodes[0][0]
        while node and node['id'] not in visited:
            path.append(node)
            visited.add(node['id'])
            edge = next((e for e in behavior['edges'] if e['source'] == node['id']), None)
            node = nodes.get(edge['target']) if edge else None
        if node or len(visited) != len(nodes):
            add('behavior', 'cycle_or_disconnected')
        if tuple(n['stage'] for n in path if n['kind'] == 'stage') != STAGES:
            add('behavior', 'stage_order')
        for index, node in enumerate(path):
            if node['kind'] == 'stage':
                continue
            before = next((n for n in reversed(path[:index]) if n['kind'] == 'stage'), None)
            after = next((n for n in path[index + 1:] if n['kind'] == 'stage'), None)
            pair = ('preview', 'program') if node['kind'] == 'action' else ('requirements', 'hardware') if node['check'] == 'requirements_ready' else ('wiring', 'preview')
            if not before or not after or (before['stage'], after['stage']) != pair:
                add('behavior', 'node_position', node['id'])
    if sum(n['kind'] == 'action' for n in nodes.values()) > 1:
        add('behavior', 'duplicate_action')
    for check in ('requirements_ready', 'wiring_reviewed'):
        if sum(n['kind'] == 'condition' and n['check'] == check for n in nodes.values()) > 1:
            add('behavior', 'duplicate_condition')
    return issues
