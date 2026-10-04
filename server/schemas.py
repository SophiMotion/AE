"""Human-approved input contract. These bounds are independent of generated code."""
import math
from typing import Annotated, Any, Literal
from pydantic import BaseModel, ConfigDict, Field, StrictFloat, StrictInt, StrictStr, field_validator, model_serializer, model_validator


class Parameters(BaseModel):
    model_config = ConfigDict(extra='forbid')
    target: float = Field(default=0.6, ge=-2*math.pi, le=2*math.pi)
    threshold: float = Field(default=0.5, ge=0.1, le=0.9)
    tolerance: float = Field(default=0.04, ge=0.005, le=0.15)
    duration: float = Field(default=8.0, ge=4, le=30)
    max_velocity: float = Field(default=0.8, ge=0.1, le=2)

    @field_validator('*')
    @classmethod
    def finite(cls, value):
        if not math.isfinite(value):
            raise ValueError('参数必须是有限数字')
        return value


class Hardware(BaseModel):
    model_config = ConfigDict(extra='forbid')
    board: Literal['esp32', 'esp32s3'] = 'esp32'
    transport: Literal['serial_jsonl'] = 'serial_jsonl'
    ros_distro: Literal['humble'] = 'humble'
    actuator: Literal['virtual_joint', 'virtual_switch'] = 'virtual_joint'
    sensor: Literal['simulated_encoder', 'simulated_scalar'] = 'simulated_encoder'
    baudrate: Literal[115200] = 115200
    physical_io: Literal[False] = False


class ProductRequirements(BaseModel):
    model_config = ConfigDict(extra='forbid')
    use_case: str = Field(default='验证机器人控制与通信', max_length=500)
    environment: Literal['desktop_simulation'] = 'desktop_simulation'
    constraints: str = Field(default='无实物，仅固件编译和软件通信验证。', max_length=2000)
    acceptance: str = Field(default='ROS 与固件编译通过，任务效果及通信异常检查通过。', max_length=2000)
    structure_id: str | None = Field(default=None, max_length=100, pattern=r'^[a-zA-Z0-9_-]+$')
    joint_name: str | None = Field(default=None, max_length=120)


class ProjectInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    name: str = Field(min_length=1, max_length=100)
    request: str = Field(min_length=5, max_length=4000)
    task_type: Literal['joint_position', 'sensor_threshold']
    parameters: Parameters = Field(default_factory=Parameters)
    hardware: Hardware = Field(default_factory=Hardware)
    prd: ProductRequirements = Field(default_factory=ProductRequirements)
    workflow: dict | None = None

    @field_validator('name', 'request')
    @classmethod
    def nonblank(cls, value):
        if not value.strip():
            raise ValueError('请输入内容')
        return value.strip()


class IntakeAnswers(BaseModel):
    """Draft answers stay empty until the user supplies them; no engine defaults."""
    model_config = ConfigDict(extra='forbid')
    structure_id: str | None = Field(default=None, max_length=100)
    joint_name: str | None = Field(default=None, max_length=120)
    board: Literal['esp32', 'esp32s3'] | None = None
    target_rad: float | None = Field(default=None, strict=True, allow_inf_nan=False)
    tolerance_rad: float | None = Field(default=None, strict=True, allow_inf_nan=False)
    max_velocity_rad_s: float | None = Field(default=None, strict=True, allow_inf_nan=False)
    duration_s: float | None = Field(default=None, strict=True, allow_inf_nan=False)
    threshold: float | None = Field(default=None, strict=True, allow_inf_nan=False)
    wave_start_rad: float | None = Field(default=None, strict=True, allow_inf_nan=False)
    wave_end_rad: float | None = Field(default=None, strict=True, allow_inf_nan=False)
    repetitions: int | None = Field(default=None, strict=True)
    dwell_s: float | None = Field(default=None, strict=True, allow_inf_nan=False)
    end_behavior: Literal['return_start', 'hold_end', 'custom'] | None = None
    end_position_rad: float | None = Field(default=None, strict=True, allow_inf_nan=False)
    other_action: str = Field(default='', max_length=2000)


class HardwareNote(BaseModel):
    model_config = ConfigDict(extra='forbid')
    value: str = Field(default='', max_length=2000)
    source: str = Field(default='', max_length=2000)
    status: Literal['unknown', 'provided', 'documented'] = 'unknown'


