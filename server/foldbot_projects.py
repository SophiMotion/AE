"""Revision-bound FoldBot source snapshots. Never builds or contacts hardware."""
import hashlib
import io
import json
import re
import zipfile
from copy import deepcopy
from pathlib import Path, PurePosixPath
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field, StrictBool, ValidationError, field_validator, model_validator

from .store import now, uid
from .foldbot_graphs import ProjectGraphs, normalized_wiring_value, readiness_issues

PROJECT_KIND = 'foldbot_project'
REVISION_KIND = 'foldbot_project_revision'
GENERATION_KIND = 'foldbot_generation'
TEMPLATE_ID = 'foldbot-existing-firmware-v1'
TEMPLATE_ROOT = Path(__file__).resolve().parents[1] / 'worker'
WARNINGS = [
    '此工程复用现有整机源码，保留网页、底盘、双折叠板和机械臂；不代表 AI 从零实现。',
    '本次只生成源码与配置；未编译、未烧录、未运行 ROS，也未完成实物验收。',
    '磁盘固件版本不等于板上版本。控制前读取 firmwareBuild、限位、故障、行程和参考点状态。',
    '源模板为 Sophicar ESP32-S3 外置驱动、禁限位版本；GPIO35–37 与 N16R8 八线存储器的兼容性仍须现场确认。',
    '折叠端位必须在实物确实到达时人工确认；步进脉冲不是实测位置，舵机 raw 单位不是角度。',
    'AP 口令已移除，构建前必须在本地配置；没有打包旧 .bin，也不会修改原工程或 NVS。',
    '本机连接会初始化底盘功率档；ROS 只提供演示源码，不能与网页同时控制机器人。',
]
EVIDENCE = {
    'source_generated': True, 'compiled': False, 'flashed': False,
    'ros_executed': False, 'hardware_verified': False,
}
DEFAULTS = {
    'name': 'FoldBot 整机工程',
    'request': '复用现有折叠机器人整机源码，保留底盘、双折叠板、机械臂和网页；生成 ROS 演示代码，并在人工核对后进行本机短点动控制。',
    'drive_level': 10, 'drive_duration_ms': 200, 'reviewed': False,
}


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def digest(value):
    return hashlib.sha256(value if isinstance(value, bytes) else value.encode('utf-8')).hexdigest()


def json_text(value):
    return json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n'


class FoldBotFlowConfig(BaseModel):
    """Frozen UI choices, not executable transport or physical acceptance."""
    model_config = ConfigDict(extra='forbid')
    schema_version: int = Field(ge=1, le=1, strict=True)
    robot: Literal['foldbot']
    control: Literal['esp', 'ros']
    wiring_reviewed: StrictBool
    ros_host: Literal['local', 'jetson', 'raspberrypi']
    ros_version: Literal['humble', 'jazzy']
    ros_serial: str = Field(max_length=120, strict=True)
    action_group: Literal['fold-cycle', 'arm-demo', 'chassis-demo']

    @field_validator('ros_serial')
    @classmethod
    def serial_identifier(cls, value):
        if not re.fullmatch(r'(?:|COM[1-9][0-9]{0,3}|/dev/(?:ttyUSB[0-9]{1,3}|ttyACM[0-9]{1,3}|cu\.[A-Za-z0-9_.-]{1,80}))', value):
            raise ValueError('请输入 COM3、/dev/ttyUSB0 或 /dev/cu.usbserial 等串口标识，未知时留空。')
        return value


class GuidedHardware(BaseModel):
    model_config = ConfigDict(extra='forbid')
    controller: Literal['unselected', 'sophicar-s3', 'other']
    fold_driver: Literal['unselected', 'external-step-dir', 'other']
    arm_bus: Literal['unselected', 'buslinker-hx', 'other']
    chassis: Literal['unselected', 'sophicar-m1-m2', 'other']
    notes: str = Field(max_length=2000, strict=True)

    @field_validator('notes')
    @classmethod
    def no_nul(cls, value):
        if '\x00' in value:
            raise ValueError('硬件备注不能包含 NUL。')
        return value


class GuidedConfig(BaseModel):
    """Strict user selections. Unknown hardware remains a draft, never a guessed pinout."""
    model_config = ConfigDict(extra='forbid')
    schema_version: int = Field(ge=1, le=1, strict=True)
    robot_choice: Literal['undecided', 'foldbot', 'other']
    purpose: str = Field(max_length=2000, strict=True)
    primary_task: Literal['unselected', 'fold-cycle', 'arm-demo', 'chassis-demo', 'custom']
    hardware: GuidedHardware
    wiring_binding_sha256: str | None = Field(min_length=64, max_length=64, pattern=r'^[a-f0-9]{64}$', strict=True)

    @field_validator('purpose')
    @classmethod
    def no_nul(cls, value):
        if '\x00' in value:
            raise ValueError('预期结果不能包含 NUL。')
        return value


class ProjectInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    name: str = Field(min_length=1, max_length=120)
    request: str = Field(min_length=1, max_length=12000)
    drive_level: int = Field(default=10, ge=1, le=20, strict=True)
    drive_duration_ms: int = Field(default=200, ge=1, le=2000, strict=True)
    reviewed: StrictBool = False
    workflow: FoldBotFlowConfig | None = None
    guided: GuidedConfig | None = None
    graphs: ProjectGraphs | None = None

    @field_validator('workflow', 'guided', 'graphs', mode='before')
    @classmethod
    def workflow_not_null(cls, value):
        if value is None:
            raise ValueError('流程配置不能为 null；旧客户端可以省略该字段。')
        return value

    @model_validator(mode='after')
    def graph_context(self):
        if self.graphs is not None and (self.guided is None or self.workflow is None):
            raise ValueError('工程图需要引导需求和流程配置，不能附加到旧版工程而省略其参数。')
        return self

    @field_validator('name', 'request')
    @classmethod
    def nonempty(cls, value):
        value = value.strip()
        if not value or '\x00' in value:
            raise ValueError('内容不能为空或包含 NUL。')
        return value


