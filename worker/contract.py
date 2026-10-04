"""Single source of protocol and simulator defaults used before approval."""
COMMUNICATION_DEFAULTS = {
    "schema_version": 1,
    "ros_distro": "humble",
    "ros_domain_id": 78,
    "localhost_only": True,
    "namespace": "isolated per run/case; topics below are relative",
    "state_topic": "state",
    "command_topic": "command",
    "event_topic": "event",
    "ros_message_type": "std_msgs/msg/String",
    "encoding": "JSON object inside ROS String; JSONL framing only for ESP32 reference",
    "required_fields": {"seq": "integer 0..2147483647", "time": "finite nonnegative seconds", "value": "finite number"},
    "joint_state_unit": "rad",
    "joint_command_unit": "rad/s; abs(value)<=approved max_velocity",
    "sensor_state_unit": "normalized [0,1]",
    "sensor_command_unit": "digital 0.0 or 1.0; >=threshold means 1.0",
    "state_frequency_hz": 20.0,
    "command_frequency": "one command per accepted state frame (nominal 20 Hz)",
    "watchdog_seconds": 0.6,
    "watchdog_behavior": "task sends zero once after state silence; simulated device applies zero after command silence",
    "sequence_rule": "strictly increasing seq; reject duplicate/older command without reapplying",
    "timestamp_rule": "state producer monotonic elapsed seconds; normal command echoes state time; watchdog uses local monotonic time",
    "esp32_transport": "serial 115200 JSONL; native shared-core PTY plus real ROS bridge test; no physical board execution",
    "serial_line_max_bytes": 511,
    "serial_state_fields": "kind=state,seq,time,value,applied,applied_seq",
    "serial_event_fields": "kind=event,event,seq,time,value,reason",
    "firmware_core_version": "3.3.12",
    "firmware_arduinojson_version": "7.4.3",
    "esp32_execution_verified": False,
    "qos": {"depth": 10, "reliability": "reliable", "durability": "volatile"},
}

SIMULATION_DEFAULTS = {
    "initial_joint_position_rad": 0.0,
    "joint_position_limit_rad": [-3.0, 3.0],
    "numeric_timestep_seconds": 0.05,
    "max_integrated_dt_seconds": 0.1,
    "sensor_sequence": "0, max(0,threshold-0.05), threshold, min(1,threshold+0.05), 1, 0; each holds 5 frames",
    "startup_timeout_seconds": 8.0,
    "duration_semantics": "requested observation duration starts after required ROS endpoints are discovered; startup/build/additional fixed cases are separate",
    "additional_cases": ["alternate target/threshold", "already at target (joint)", "state silence watchdog", "duplicate and malformed command rejection", "device silence watchdog"],
    "physics_engine": "Gazebo Fortress/DART when actually available and joint test succeeds; numerical integration otherwise, explicitly labeled",
    "sensor_engine": "numeric/protocol simulator; no physical sensor model",
    "hardware_verified": False,
    "esp32_board_compiled": False,
    "esp32_flashed": False,
    "communication_test_scope": "host_protocol_core_pty_ros; host executable is not an ESP32 emulator",
}


def project_contract(project_or_spec=None):
    import copy
    import hashlib
    import json
    communication=copy.deepcopy(COMMUNICATION_DEFAULTS)
    simulation=copy.deepcopy(SIMULATION_DEFAULTS)
    spec=project_or_spec or {}
    model=spec.get('execution_model')
    if spec.get('pipeline_version')==3 and spec.get('task_type')=='sensor_threshold':
        scalar={'schema_version':1,'sensor_engine':'fixed software scalar pattern 20Hz; not physical sensor','structure':spec.get('structure') or {}}
        model={'selected_joint':'scalar_channel','joints':[],'model_sha256':hashlib.sha256(json.dumps(scalar,sort_keys=True,ensure_ascii=False,separators=(',',':'),allow_nan=False).encode()).hexdigest()}
    if model:
        selected=model.get('selected_joint')
        joint=next((item for item in model['joints'] if item['name']==selected),None)
        if spec.get('task_type','joint_position')=='joint_position' and (not joint or joint['type']!='revolute'):
            raise ValueError('V3 joint_position requires an explicitly selected bounded revolute joint')
        identity={'joint_name':selected if joint else 'scalar_channel','model_sha256':model['model_sha256']}
        communication.update(schema_version=2,encoding='strict JSON objects in ROS String; identical JSONL over PTY / ESP bench UART',identity=identity,
            required_fields={'kind':'command/measurement/state/event','seq':'integer 0..2147483647 for state/command/measurement; event may use -1 before any valid command is accepted','time':'finite nonnegative seconds','value':'finite number','joint_name':'exact approved identity','model_sha256':'exact approved 64 hex hash','protocol_sha256':'exact approved 64 hex hash'},
            bench_measurement_topic='bench_measurement',measurement_source='Gazebo Fortress/DART selected joint; software bench input only' if joint and spec.get('task_type','joint_position')=='joint_position' else 'explicit scalar pattern software bench; selected model is structure context only',
            serial_state_fields='kind=state,seq,time,value,applied,applied_seq,joint_name,model_sha256,protocol_sha256; applied_seq=-1 means no command applied yet',
            serial_event_fields='kind=event,event,seq,time,value,reason,joint_name,model_sha256,protocol_sha256')
        protocol=hashlib.sha256(json.dumps(communication,sort_keys=True,ensure_ascii=False,separators=(',',':'),allow_nan=False).encode()).hexdigest()
        identity['protocol_sha256']=protocol
        communication['protocol_sha256']=protocol
        if joint and spec.get('task_type','joint_position')=='joint_position':
            simulation.update(initial_joint_position_rad=joint['initial_position'],joint_position_limit_rad=[joint['limits']['lower'],joint['limits']['upper']],
                joint_position_offset_rad=joint['initial_position'],selected_joint=selected,model_sha256=model['model_sha256'],
                physics_engine='Gazebo Fortress/DART execution_model selected joint in one ROS/PTY/native-firmware feedback loop; mandatory',
                held_positions=copy.deepcopy(model.get('held_positions',{})),assumptions=copy.deepcopy(model['assumptions']))
        simulation['identity']=copy.deepcopy(identity)
    return {'communication':communication,'simulation':simulation}