class HardwareNotes(BaseModel):
    model_config = ConfigDict(extra='forbid')
    board_model: HardwareNote = Field(default_factory=HardwareNote)
    flash_psram: HardwareNote = Field(default_factory=HardwareNote)
    motor_model: HardwareNote = Field(default_factory=HardwareNote)
    driver_model: HardwareNote = Field(default_factory=HardwareNote)
    feedback_model: HardwareNote = Field(default_factory=HardwareNote)
    supply: HardwareNote = Field(default_factory=HardwareNote)
    wiring: HardwareNote = Field(default_factory=HardwareNote)
    docs: HardwareNote = Field(default_factory=HardwareNote)


class Intake(BaseModel):
    model_config = ConfigDict(extra='forbid')
    schema_version: Literal[1] = 1
    mode: Literal['simulation', 'hardware_notes'] | None = None
    intent: Literal['position', 'oscillate', 'threshold', 'other'] | None = None
    answers: IntakeAnswers = Field(default_factory=IntakeAnswers)
    hardware_notes: HardwareNotes = Field(default_factory=HardwareNotes)
    accepted_suggestions: list[str] = Field(default_factory=list, max_length=20)

    @field_validator('accepted_suggestions')
    @classmethod
    def suggestion_paths(cls, value):
        valid = {'answers.' + name for name in IntakeAnswers.model_fields}
        if len(set(value)) != len(value) or any(path not in valid for path in value):
            raise ValueError('建议值记录必须是已知且不重复的答案路径。')
        return value


DetailText = Annotated[str, Field(max_length=2000)]
DetailNumber = Annotated[float, Field(strict=True, allow_inf_nan=False)]


class DetailObject(BaseModel):
    model_config = ConfigDict(extra='forbid')


class MotionStep(DetailObject):
    id: DetailText
    kind: Literal['move', 'wait', 'condition', 'other']
    joint_name: DetailText | None = None
    target_rad: DetailNumber | None = None
    duration_s: DetailNumber | None = None
    condition: DetailText = ''
    timeout_s: DetailNumber | None = None
    on_failure: DetailText = ''
    description: DetailText = ''


def unique_row_ids(rows):
    ids = [row.id for row in rows]
    if any(not key.strip() for key in ids) or len(ids) != len(set(ids)):
        raise ValueError('每行需有不为空且不重复的标识。')
    return rows


class MotionDetails(DetailObject):
    pattern: Literal['from_answers', 'sequence', 'parallel'] | None = None
    completion: Literal['all', 'custom'] | None = None
    completion_note: DetailText = ''
    steps: list[MotionStep] = Field(default_factory=list, max_length=20)
    _unique = field_validator('steps')(unique_row_ids)


class SelectedDetails(DetailObject):
    selection: Literal['platform', 'custom'] | None = None


class LifecycleDetails(SelectedDetails):
    start: DetailText = ''
    finish: DetailText = ''
    cancel: DetailText = ''


class DeviceMappingEntry(DetailObject):
    id: DetailText
    structure_id: DetailText | None = None
    source_sha256: Annotated[str, Field(pattern=r'^[a-fA-F0-9]{64}$')] | None = None
    joint_name: DetailText | None = None
    device: DetailText = ''
    driver: DetailText = ''
    interface: DetailText = ''
    address: DetailText = ''
    wiring: DetailText = ''
    feedback: DetailText = ''
    source: DetailText = ''
    status: Literal['unknown', 'provided', 'documented'] = 'unknown'


class DeviceMappingDetails(DetailObject):
    scope: Literal['simulation_only', 'reference_only', 'required'] | None = None
    entries: list[DeviceMappingEntry] = Field(default_factory=list, max_length=20)
    _unique = field_validator('entries')(unique_row_ids)


class CoordinateDetails(SelectedDetails):
    zero: DetailText = ''
    direction: DetailText = ''
    command_unit: DetailText = ''
    feedback: DetailText = ''
    conversion: DetailText = ''
    source: DetailText = ''


class CommunicationDetails(SelectedDetails):
    transport: DetailText = ''
    ros_role: DetailText = ''
    esp_role: DetailText = ''
    message: DetailText = ''
    rate_hz: DetailNumber | None = None
    timeout_ms: DetailNumber | None = None


class FaultDetails(SelectedDetails):
    disconnect: DetailText = ''
    invalid_data: DetailText = ''
    limit_hit: DetailText = ''
    recovery: DetailText = ''


class AcceptanceCriterion(DetailObject):
    id: DetailText
    metric: DetailText = ''
    expected: DetailText = ''
    method: DetailText = ''


class AcceptanceDetails(SelectedDetails):
    criteria: list[AcceptanceCriterion] = Field(default_factory=list, max_length=20)
    _unique = field_validator('criteria')(unique_row_ids)