class ProjectUpdate(ProjectInput):
    revision: int = Field(ge=1, strict=True)


class GenerateInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    revision: int = Field(ge=1, strict=True)
    reviewed: Literal[True]

    @field_validator('reviewed', mode='before')
    @classmethod
    def explicit_review(cls, value):
        if value is not True:
            raise ValueError('必须明确确认当前版本的来源、约束和未验证事项。')
        return value


def specification(project):
    value = {key: project[key] for key in
             ('id', 'name', 'request', 'revision', 'drive_level', 'drive_duration_ms')}
    if project.get('workflow') is not None:
        value['workflow'] = deepcopy(project['workflow'])
    if project.get('guided') is not None:
        value['guided'] = deepcopy(project['guided'])
    if project.get('graphs') is not None:
        value['graphs'] = deepcopy(project['graphs'])
    return value


class FoldBotProjects:
    def __init__(self, store, root):
        self.store, self.root = store, Path(root)

    def _templates(self):
        provenance = json.loads((TEMPLATE_ROOT / 'foldbot_source_provenance.json').read_text(encoding='utf-8'))
        contents = {}
        for item in provenance['sources']:
            raw = (TEMPLATE_ROOT / item['template']).read_bytes()
            if digest(raw) != item['sanitized_sha256']:
                raise HTTPException(409, '模板校验失败；停止生成，需复核来源。')
            contents[item['path']] = raw.decode('utf-8-sig')
        return provenance, contents

    def template(self):
        provenance, _ = self._templates()
        return {
            'id': TEMPLATE_ID, 'name': 'FoldBot 折叠机器人',
            'summary': '基于现有完整固件的可追溯源码工程；ROS 为未运行的演示。',
            'defaults': deepcopy(DEFAULTS),
            'limits': {'drive_level': {'min': 1, 'max': 20},
                       'drive_duration_ms': {'min': 1, 'max': 2000},
                       'arm_step_raw': {'min': 1, 'max': 8}},
            'modules': [
                {'id': 'chassis', 'name': '底盘', 'description': '复用现有左右轮控制；本机短点动上限固定。'},
                {'id': 'fold', 'name': '双折叠板', 'description': '保留双轴控制；端位和行程须从现场确认。'},
                {'id': 'arm', 'name': '机械臂', 'description': '保留整机机械臂；网页单轴 raw 小步，动作组未适配。'},
                {'id': 'web', 'name': '嵌入网页', 'description': '保留原始完整 web_ui.h。'},
                {'id': 'ros_demo', 'name': 'ROS 演示', 'description': '默认只输出离线示例；未连接实机、未验收。'},
            ],
            'warnings': list(WARNINGS), 'source_provenance': provenance['sources'],
            'evidence': {**EVIDENCE, 'source_generated': False},
        }

    def wiring_preview(self, body):
        """Pure source selection. No project write, device access or physical certification."""
        body = body if isinstance(body, ProjectInput) else ProjectInput.model_validate(body)
        guided = body.guided
        if (guided is None or guided.robot_choice == 'undecided' or
                not guided.purpose.strip() or guided.primary_task == 'unselected'):
            raise HTTPException(409, 'guided_requirements_incomplete')
        if (guided.robot_choice != 'foldbot' or
                guided.hardware.controller != 'sophicar-s3' or
                guided.hardware.fold_driver != 'external-step-dir' or
                guided.hardware.arm_bus != 'buslinker-hx' or
                guided.hardware.chassis != 'sophicar-m1-m2'):
            raise HTTPException(409, 'guided_hardware_not_adapted')
        if body.graphs is not None:
            issues = [item for item in readiness_issues(body.graphs) if item['scope'] == 'wiring']
            if issues:
                raise HTTPException(409, {'code': 'wiring_graph_not_ready', 'issues': issues})
        provenance, _ = self._templates()
        hardware = guided.hardware.model_dump()
        hardware['notes'] = hardware['notes'].strip()
        inputs = {
            'request': body.request.strip(), 'robot_choice': guided.robot_choice,
            'purpose': guided.purpose.strip(), 'primary_task': guided.primary_task,
            'hardware': hardware,
        }
        if body.graphs is not None:
            inputs['wiring_graph'] = normalized_wiring_value(body.graphs.wiring)
        binding = {
            'schema_version': 1, 'source_key': TEMPLATE_ID, **inputs,
            'source_sha256': sorted([
                {'path': item['path'], 'sanitized_sha256': item['sanitized_sha256']}
                for item in provenance['sources']], key=lambda item: item['path']),
        }
        return {
            'binding_sha256': digest(canonical(binding)), 'input_key': canonical(inputs),
            'source_key': TEMPLATE_ID,
            'connections': [
                {'id': 'fold1', 'label': '第一折叠板', 'label_en': 'Fold plate 1',
                 'pins': 'DIR GPIO3 · STEP GPIO8 · EN GPIO10',
                 'connection': '外置驱动器 DIR+ / PUL+ / ENA+；控制负端接逻辑 GND',
                 'connection_en': 'External driver DIR+ / PUL+ / ENA+; negative inputs to logic GND'},
                {'id': 'fold2', 'label': '第二折叠板', 'label_en': 'Fold plate 2',
                 'pins': 'DIR GPIO4 · STEP GPIO5 · EN GPIO9',
                 'connection': '外置驱动器 DIR+ / PUL+ / ENA+；控制负端接逻辑 GND',
                 'connection_en': 'External driver DIR+ / PUL+ / ENA+; negative inputs to logic GND'},
                {'id': 'arm', 'label': '机械臂总线', 'label_en': 'Arm bus',
                 'pins': 'TX GPIO6 → RX · RX GPIO7 ← TX',
                 'connection': 'BusLinker TTL + 共地；舵机使用独立适配电源',
                 'connection_en': 'BusLinker TTL and common ground; appropriate separate servo supply'},
                {'id': 'chassis', 'label': '履带底盘', 'label_en': 'Tracked chassis',
                 'pins': 'M1 GPIO38 / 37 · M2 GPIO36 / 35',
                 'connection': 'GPIO35–37 与 N16R8 存储器兼容性待确认，勿作为已验证接线',
                 'connection_en': 'GPIO35–37 / N16R8 memory compatibility is unresolved, not verified wiring'},
                {'id': 'limits', 'label': '限位开关', 'label_en': 'Limit switches',
                 'pins': 'GPIO16 / 17 / 18 / 39',
                 'connection': '当前源码禁用；上电后需按实物确认端位，不能自动归零',
                 'connection_en': 'Disabled in source; confirm physical endpoints after power-on, no automatic homing'},
            ],
            'warnings': [
                '此接线来自已选硬件的现有源码，是待核对方案，不代表实物已连接或验证。',
                'GPIO35–37 与 ESP32-S3 N16R8 内部存储器的兼容性待确认。',
                '外置驱动型号、电流与电源、舵机波特率及实际行程须现场核对；不推测未知参数。',
            ],
            'physical_verified': False,
        }

    def _require_guided_ready(self, project):
        if project.get('graphs') is not None:
            try:
                graphs = ProjectGraphs.model_validate(project['graphs'])
            except ValidationError:
                raise HTTPException(409, 'invalid_project_graphs') from None
            if project.get('guided') is None or project.get('workflow') is None:
                raise HTTPException(409, 'graphs_require_guided_workflow')
            issues = readiness_issues(graphs)
            if issues:
                raise HTTPException(409, {'code': 'project_graph_not_ready', 'issues': issues})
        if project.get('guided') is None:
            return
        if project.get('workflow') is None:
            raise HTTPException(409, 'guided_control_not_selected')
        preview = self.wiring_preview(self._preview_input(project))
        if project['guided']['wiring_binding_sha256'] != preview['binding_sha256']:
            raise HTTPException(409, 'guided_wiring_binding_stale')
        if not project['workflow']['wiring_reviewed']:
            raise HTTPException(409, 'guided_wiring_review_required')

    @staticmethod
    def _preview_input(project):
        return {key: project[key] for key in
                ('name', 'request', 'drive_level', 'drive_duration_ms', 'guided', 'workflow', 'graphs')
                if project.get(key) is not None}

    def list(self):
        return self.store.list(PROJECT_KIND)

    def get(self, project_id):
        try:
            return self.store.get(PROJECT_KIND, project_id)
        except KeyError:
            raise HTTPException(404, '没有找到这个 FoldBot 工程。') from None

    def _record_revision(self, project):
        self.store.put(REVISION_KIND, {
            'id': f'{project["id"]}-r{project["revision"]}',
            'project_id': project['id'], 'revision': project['revision'],
            'created_at': now(), 'snapshot': deepcopy(project),
        })

    def create(self, body):
        body = body if isinstance(body, ProjectInput) else ProjectInput.model_validate(body)
        stamp = now()
        project = {
            'id': uid(), **{key: value for key, value in body.model_dump().items() if value is not None},
            'reviewed': False, 'revision': 1,
            'created_at': stamp, 'updated_at': stamp, 'generation': None,
            'warnings': list(WARNINGS),
        }
        with self.store.lock:
            self.store.put(PROJECT_KIND, project)
            self._record_revision(project)
        return project

    def update(self, project_id, body):
        body = body if isinstance(body, ProjectUpdate) else ProjectUpdate.model_validate(body)
        with self.store.lock:
            project = self.get(project_id)
            if body.revision != project['revision']:
                raise HTTPException(409, '工程已更新，请刷新后重新核对当前修订。')
            # Only omit absent top-level legacy fields. A nested null digest is a valid,
            # intentional "not generated yet" value and must survive save/reload.
            values = {key: value for key, value in body.model_dump(exclude={'revision', 'reviewed'}).items()
                      if value is not None}
            # Legacy clients must preserve a new client's workflow rather than erase it.
            if all(project.get(key) == value for key, value in values.items()):
                return project
            project.update(**values, revision=project['revision'] + 1,
                           reviewed=False, generation=None, updated_at=now())
            self.store.put(PROJECT_KIND, project)
            self._record_revision(project)
            return project

    def _config(self, project):
        value = {
            'schema_version': 1, 'template_id': TEMPLATE_ID,
            'project': specification(project),
            'local_control': {
                'drive_level': project['drive_level'],
                'drive_duration_ms': project['drive_duration_ms'],
                'hard_limits': {'drive_level': 20, 'drive_duration_ms': 2000, 'arm_step_raw': 8},
                'modules': {'chassis': True, 'fold': True, 'arm': True},
                'fold': {'axes': 2, 'manual_reference_required': True, 'travel': 'read_live_not_assumed'},
                'arm': {'step_unit': 'raw', 'max_step_raw': 8},
                'calibration_override': False, 'automatic_connect': False,
                'automatic_enable': False, 'automatic_motion': False,
            },
            'firmware': {'source_build': 'foldbot-20260929-sophicar-external-driver-no-limits',
                         'live_build': None, 'ap_password': 'configure_locally_before_build',
                         'parameters_applied_to_firmware': False},
            'ros_demo': {'tested': False, 'hardware_transport': False,
                         'default_network_output': False, 'default_motion_output': False},
            'evidence': deepcopy(EVIDENCE), 'warnings': list(WARNINGS),
        }
        if project.get('guided') is not None:
            control = project['workflow']['control']
            value['output_contract'] = {
                'selected_target': control, 'firmware_included': control == 'esp',
                'ros_demo_included': control == 'ros', 'hardware_verified': False,
                'wiring_binding_sha256': project['guided']['wiring_binding_sha256'],
            }
        return value

    def _files(self, project, config, provenance, templates):
        files = {}

        def add(path, kind, purpose, content):
            files[path] = {'path': path, 'type': kind, 'purpose': purpose, 'content': content,
                           'bytes': len(content.encode('utf-8')), 'sha256': digest(content)}

        add('firmware/foldbot/foldbot.ino', 'arduino', '脱敏后的完整整机固件，未编译。', templates['espkuozhanban.ino'])
        add('firmware/foldbot/web_ui.h', 'cpp-header', '完整嵌入网页，保留底盘、双板和机械臂。', templates['web_ui.h'])
        add('firmware/foldbot/foldbot_local_config.h', 'cpp-header', '要求在本地配置 AP 口令；未配置时主动阻止构建。',
            '#pragma once\n// Configure a private 8-63 character Wi-Fi AP password locally.\n'
            '// Add #define FOLDBOT_AP_PASSWORD "YOUR_LOCAL_VALUE" above this guard.\n'
            '// Do not publish the configured file. No original password is included.\n'
            '#ifndef FOLDBOT_AP_PASSWORD\n'
            '#error "Set FOLDBOT_AP_PASSWORD locally before building this template"\n'
            '#define FOLDBOT_AP_PASSWORD ""\n#endif\n'
            'static_assert(sizeof(FOLDBOT_AP_PASSWORD) >= 9 && sizeof(FOLDBOT_AP_PASSWORD) <= 64,\n'
            '              "AP password must be 8-63 characters");\n')
        add('config/foldbot_config.json', 'json', '当前 PRD 修订和本机控制边界；不覆盖固件或 NVS 标定。', json_text(config))
        add('provenance.json', 'json', '原始及脱敏模板的 SHA-256 与变换记录。', json_text(provenance))
        add('prd.json', 'json', '生成时冻结的需求修订。', json_text(specification(project)))
        if project.get('workflow') is not None:
            flow = project['workflow']
            add('config/workflow.json', 'json', '当前控制方案、ROS 主机、版本、串口及预览动作组；不自动执行。', json_text(flow))
            add('config/wiring.json', 'json', '整机源码中的固定引脚与待核对事项；不是实物接线验收。', json_text(self._wiring(flow)))
            add('config/action_preview.json', 'json', '只用于浏览器视觉预览；没有实机运动目标或传感器测量。', json_text({
                'schema_version': 1, 'robot': 'foldbot', 'action_group': flow['action_group'],
                'visual_only': True, 'hardware_target': None, 'gazebo_executed': False,
                'measured_angle_deg': None, 'measured_speed': None, 'measured_torque_nm': None,
                'progress_range': [0, 1], 'automatic_motion': False,
            }))
            add('ros2/foldbot_demo/foldbot_demo/workflow.json', 'json', 'ROS 离线演示读取的本修订配置；串口仅作为待确认配置打印。', json_text(flow))
            add('deployment.md', 'markdown', '本修订部署目标及串口用途说明；ROS 不通过 COM 烧录。', self._deployment(project))
        add('ros2/foldbot_demo/foldbot_demo/demo.py', 'python', '未运行的 ROS 演示；默认离线打印，无设备传输。',
            self._ros_demo(project))
        add('ros2/foldbot_demo/foldbot_demo/__init__.py', 'python', 'ROS 演示 Python 包。',
            '"""Untested generated FoldBot demo; no hardware acceptance."""\n')
        add('ros2/foldbot_demo/resource/foldbot_demo', 'ros-resource', 'ament 包索引标记。', '')
        add('ros2/foldbot_demo/setup.cfg', 'ini', 'ROS Python 入口安装位置。',
            '[develop]\nscript_dir=$base/lib/foldbot_demo\n[install]\ninstall_scripts=$base/lib/foldbot_demo\n')
        add('ros2/foldbot_demo/setup.py', 'python', 'ROS 演示包安装描述；没有自动执行步骤。',
            'from setuptools import setup\n\nsetup(\n    name="foldbot_demo", version="0.0.1",\n'
            '    packages=["foldbot_demo"],\n' +
            ('    package_data={"foldbot_demo": ["workflow.json"]},\n' if project.get('workflow') is not None else '') +
            '    data_files=[\n'
            '        ("share/ament_index/resource_index/packages", ["resource/foldbot_demo"]),\n'
            '        ("share/foldbot_demo", ["package.xml"]),\n    ],\n'
            '    install_requires=["setuptools"], zip_safe=True,\n'
            '    maintainer="Local user", maintainer_email="local@example.invalid",\n'
            '    description="Untested log-only FoldBot demonstration", license="UNLICENSED",\n'
            '    entry_points={"console_scripts": ["demo = foldbot_demo.demo:main"]},\n)\n')
        add('ros2/foldbot_demo/package.xml', 'xml', 'ROS 2 演示依赖；ROS 发行版与运行环境尚未验证。',
            '<?xml version="1.0"?>\n<package format="3">\n'
            '  <name>foldbot_demo</name><version>0.0.1</version>\n'
            '  <description>Untested generated log-only demo, no hardware transport</description>\n'
            '  <maintainer email="local@example.invalid">Local user</maintainer>\n'
            '  <license>UNLICENSED</license>\n  <buildtool_depend>ament_python</buildtool_depend>\n'
            '  <exec_depend>rclpy</exec_depend>\n'
            '  <export><build_type>ament_python</build_type></export>\n</package>\n')
        add('README.md', 'markdown', '源码来源、复现方法、硬件待确认项和证据边界。', self._readme(project))
        if project.get('guided') is not None:
            control = project['workflow']['control']
            omitted_prefix = 'ros2/' if control == 'esp' else 'firmware/'
            files = {path: item for path, item in files.items() if not path.startswith(omitted_prefix)}
            preview = self.wiring_preview(self._preview_input(project))
            add('config/guided.json', 'json', '需求问答、用户选择的硬件及接线摘要；不代表物理兼容性验收。', json_text(project['guided']))
            add('config/wiring_preview.json', 'json', '与当前需求及硬件选择绑定的接线产物，含来源和未核对事项。', json_text(preview))
        if project.get('graphs') is not None:
            graphs = project['graphs']
            add('config/wiring_graph.json', 'json', '用户编辑的元件端口连接；已匹配源码模板，未作实物验收。', json_text({
                'schema_version': 1, 'kind': 'ae_source_wiring', 'graph': graphs['wiring'],
                'wiring_binding_sha256': project['guided']['wiring_binding_sha256'],
                'physical_verified': False,
                'unrepresented': ['driver_motor_coils', 'motor_power_supply', 'servo_power_supply'],
            }))
            add('config/behavior_graph.json', 'json', 'AE 工程步骤、预览动作和条件；不是自动运动程序。', json_text({
                'schema_version': 1, 'kind': 'ae_project_workflow', 'graph': graphs['behavior'],
                'shared_parameter_sources': ['prd.json:request', 'config/guided.json', 'config/workflow.json'],
                'condition_false': 'pause', 'action_ref': 'workflow.action_group',
                'action_meaning': 'browser_visual_preview_only', 'automatic_motion': False,
                'physical_verified': False,
            }))
        manifest = {'schema_version': 1, 'project_id': project['id'], 'revision': project['revision'],
                    'template_id': TEMPLATE_ID, 'config_sha256': digest(canonical(config)),
                    'evidence': deepcopy(EVIDENCE),
                    'files': [{key: value for key, value in item.items() if key != 'content'}
                              for item in files.values()],
                    'self_hash_note': 'manifest.json excludes itself to avoid recursive hashing; its hash is in generation.files.'}
        add('manifest.json', 'json', '所有交付文件的用途、类型及 SHA-256（自身哈希在生成记录）。', json_text(manifest))
        return files

    def _wiring(self, flow):
        return {
            'schema_version': 1, 'source_build': 'foldbot-20260929-sophicar-external-driver-no-limits',
            'source_only': True, 'hardware_verified': False,
            'user_reviewed_source_information': flow['wiring_reviewed'],
            'fold_axes': [
                {'axis': 1, 'dir_gpio': 3, 'step_gpio': 8, 'enable_gpio': 10},
                {'axis': 2, 'dir_gpio': 4, 'step_gpio': 5, 'enable_gpio': 9},
            ],
            'driver': {'model': 'unconfirmed_external_optocoupled_driver',
                       'inputs': {'DIR+': 'DIR GPIO', 'PUL+': 'STEP GPIO', 'ENA+': 'EN GPIO'},
                       'negative_inputs': 'logic_GND', 'enable_level': 0,
                       'electrical_compatibility_verified': False},
            'arm': {'tx_gpio': 6, 'rx_gpio': 7, 'bridge': 'BusLinker TTL',
                    'baud_source': 115200, 'baud_hardware_verified': False,
                    'power': 'separate_appropriate_supply_not_ESP_3v3_or_5v'},
            'chassis': {'M1_gpio': [38, 37], 'M2_gpio': [36, 35]},
            'limits': {'gpio': [16, 17, 18, 39], 'enabled_in_source': False,
                       'automatic_homing': False, 'manual_endpoint_reference_required': True},
            'unresolved': [
                'GPIO35–37 may conflict with N16R8 internal memory; board and wiring compatibility are not verified.',
                'Read live firmwareBuild before control. Source version is not the flashed version.',
                'Driver identity, supply, phase current, servo baud and calibrated travel require physical confirmation.',
            ],
        }

    def _ros_demo(self, project):
        source = (TEMPLATE_ROOT / 'foldbot_ros_demo.py').read_text(encoding='utf-8')
        if project.get('workflow') is None:
            return source
        # Data is packaged as JSON, never interpolated as commands or source code.
        return source.replace('import json\n', 'import json\nfrom pathlib import Path\n').replace(
            '"mode": "offline_demo",',
            '"mode": "offline_demo",\n'
            '        "workflow": json.loads(Path(__file__).with_name("workflow.json").read_text(encoding="utf-8")),\n'
            '        "serial_configuration_only": True,')

    def _deployment(self, project):
        if project.get('guided') is not None:
            return self._guided_deployment(project)
        flow = project['workflow']
        return f'''# FoldBot deployment choices (revision {project['revision']})

Current configuration: `config/workflow.json`. Wiring source: `config/wiring.json`.

- Control path: `{flow['control']}`.
- ROS target host: `{flow['ros_host']}`; requested ROS 2 distribution: `{flow['ros_version']}`.
- ROS serial transport label: `{flow['ros_serial'] or 'unselected'}`. This is data only; this demo does not open it.
- Browser action preview: `{flow['action_group']}`; visual only, no motor commands.

## ESP32

The complete firmware source is in `firmware/foldbot`. Follow its README to configure the local AP password and confirm the exact board and toolchain before compiling.
A USB serial device is an upload transport. Source generation does not create a verified binary; never substitute an old .bin. No flash, NVS erase or motion happens from this export.

## ROS 2

ROS is installed and runs on the selected host; it is not firmware flashed through a COM port.
The serial label describes a future ROS-to-device transport only. The current robot uses Wi-Fi WebSocket control, and a serial ROS transport has not been implemented.
`ros2/foldbot_demo/foldbot_demo/demo.py` loads the accompanying `workflow.json` and prints these selections as an offline example.
Even `--run-ros` is log-only. ROS installation, distribution/host compatibility, Gazebo and real robot control are unverified.

## Evidence

Source and configuration generated only. Compiled: false. Flashed: false. ROS executed: false. Gazebo executed: false. Hardware verified: false.
Reviewing wiring information acknowledges the source description; it does not resolve GPIO35–37 / N16R8 compatibility or certify physical wiring.
'''

    def _readme(self, project):
        if project.get('guided') is not None:
            return self._guided_readme(project)
        return f'''# FoldBot generated source snapshot

Project ID: `{project['id']}` · PRD revision: `{project['revision']}`

这是基于既有整机工程的模板复用。完整需求见 `prd.json`；配置见
`config/foldbot_config.json`；文件用途与校验见 `manifest.json`。
旧版本生成记录不会变成新需求的证据。修改需求、档位或时长后必须重新核对并生成。

## 生成证据

本次仅生成源文件与配置。未编译、未安装或运行 ROS、未烧录、未连接硬件、
未验证实物动作。没有包含历史 .bin 文件。协议 ACK、缓存反馈、步进脉冲计数
和实际到位是不同证据；舵机 raw 单位不能当作角度。

## 固件来源与本地复现

`firmware/foldbot/foldbot.ino` 与 `web_ui.h` 复用现有 Sophicar 整机源码，
保留网页、底盘、双折叠板和机械臂。原始/脱敏 SHA-256 在 `provenance.json`。
AP 口令常量改为本地配置宏，同时隐藏串口口令输出。原始工程未改动。

1. 阅读来源、需求与待确认项。用 Arduino IDE 打开 `firmware/foldbot/foldbot.ino`。
2. 在 `foldbot_local_config.h` 的保护条件之前加入本地
   `#define FOLDBOT_AP_PASSWORD "本地设置的8至63字符口令"`。未设置会故意停止编译；
   配置后文件含私人口令，不适合公开分享。
3. 源码历史设置为 ESP32S3 Dev Module、Flash 16MB、PSRAM Disabled、USB CDC
   On Boot Enabled、串口 115200；它们是来源记录，不能替代现场板卡确认。
   该源码使用 ESP32 GPTimer、cJSON、WiFi 与 ESP-IDF 接口。此生成包没有锁定并验证
   Arduino-ESP32/ESP-IDF 工具链版本，需要在真实板卡与工具链确定后单独编译验收。
4. 本轮生成未进行构建或烧录。实际上传须在硬件核对及另行明确操作后进行，
   不应自动擦除 NVS。JSON 档位和时长仅约束 AE 本机控制，不会改写固件内置参数。

## ROS 2 演示

`ros2/foldbot_demo` 是未运行、未构建的 ament_python 演示包。
默认从该目录运行 `python -m foldbot_demo.demo` 只打印一条标为离线示例的 JSON，
不导入 rclpy、不创建网络连接、不发送运动指令。生成服务没有执行这条命令。
如果之后在独立确认的 ROS 2 环境构建并安装该包，`ros2 run foldbot_demo demo`
仍默认离线退出；显式添加 `--run-ros` 才创建只记录日志的 ROS 节点，
此模式可能产生 ROS DDS 发现流量，但没有机器人传输或运动发布器。
这不能证明 ROS 已控制实机。ROS 发行版、依赖版本与实机集成均待确认。

## 必须现场确认的事项

- 磁盘来源 build 为 `foldbot-20260929-sophicar-external-driver-no-limits`；
  板上 `firmwareBuild`、限位、双轴数量、故障、急停、行程与参考点须读取实时状态。
- Sophicar ESP32-S3-N16R8 的 GPIO35–37 与八线存储器保留脚存在兼容性疑点；
  此包不声明引脚、电源、外部驱动和实际接线兼容，不提供猜测的接线替换。
- 禁限位源码不能使用限位自动归零流程。两板人工端位确认必须与真实端位一致；
  不凭软件计数推断实际位置，不继承旧控制器未经核实的 NVS 标定。
- 本机连接会初始化底盘功率档。当前选择档位 {project['drive_level']}、
  单次时长 {project['drive_duration_ms']} ms；硬上限为档位 20、2000 ms。
  机械臂单次上限 8 raw；动作组尚未适配，不提供标定上限覆盖。
- 网页与 ROS 不同时控制 ESP32。单操作者、短租约、主动使能、离开页面撤销及
  全停属于本机控制层；此源码生成记录本身不证明任何这些功能已在硬件验收。
'''

    def _guided_deployment(self, project):
        flow = project['workflow']
        if flow['control'] == 'esp':
            target = '''## ESP32 source and USB update

The selected output is the complete ESP32 robot firmware in `firmware/foldbot/`.
The ROS demo package is not included in this export.
Set the private AP password in `foldbot_local_config.h` locally before compiling.
Confirm the actual board, flash size, partition layout, dependencies and toolchain.
Source generation does not compile a binary. Do not use a historical .bin in its place.
The browser USB update needs a newly built application image and matching partition evidence;
it is not an empty-board installer and must not overwrite NVS or change the partition map.
USB write/readback alone is not physical acceptance. Verify the running firmware version separately.
'''
        else:
            target = f'''## ROS 2 offline demonstration

The selected output is `ros2/foldbot_demo/`. ESP32 firmware is not included.
Requested host: `{flow['ros_host']}`. Requested ROS 2 distribution: `{flow['ros_version']}`.
Serial label: `{flow['ros_serial'] or 'unselected'}`. This is configuration data only.
ROS runs on its host and is not firmware flashed through a COM port.
The package defaults to printing one offline JSON record. `--run-ros` is log-only;
it does not implement a serial, WebSocket or motor-control transport.
No new USB flash session should be started from this ROS-only artifact.
The AE final console can separately use an existing ESP32 firmware via its hotspot,
after explicit connection checks. This does not validate ROS control.
'''
        return f'''# Deployment for revision {project['revision']}

Control target: `{flow['control']}`. No transport is opened by this file.
The frozen choices are in `config/workflow.json` and `config/guided.json`.
The generated source wiring is `config/wiring_preview.json`; physical_verified is false.
{target}
## Evidence boundary

Generated source/configuration only. No build, flash, Gazebo, ROS execution or physical motion was verified.
User requirement text is recorded and bound to the source snapshot; it is not converted into
an arbitrary new motor controller. The known FoldBot template preserves the whole-robot behavior.
GPIO35–37 / N16R8 compatibility, external-driver identity, supply/current, servo baud rate,
calibrated travel and live firmwareBuild remain field checks. Do not infer them from this export.
'''

    def _guided_readme(self, project):
        flow = project['workflow']
        graph_docs = '''
## 工程图

`config/wiring_graph.json` 保存元件与端口连接并绑定接线摘要；不包含未核对的驱动线圈和动力供电接线。
`config/behavior_graph.json` 描述 AE 的需求、硬件、接线、预览、程序、部署和控制步骤。
节点参数引用 `prd.json`、`config/guided.json` 与 `config/workflow.json`，不另存一套需求或动作值。
条件不满足时暂停；动作节点仅引用浏览器视觉预览组，不生成或自动下发机器人动作。
更改连接须重新生成接线并核对；更改流程须重新生成工程。节点布局保存在浏览器，不是硬件参数。
''' if project.get('graphs') is not None else ''
        if flow['control'] == 'esp':
            target = '''## ESP32 工程

本次仅输出 ESP32 固件，不包含 ROS 包。
`firmware/foldbot/foldbot.ino`、`web_ui.h` 复用现有 Sophicar 完整整机源码，
保留网页、底盘、双折叠板和机械臂。`foldbot_local_config.h` 要求在本地设置
8 至 63 字符私有 AP 口令；未设置时主动阻止构建，配置后不要公开该文件。
已记录来源设置为 ESP32S3 Dev Module、Flash 16MB、PSRAM Disabled、USB CDC On Boot Enabled；
这些是来源记录，不能替代现场板型确认。固件依赖 Arduino-ESP32、ESP-IDF GPTimer、
cJSON 和 WiFi；工具链版本未锁定并验收，需在目标环境单独编译。
浏览器 USB 更新需要本修订新编译的应用 .bin 和匹配的分区证据；没有打包任何历史 .bin。
它仅更新匹配分区中的应用，不整片擦除、不替换分区或 NVS、不自动运动。
'''
        else:
            target = '''## ROS 演示工程

本次仅输出 `ros2/foldbot_demo`，不包含 ESP32 固件，也不提供本工程的 USB 烧录入口。
默认从包目录运行 `python -m foldbot_demo.demo` 只打印标为离线示例的 JSON；
不导入 rclpy、不连接设备、不发送运动指令。生成服务没有执行该命令。
在单独核对的 ROS 环境构建安装后，`ros2 run foldbot_demo demo` 同样默认离线退出；
`--run-ros` 仅创建日志节点，可能产生 DDS 发现流量，没有机器人运动发布器。
依赖 `ament_python`、`rclpy`、`setuptools`，所选主机/ROS 发行版仍须部署验证。
ROS 运行在主机上，不能经 COM 口当作 ESP 固件烧录。串口标签仅作后续传输配置记录。
最后的 AE 原版控制台可以另行连接已安装固件的 ESP 热点，这不代表 ROS 已控制实机。
'''
        return f'''# 引导式机器人源码工程

工程 ID：`{project['id']}` · 需求修订：`{project['revision']}` · 输出方案：`{flow['control']}`

此工程从用户需求和硬件选择生成可追溯的接线方案，再复用已适配 FoldBot 源码。
现阶段仅完整适配现有 Sophicar 折叠机器人硬件组合；未知机器人和硬件保留待适配。
需求文字会记录到工程，不等于自动实现任意新动作或把仿真滑杆发送到实物。

## 文件导航

- `prd.json`：冻结的原始需求、问答和修订。
- `config/guided.json`：目标、主要动作、硬件选择及接线绑定摘要。
- `config/wiring_preview.json`：生成的接线方案及来源，实物验证状态为 false。
- `config/wiring.json`：已有整机源码的引脚与未确认约束。
- `config/workflow.json`：所选 ESP/ROS 路线及部署设置。
- `config/action_preview.json`：纯视觉预览设置，角度/速度/扭矩测量值均为 null。
- `config/foldbot_config.json`：AE 控制边界，不能覆盖 NVS 标定。
- `provenance.json`：模板来源和 SHA-256；`manifest.json`：文件名、类型、用途及校验。
- `deployment.md`：所选路线的依赖、部署目标与操作边界。
{target}
{graph_docs}
## 核验要求

接线产物绑定当前需求、期望结果、动作类别、硬件组合和模板源码摘要。
修改这些内容后须重新生成接线并确认；修改控制路线或部署设置须重新生成工程。
确认源码接线不代表现场兼容性核验。GPIO35–37 与 N16R8 内部存储器仍存在兼容性疑点。
外置驱动具体型号、相电流、电源、舵机波特率和标定行程不能推测。
禁限位版本上电后要人工确认真实端位；开环脉冲、原始舵机单位与实测角度不同。
连接前读取实际 firmwareBuild；磁盘源码版本不是板上版本。
网页和 ROS 不同时控制 ESP32；旧标定不由导出的 JSON 覆盖。

本次证据仅为源码与配置生成：未编译、未烧录、未运行 ROS/Gazebo、未验证实物动作。
'''

    def generate(self, project_id, body):
        body = body if isinstance(body, GenerateInput) else GenerateInput.model_validate(body)
        with self.store.lock:
            project = self.get(project_id)
            if project['revision'] != body.revision:
                raise HTTPException(409, '请求对应旧修订，请重新核对并生成。')
            self._require_guided_ready(project)
            if project.get('workflow') is not None:
                flow = FoldBotFlowConfig.model_validate(project['workflow'])
                if not flow.wiring_reviewed:
                    raise HTTPException(409, '请先核对折叠机器人模型与源码接线说明，再生成当前流程工程。')
            if project.get('generation'):
                return self.require_current_generation(project_id, body.revision)
            provenance, templates = self._templates()
            config = self._config(project)
            files = self._files(project, config, provenance, templates)
            metadata = [{k: v for k, v in item.items() if k != 'content'} for item in files.values()]
            generation = {
                'id': uid(), 'revision': project['revision'], 'created_at': now(),
                'status': 'source_generated', 'sha256': digest(canonical(metadata)),
                'spec_sha256': digest(canonical(specification(project))),
                'config_sha256': digest(canonical(config)), 'config': config,
                'files': metadata, 'source_provenance': provenance['sources'],
                'evidence': deepcopy(EVIDENCE),
            }
            snapshot = {'id': generation['id'], 'project_id': project_id,
                        'revision': project['revision'], 'created_at': generation['created_at'],
                        'specification': specification(project), 'generation': generation, 'files': files}
            self.store.put(GENERATION_KIND, snapshot)
            project.update(generation=generation, reviewed=True, updated_at=now())
            self.store.put(PROJECT_KIND, project)
            return project

    def require_current_generation(self, project_id, revision=None):
        with self.store.lock:
            project = self.get(project_id)
            self._require_guided_ready(project)
            generation = project.get('generation')
            if revision is not None and revision != project['revision']:
                raise HTTPException(409, '工程版本已改变，控制配置已失效。')
            if not generation or not project.get('reviewed') or generation['revision'] != project['revision']:
                raise HTTPException(409, '请先核对并生成当前修订的工程。')
            if generation['spec_sha256'] != digest(canonical(specification(project))):
                raise HTTPException(409, '生成记录与当前需求不一致。')
            config = self._config(project)
            if generation.get('config') != config or generation.get('config_sha256') != digest(canonical(config)):
                raise HTTPException(409, '生成配置校验失败。')
            try:
                snapshot = self.store.get(GENERATION_KIND, generation['id'])
            except KeyError:
                raise HTTPException(409, '生成快照缺失，请检查本机存储。') from None
            if snapshot.get('generation') != generation or snapshot.get('specification') != specification(project):
                raise HTTPException(409, '生成快照与当前记录不一致。')
            return project

    def _current_files(self, project_id):
        project = self.require_current_generation(project_id)
        snapshot = self.store.get(GENERATION_KIND, project['generation']['id'])
        files = snapshot['files']
        metadata = [{k: v for k, v in item.items() if k != 'content'} for item in files.values()]
        if metadata != project['generation']['files'] or digest(canonical(metadata)) != project['generation']['sha256']:
            raise HTTPException(409, '文件清单校验失败。')
        for path, item in files.items():
            if path != item['path'] or digest(item['content']) != item['sha256']:
                raise HTTPException(409, '生成文件内容校验失败。')
        return project, files

    def file(self, project_id, path):
        # Purely virtual whitelist: no user-controlled path is opened on disk.
        if not path or '\\' in path or re.search(r'[\x00-\x1f]', path):
            raise HTTPException(404, '文件不在当前生成清单中。')
        parsed = PurePosixPath(path)
        if parsed.is_absolute() or '..' in parsed.parts or parsed.as_posix() != path:
            raise HTTPException(404, '文件不在当前生成清单中。')
        with self.store.lock:
            project, files = self._current_files(project_id)
            if path not in files:
                raise HTTPException(404, '文件不在当前生成清单中。')
            return {**files[path], 'revision': project['revision']}

    def export(self, project_id):
        with self.store.lock:
            project, files = self._current_files(project_id)
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
                for path, item in files.items():
                    archive.writestr(path, item['content'].encode('utf-8'))
            return project, buffer.getvalue()