class EnvironmentDetails(SelectedDetails):
    mounting: DetailText = ''
    load_kg: DetailNumber | None = None
    obstacles: DetailText = ''
    space: DetailText = ''
    notes: DetailText = ''


class IntakeDetails(DetailObject):
    motion: MotionDetails = Field(default_factory=MotionDetails)
    lifecycle: LifecycleDetails = Field(default_factory=LifecycleDetails)
    device_mapping: DeviceMappingDetails = Field(default_factory=DeviceMappingDetails)
    coordinates: CoordinateDetails = Field(default_factory=CoordinateDetails)
    communication: CommunicationDetails = Field(default_factory=CommunicationDetails)
    faults: FaultDetails = Field(default_factory=FaultDetails)
    acceptance: AcceptanceDetails = Field(default_factory=AcceptanceDetails)
    environment: EnvironmentDetails = Field(default_factory=EnvironmentDetails)


RECOMMENDATION_PATHS = frozenset(('name', 'prd.use_case', 'prd.intake.intent', *(
    'prd.intake.answers.' + key for key in ('target_rad', 'tolerance_rad', 'max_velocity_rad_s', 'duration_s',
        'threshold', 'wave_start_rad', 'wave_end_rad', 'repetitions', 'dwell_s', 'end_behavior', 'end_position_rad'))))


class RecommendationBasis(DetailObject):
    request_text: str = Field(max_length=4000)
    intent: Literal['position', 'oscillate', 'threshold', 'other'] | None
    structure_id: DetailText | None
    joint_name: DetailText | None
    model_source_sha256: Annotated[str, Field(pattern=r'^[a-fA-F0-9]{64}$')] | None


class RecommendationRecord(DetailObject):
    path: str
    label: DetailText
    value: StrictInt | StrictFloat | StrictStr
    source: Literal['request', 'example']
    reason: DetailText
    section: Literal[1, 2, 3, 4, 5]
    unit: DetailText | None
    rule_version: Literal['prd-fill-v1']
    tool: Literal['平台规则推荐（非 AI）']
    basis: RecommendationBasis

    @model_validator(mode='after')
    def valid_record(self):
        if self.path not in RECOMMENDATION_PATHS:
            raise ValueError('推荐记录包含不允许自动填写的字段。')
        textual = self.path in ('name', 'prd.use_case', 'prd.intake.intent', 'prd.intake.answers.end_behavior')
        if textual != isinstance(self.value, str) or isinstance(self.value, bool):
            raise ValueError('推荐记录的值类型与字段不符。')
        if not textual and (not -1e12 <= self.value <= 1e12 or not math.isfinite(self.value)):
            raise ValueError('推荐记录必须使用有限数值。')
        if self.path.endswith('.repetitions') and type(self.value) is not int:
            raise ValueError('推荐次数必须是整数。')
        if textual and (not self.value.strip() or len(self.value) > (100 if self.path == 'name' else 500)):
            raise ValueError('推荐文字为空或过长。')
        if self.path == 'prd.intake.intent' and self.value not in ('position', 'oscillate', 'threshold', 'other'):
            raise ValueError('推荐动作类别不受支持。')
        if self.path.endswith('.end_behavior') and self.value not in ('return_start', 'hold_end', 'custom'):
            raise ValueError('推荐结束选项不受支持。')
        return self


class ActionJoint(DetailObject):
    name: str = Field(min_length=1, max_length=120)
    label: DetailText
    role: DetailText
    reason: DetailText


class ActionStage(DetailObject):
    id: str = Field(min_length=1, max_length=100)
    title: DetailText
    description: DetailText
    joint_names: list[str] = Field(max_length=20)
    repetitions: Annotated[int, Field(strict=True, ge=1, le=1000)] | None
    target_rad: DetailNumber | None
    confirmation_needed: bool

    @field_validator('joint_names')
    @classmethod
    def unique_joints(cls, value):
        if len(set(value)) != len(value) or any(not x.strip() or len(x) > 120 for x in value):
            raise ValueError('步骤的关节名称必须不重复且非空。')
        return value


class ActionDraft(DetailObject):
    schema_version: Literal[1] = 1
    structure_id: str | None = Field(max_length=100)
    model_source_sha256: Annotated[str, Field(pattern=r'^[a-fA-F0-9]{64}$')] | None
    summary: DetailText
    scope: Literal['single_joint', 'multi_joint', 'other', 'uncertain']
    reference_joint: str | None = Field(max_length=120)
    related_joints: list[ActionJoint] = Field(max_length=20)
    stages: list[ActionStage] = Field(max_length=20)
    end_pose_text: DetailText
    unresolved: list[DetailText] = Field(max_length=30)
    requires_review: Literal[True] = True

    @model_validator(mode='after')
    def unique_action_rows(self):
        names = [x.name for x in self.related_joints]
        ids = [x.id for x in self.stages]
        if len(names) != len(set(names)) or len(ids) != len(set(ids)):
            raise ValueError('完整动作中的关节和步骤标识不能重复。')
        return self


class AssistProvenance(DetailObject):
    tool: str = Field(max_length=200)
    model: str = Field(max_length=200)
    prompt: str = Field(max_length=120000)
    response: str = Field(max_length=120000)
    status: str = Field(max_length=100)
    invocation_id: str | None = Field(default=None, pattern=r'^[a-f0-9]{32}$')

    @model_serializer(mode='wrap')
    def omit_absent_invocation(self, handler):
        value = handler(self)
        if self.invocation_id is None:
            value.pop('invocation_id', None)
        return value


class AssistBasis(DetailObject):
    request_text: str = Field(max_length=4000)
    structure_id: str | None = Field(max_length=100)
    model_source_sha256: Annotated[str, Field(pattern=r'^[a-fA-F0-9]{64}$')] | None


ASSIST_PATHS = frozenset(('name', 'prd.use_case', 'prd.constraints', 'prd.acceptance',
    'prd.intake.intent', 'prd.intake.mode', 'prd.intake.action_draft', 'prd.intake.motion_plan',
    *('prd.intake.answers.' + key for key in IntakeAnswers.model_fields),
    *('prd.intake.details.' + key for key in IntakeDetails.model_fields)))


class AssistRecord(DetailObject):
    path: str
    label: DetailText
    value: Any
    source: Literal['request', 'model', 'platform', 'example', 'ai']
    reason: DetailText
    section: Literal[1, 2, 3, 4, 5]
    basis: AssistBasis
    invocation_id: str | None = Field(default=None, pattern=r'^[a-f0-9]{32}$')

    @model_serializer(mode='wrap')
    def omit_absent_invocation(self, handler):
        value = handler(self)
        if self.invocation_id is None:
            value.pop('invocation_id', None)
        return value

    @model_validator(mode='after')
    def typed_value(self):
        if self.path not in ASSIST_PATHS:
            raise ValueError('智能填写包含不允许修改的字段。')
        if self.path == 'prd.intake.action_draft':
            self.value = ActionDraft.model_validate(self.value).model_dump()
        elif self.path == 'prd.intake.motion_plan':
            self.value = MotionPlanV5.model_validate(self.value).model_dump()
        elif self.path.startswith('prd.intake.answers.'):
            key = self.path.rsplit('.', 1)[1]
            self.value = IntakeAnswers.model_validate({key: self.value}).model_dump()[key]
            if self.value is None:
                raise ValueError('推荐值不能是空值。')
        elif self.path.startswith('prd.intake.details.'):
            key = self.path.rsplit('.', 1)[1]
            self.value = IntakeDetails.model_validate({key: self.value}).model_dump()[key]
        elif self.path in ('prd.intake.intent', 'prd.intake.mode'):
            key = self.path.rsplit('.', 1)[1]
            self.value = Intake.model_validate({key: self.value}).model_dump()[key]
            if self.value is None:
                raise ValueError('推荐选项不能为空。')
        else:
            maximum = 100 if self.path == 'name' else 500 if self.path == 'prd.use_case' else 2000
            if not isinstance(self.value, str) or not self.value.strip() or len(self.value) > maximum:
                raise ValueError('推荐文字为空或过长。')
        return self


class RecommendationBundle(DetailObject):
    schema_version: Literal[1] = 1
    records: list[AssistRecord] = Field(max_length=50)
    provenance: AssistProvenance
    history: list[AssistProvenance] | None = Field(default=None, max_length=20)

    @model_serializer(mode='wrap')
    def omit_absent_history(self, handler):
        value = handler(self)
        if self.history is None:
            value.pop('history', None)
        return value

    @model_validator(mode='after')
    def unique_record_paths(self):
        if len({x.path for x in self.records}) != len(self.records):
            raise ValueError('智能填写记录中同一字段不能重复。')
        calls = {item.invocation_id for item in (self.history or []) + [self.provenance] if item.invocation_id}
        if any(item.invocation_id and item.invocation_id not in calls for item in self.records):
            raise ValueError('推荐字段的来源调用记录缺失，请保留对应工具和提示词。')
        return self


class MotionWaypointV5(DetailObject):
    positions: list[DetailNumber] = Field(min_length=1, max_length=12)
    time_from_start_s: DetailNumber
    stage_id: str = Field(min_length=1, max_length=80, pattern=r'^[A-Za-z0-9_-]+$')
    cycle_index: int = Field(strict=True, ge=0, le=1000)