def create_router(store, root, *, projects=None):
    service = projects or FoldBotProjects(store, root)
    router = APIRouter(prefix='/api/foldbot', tags=['FoldBot projects'])
    router.foldbot_projects = service

    @router.get('/template')
    def template():
        return service.template()

    @router.post('/wiring/preview')
    def wiring_preview(body: ProjectInput):
        return service.wiring_preview(body)

    @router.get('/projects')
    def projects_list():
        return service.list()

    @router.post('/projects')
    def project_create(body: ProjectInput):
        return service.create(body)

    @router.get('/projects/{project_id}')
    def project_get(project_id: str):
        return service.get(project_id)

    @router.put('/projects/{project_id}')
    def project_update(project_id: str, body: ProjectUpdate):
        return service.update(project_id, body)

    @router.post('/projects/{project_id}/generate')
    def generate(project_id: str, body: GenerateInput):
        return service.generate(project_id, body)

    @router.get('/projects/{project_id}/file')
    def file(project_id: str, path: str = Query(min_length=1, max_length=300)):
        return service.file(project_id, path)

    @router.get('/projects/{project_id}/export')
    def export(project_id: str):
        project, data = service.export(project_id)
        return Response(data, media_type='application/zip', headers={
            'Content-Disposition': f'attachment; filename="foldbot-{project["id"]}-r{project["revision"]}.zip"',
        })

    return router