class MotionPlanV5(DetailObject):
    schema_version: Literal[1] = 1
    recipe_id: str = Field(max_length=100)
    model_source_sha256: str = Field(pattern=r'^[a-f0-9]{64}$')
    reviewed: bool = False
    joint_names: list[str] = Field(min_length=1, max_length=12)
    waypoints: list[MotionWaypointV5] = Field(min_length=1, max_length=256)
    tolerance_rad: DetailNumber
    max_velocity_rad_s: DetailNumber
    max_acceleration_rad_s2: DetailNumber
    timeout_s: DetailNumber


class IntakeV2(Intake):
    schema_version: Literal[2] = 2
    details: IntakeDetails = Field(default_factory=IntakeDetails)
    recommendation_records: list[RecommendationRecord] | None = Field(default=None, max_length=20)
    action_draft: ActionDraft | None = None
    recommendation_bundle: RecommendationBundle | None = None
    motion_plan: MotionPlanV5 | None = None

    @field_validator('recommendation_records')
    @classmethod
    def unique_recommendations(cls, value):
        if value is not None and len({item.path for item in value}) != len(value):
            raise ValueError('同一字段只能保留一条采用的推荐记录。')
        return value

    @model_serializer(mode='wrap')
    def omit_absent_recommendations(self, handler):
        value = handler(self)
        for key in ('recommendation_records', 'action_draft', 'recommendation_bundle', 'motion_plan'):
            if getattr(self, key) is None:
                value.pop(key, None)
        return value


def parse_intake(value):
    if not isinstance(value, dict):
        raise ValueError('引导需求必须是对象。')
    version = value.get('schema_version', 1)
    if type(version) is not int or version not in (1, 2):
        raise ValueError('不支持这个需求版本。')
    return (IntakeV2 if version == 2 else Intake).model_validate(value)


class GuidedProductRequirements(ProductRequirements):
    intake: Intake | IntakeV2

    @field_validator('intake', mode='before')
    @classmethod
    def correct_intake_version(cls, value):
        return value if isinstance(value, (Intake, IntakeV2)) else parse_intake(value)


class GuidedDraftInput(BaseModel):
    """Loose draft envelope, with strictly typed intake and ignored old carriers."""
    model_config = ConfigDict(extra='forbid')
    name: str = Field(default='', max_length=100)
    request: str = Field(default='', max_length=4000)
    task_type: Literal['joint_position', 'sensor_threshold', 'joint_sequence'] | None = None
    parameters: dict[str, Any] | None = None
    hardware: dict[str, Any] | None = None
    prd: GuidedProductRequirements
    workflow: dict | None = None

    @field_validator('hardware')
    @classmethod
    def no_physical_execution(cls, value):
        if value and value.get('physical_io', False) is not False:
            raise ValueError('本轮只保存硬件资料，不允许启用实物输入输出。')
        return value


def parse_project_input(value):
    """Legacy strict contract stays unchanged when there is no intake."""
    if not isinstance(value, dict):
        raise ValueError('工程输入必须是对象。')
    prd = value.get('prd')
    if isinstance(prd, dict) and prd.get('intake') is not None:
        return GuidedDraftInput(**value)
    if isinstance(prd, dict) and 'intake' in prd:
        value = {**value, 'prd': {k: v for k, v in prd.items() if k != 'intake'}}
    return ProjectInput(**value)


class ApprovalInput(BaseModel):
    spec_revision: int
    plan_id: str = Field(min_length=1, max_length=100)


class DeployInput(BaseModel):
    confirm: Literal[True]
    fingerprint: str | None = Field(default=None, max_length=64)


class SettingsInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    provider: Literal['codex', 'openai']
    model: str = Field(default='', max_length=150)
    base_url: str = Field(default='https://api.openai.com/v1', max_length=500)
    api_key: str | None = Field(default=None, max_length=1000)


TASKS = [
    {'id': 'joint_position', 'label': '关节位置控制',
     'description': '让模拟关节转到目标角度，检查位置误差和失联处理。',
     'default_request': '让模拟关节转到 0.6 rad，误差不超过 0.04 rad，停止收到指令后停下。',
     'parameters': Parameters().model_dump()},
    {'id': 'sensor_threshold', 'label': '传感器触发',
     'description': '模拟传感器高于阈值时输出 1，低于阈值时输出 0。',
     'default_request': '读取模拟传感器，数值达到 0.5 时触发，低于 0.5 时解除，并回传状态。',
     'parameters': Parameters().model_dump()},
]
