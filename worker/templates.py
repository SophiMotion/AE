"""Trusted ROS/ESP32 scaffolding. The model owns logic.py only."""
import json
from pathlib import Path
import shutil
import uuid
from .contract import COMMUNICATION_DEFAULTS, SIMULATION_DEFAULTS

RUNTIME = '''import json
import math
import time
import rclpy
from rclpy.node import Node
from std_msgs.msg import String
from .policy import load_compute, parse_frame, SequenceGate
from .contract import COMMUNICATION_DEFAULTS, SIMULATION_DEFAULTS
from pathlib import Path

class TaskNode(Node):
    def __init__(self):
        super().__init__('task', enable_rosout=False)
        for name, value in [('task_type','joint_position'), ('target',0.6), ('threshold',0.5), ('max_velocity',0.8), ('timeout',COMMUNICATION_DEFAULTS['watchdog_seconds'])]:
            self.declare_parameter(name,value)
        self.kind = self.get_parameter('task_type').value
        self.compute = load_compute(Path(__file__).with_name('logic.py').read_text())
        self.command = self.create_publisher(String,'command',10)
        self.event = self.create_publisher(String,'event',10)
        self.create_subscription(String,'state',self.on_state,10)
        self.gate = SequenceGate()
        self.last_state = None
        self.last_seq = -1
        self.expired = False
        self.create_timer(0.05,self.watchdog)
    def publish_event(self,kind,**fields):
        self.event.publish(String(data=json.dumps(dict(kind=kind,**fields),allow_nan=False)))
    def on_state(self,msg):
        try:
            frame = parse_frame(msg.data)
            if not self.gate.accept(frame['seq']):
                self.publish_event('state_duplicate',seq=frame['seq'])
                return
            if self.kind == 'sensor_threshold' and not 0 <= frame['value'] <= 1:
                raise ValueError('sensor value outside normalized range')
            if self.kind == 'joint_position' and abs(frame['value']) > 3:
                raise ValueError('joint value outside software range')
            self.last_state = time.monotonic()
            self.last_seq = frame['seq']
            self.expired = False
            value = self.compute(frame['value'],self.get_parameter('target').value,self.get_parameter('threshold').value,self.get_parameter('max_velocity').value)
            if self.kind == 'joint_position' and abs(value) > self.get_parameter('max_velocity').value + 1e-9:
                raise ValueError('velocity exceeds approved bound')
            if self.kind == 'sensor_threshold' and value not in (0.0,1.0):
                raise ValueError('sensor command must be 0 or 1')
            self.command.publish(String(data=json.dumps(dict(seq=frame['seq'],time=frame['time'],value=value),allow_nan=False)))
        except Exception as error:
            self.publish_event('task_error',detail=str(error))
    def watchdog(self):
        if self.last_state is not None and time.monotonic() - self.last_state > self.get_parameter('timeout').value and not self.expired:
            self.expired = True
            self.command.publish(String(data=json.dumps(dict(seq=self.last_seq+1,time=time.monotonic(),value=0.0))))
            self.publish_event('task_timeout',value=0.0)

class SimDevice(Node):
    def __init__(self):
        super().__init__('sim_device',enable_rosout=False)
        for name,value in [('task_type','joint_position'), ('initial_value',SIMULATION_DEFAULTS['initial_joint_position_rad']), ('threshold',0.5), ('max_velocity',0.8), ('timeout',COMMUNICATION_DEFAULTS['watchdog_seconds'])]:
            self.declare_parameter(name,value)
        self.kind=self.get_parameter('task_type').value
        self.position=self.get_parameter('initial_value').value
        self.velocity=0.0
        self.seq=0
        self.started=time.monotonic()
        self.previous=self.started
        self.last_command=None
        self.expired=False
        self.gate=SequenceGate()
        self.state=self.create_publisher(String,'state',10)
        self.event=self.create_publisher(String,'event',10)
        self.create_subscription(String,'command',self.on_command,10)
        self.create_timer(1.0/COMMUNICATION_DEFAULTS['state_frequency_hz'],self.tick)
    def publish_event(self,kind,**fields):
        self.event.publish(String(data=json.dumps(dict(kind=kind,**fields),allow_nan=False)))
    def on_command(self,msg):
        try:
            frame=parse_frame(msg.data)
            if self.kind == 'joint_position' and abs(frame['value']) > self.get_parameter('max_velocity').value+1e-9:
                raise ValueError('device velocity bound')
            if self.kind == 'sensor_threshold' and frame['value'] not in (0.0,1.0):
                raise ValueError('device digital bound')
            if not self.gate.accept(frame['seq']):
                self.publish_event('command_duplicate',seq=frame['seq'],held_value=self.velocity)
                return
            self.velocity=frame['value']
            self.last_command=time.monotonic()
            self.expired=False
            self.publish_event('command_applied',seq=frame['seq'],value=frame['value'])
        except Exception as error:
            self.publish_event('device_error',detail=str(error))
    def tick(self):
        now=time.monotonic()
        dt=min(now-self.previous,SIMULATION_DEFAULTS['max_integrated_dt_seconds'])
        self.previous=now
        if self.last_command is not None and now-self.last_command > self.get_parameter('timeout').value and not self.expired:
            self.velocity=0.0
            self.expired=True
            self.publish_event('device_timeout',value=0.0)
        if self.kind=='joint_position':
            self.position=max(-3.0,min(3.0,self.position+self.velocity*dt))
            value=self.position
        else:
            threshold=self.get_parameter('threshold').value
            samples=[0.0,max(0.0,threshold-0.05),threshold,min(1.0,threshold+0.05),1.0,0.0]
            value=samples[(self.seq//5)%len(samples)]
        self.state.publish(String(data=json.dumps(dict(seq=self.seq,time=now-self.started,value=value,applied=self.velocity),allow_nan=False)))
        self.seq+=1

def run(node_class):
    rclpy.init()
    node=node_class()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    except Exception:
        if rclpy.ok():
            raise
    finally:
        node.destroy_node()
        rclpy.try_shutdown()

def task_main():
    run(TaskNode)

def device_main():
    run(SimDevice)
'''

LAUNCH = '''from launch import LaunchDescription
from launch_ros.actions import Node
from ament_index_python.packages import get_package_share_directory
from pathlib import Path

def generate_launch_description():
    config=str(Path(get_package_share_directory('ae_generated'))/'config'/'parameters.yaml')
    return LaunchDescription([
        Node(package='ae_generated',executable='sim_device',namespace='ae_demo',parameters=[config]),
        Node(package='ae_generated',executable='task_node',namespace='ae_demo',parameters=[config]),
    ])
'''

PHYSICS_LAUNCH = '''from launch import LaunchDescription
from launch.actions import ExecuteProcess
from launch_ros.actions import Node
from launch_ros.substitutions import FindPackageShare
from launch.substitutions import PathJoinSubstitution
def generate_launch_description():
    config=PathJoinSubstitution([FindPackageShare('ae_generated'),'config','parameters.yaml'])
    world=PathJoinSubstitution([FindPackageShare('ae_generated'),'config','joint.sdf'])
    partition='__NAMESPACE__'
    return LaunchDescription([
        ExecuteProcess(cmd=['ign','gazebo','-s','-r',world],additional_env={'IGN_PARTITION':partition,'GZ_PARTITION':partition},output='screen'),
        Node(package='ros_gz_bridge',executable='parameter_bridge',arguments=['/__NAMESPACE__/velocity@std_msgs/msg/Float64]ignition.msgs.Double','/__NAMESPACE__/raw_joint_state@sensor_msgs/msg/JointState[ignition.msgs.Model'],additional_env={'IGN_PARTITION':partition,'GZ_PARTITION':partition},output='screen'),
        Node(package='ae_generated',executable='gazebo_device',namespace=partition,parameters=[config]),
        Node(package='ae_generated',executable='task_node',namespace=partition,parameters=[config]),
    ])
'''

FIRMWARE = '''// ESP32 reference ONLY: no board/pins selected, not compiled/flashed.
// Requires ArduinoJson 7.x. JSONL transport demo; no actuator is connected.
#include <Arduino.h>
#include <ArduinoJson.h>
#include <math.h>
static long lastSeq=-1;
static uint32_t lastCommandMs=0;
static float lastCommand=0;
static char line[256];
static size_t used=0;
static bool overflow=false;
static const float MAX_VELOCITY=__MAX_VELOCITY__f;
// Hardware implementation must replace these two functions after pin review.
float readMeasuredValue() { return NAN; }
void applyCommand(float command) { (void)command; /* deliberately no actuation */ }
void receiveLine() {
  JsonDocument packet;
  if (deserializeJson(packet,line) || !packet["seq"].is<long>() || !packet["value"].is<float>() || !packet["time"].is<float>()) return;
  long seq=packet["seq"];
  float value=packet["value"];
  float stamp=packet["time"];
  if(seq<=lastSeq || seq<0 || !isfinite(value) || !isfinite(stamp) || stamp<0) return;
  if (__BOUND_CHECK__) return;
  lastSeq=seq; lastCommand=value; lastCommandMs=millis(); applyCommand(value);
}
void setup() { Serial.begin(115200); }
void loop() {
  while(Serial.available()) {
    char c=(char)Serial.read();
    if(c=='\\n') { if(!overflow) {line[used]='\\0';receiveLine();} used=0;overflow=false; }
    else if(used<sizeof(line)-1 && !overflow) line[used++]=c;
    else overflow=true;
  }
  if(lastCommandMs && millis()-lastCommandMs>600) {applyCommand(0);lastCommand=0;lastCommandMs=0;}
  // No invented sensor readings: NAN blocks state output until hardware exists.
  float measured=readMeasuredValue();
  if(isfinite(measured)) { /* serialize seq/time/value using a measured sensor */ }
}
'''


def generate(output, spec, code, firmware_code=None):
    package = output / "ros_ws" / "src" / "ae_generated"
    module = package / "ae_generated"
    for directory in (module, package / "resource", package / "launch", package / "config", output / "esp32"):
        directory.mkdir(parents=True, exist_ok=True)
    (module / "__init__.py").write_text("", encoding="utf-8")
    (module / "runtime.py").write_text(RUNTIME, encoding="utf-8")
    (module / "logic.py").write_text(code, encoding="utf-8")
    shutil.copyfile(Path(__file__).with_name('serial_bridge.py'),module/'serial_bridge.py')
    from .physics import ADAPTER, WORLD
    exported_namespace = 'ae_' + uuid.uuid4().hex[:16]
    (module / "gazebo_device.py").write_text(ADAPTER, encoding="utf-8")
    (package / "config" / "joint.sdf").write_text(WORLD.replace("__NAMESPACE__", "/"+exported_namespace), encoding="utf-8")
    shutil.copyfile(Path(__file__).with_name("policy.py"), module / "policy.py")
    shutil.copyfile(Path(__file__).with_name("contract.py"), module / "contract.py")
    (package / "resource" / "ae_generated").write_text("", encoding="utf-8")
    (package / "setup.py").write_text('''from setuptools import setup
from glob import glob
setup(name='ae_generated',version='0.1.0',packages=['ae_generated'],
    data_files=[('share/ament_index/resource_index/packages',['resource/ae_generated']),
                ('share/ae_generated',['package.xml']),
                ('share/ae_generated/launch',glob('launch/*.py')),
                ('share/ae_generated/config',glob('config/*'))],
    install_requires=['setuptools'],zip_safe=True,
    maintainer='AE Local',maintainer_email='local@example.invalid',
    description='Generated bounded task and simulated device',license='MIT',
    entry_points={'console_scripts':['task_node=ae_generated.runtime:task_main','sim_device=ae_generated.runtime:device_main','gazebo_device=ae_generated.gazebo_device:main','serial_bridge=ae_generated.serial_bridge:main']})
''', encoding="utf-8")
    (package / "setup.cfg").write_text("[develop]\nscript_dir=$base/lib/ae_generated\n[install]\ninstall_scripts=$base/lib/ae_generated\n", encoding="utf-8")
    (package / "package.xml").write_text('''<?xml version="1.0"?><package format="3">
<name>ae_generated</name><version>0.1.0</version><description>AE generated task</description>
<maintainer email="local@example.invalid">AE Local</maintainer><license>MIT</license>
<buildtool_depend>ament_python</buildtool_depend><exec_depend>rclpy</exec_depend>
<exec_depend>std_msgs</exec_depend><exec_depend>sensor_msgs</exec_depend><exec_depend>launch</exec_depend><exec_depend>launch_ros</exec_depend>
<export><build_type>ament_python</build_type></export></package>
''', encoding="utf-8")
    (package / "launch" / "simulation.launch.py").write_text(LAUNCH.replace("ae_demo", exported_namespace), encoding="utf-8")
    if spec['task_type'] == 'joint_position':
        (package / 'launch' / 'physics.launch.py').write_text(PHYSICS_LAUNCH.replace('__NAMESPACE__', exported_namespace), encoding='utf-8')
    parameters = spec["parameters"]
    config = "/**:\n  ros__parameters:\n    task_type: " + spec["task_type"] + "\n"
    config += "".join(f"    {key}: {float(value)}\n" for key, value in parameters.items() if key in ("target", "threshold", "max_velocity"))
    config += f"    initial_value: {SIMULATION_DEFAULTS['initial_joint_position_rad']}\n    timeout: {COMMUNICATION_DEFAULTS['watchdog_seconds']}\n"
    (package / "config" / "parameters.yaml").write_text(config, encoding="utf-8")
    (package / "README.md").write_text("# Independent ROS 2 Humble workspace\n\nsource /opt/ros/humble/setup.bash\n\ncolcon build --merge-install\n\nsource install/setup.bash\n\nROS_DOMAIN_ID=78 ROS_LOCALHOST_ONLY=1 ros2 launch ae_generated simulation.launch.py\n\nThis launch starts separate task and numerical simulated-device processes. It is not physical Gazebo or an ESP32. logic.py is AST-validated by trusted policy.py. JSONL String state/command uses monotonic seq, time(seconds), value(rad/rad/s or normalized/digital). Timeout 0.6s sends/applies zero; duplicates are rejected. Read communication.json and result.json for actual test evidence.\n", encoding="utf-8")
    if spec['task_type'] == 'joint_position':
        with (package/'README.md').open('a',encoding='utf-8') as stream:
            stream.write('\nWith Gazebo Fortress and ros-humble-ros-gz-bridge installed: ROS_DOMAIN_ID=78 ROS_LOCALHOST_ONLY=1 ros2 launch ae_generated physics.launch.py\n\nThis headless DART world has one revolute joint with an ideal velocity servo, zero gravity and no real actuator fit. JointStatePublisher measurements cross the ROS bridge; the adapter does not integrate position. Physics and numerical launches are alternatives; launch only one at a time. Result engine and physics_simulation_verified identify the actual acceptance engine. physical_verified remains false because no hardware was tested.\n')
    bound = "fabsf(value)>MAX_VELOCITY" if spec["task_type"] == "joint_position" else "(value!=0.0f && value!=1.0f)"
    firmware = FIRMWARE.replace("__MAX_VELOCITY__", str(float(parameters["max_velocity"]))).replace("__BOUND_CHECK__", bound)
    firmware_target=spec.get('hardware',{}).get('board') in ('esp32','esp32s3')
    if not firmware_target:
        (output / "esp32" / "ae_reference.ino").write_text(firmware, encoding="utf-8")
        (output / "esp32" / "README.md").write_text("# ESP32 reference only\n\nBoard model, GPIO, encoder/sensor, driver and physical transport are not supplied. No board compilation, flashing or actuation has been performed. ArduinoJson 7.x is a reference dependency, not installed or verified here. Replace measured-value and apply-command placeholders only after real hardware review. ROS uses std_msgs/String topic JSON; Serial JSONL is only a framing reference and needs a host serial adapter. This .ino has no fake sensor or motion implementation. Firmware bounds, sequence rejection and 600ms watchdog mirror communication.json.\n", encoding="utf-8")
    communication = {
        **COMMUNICATION_DEFAULTS,
        "schema_version": 1, "task_type": spec["task_type"], "ros_distro": "humble",
        "ros_domain_id": 78, "localhost_only": True, "namespace": "isolated per case",
        "state": {"topic": "state", "ros_type": "std_msgs/msg/String", "fields": {"seq": "nonnegative int", "time": "finite monotonic elapsed seconds", "value": "position rad or normalized sensor [0,1]"}},
        "command": {"topic": "command", "ros_type": "std_msgs/msg/String", "fields": {"seq": "matching state sequence", "time": "state time", "value": "bounded velocity rad/s or digital 0/1"}},
        "max_velocity": parameters["max_velocity"], "watchdog_seconds": 0.6,
        "duplicates": "strictly increasing seq; reject seq <= last accepted; do not reapply",
        "esp32": {"status": "pending_compile_and_host_protocol_test" if firmware_target else "reference_only_not_compiled_not_flashed", "board": spec.get("hardware", {}).get("board", "unspecified"), "transport": "serial_jsonl_115200" if firmware_target else "reference_only", "validation_scope": "host_protocol_core_pty_ros" if firmware_target else "reference_only", "board_compiled": False, "flashed": False, "esp32_execution_verified": False, "physical_verified": False, "actual_evidence": "result.json firmware and communication_test"},
        "simulation": SIMULATION_DEFAULTS,
        "exported_launch_namespace": exported_namespace,
    }
    (output / "communication.json").write_text(json.dumps(communication, ensure_ascii=False, indent=2), encoding="utf-8")
    if firmware_target:
        from .firmware import generate_firmware
        generate_firmware(output,spec,firmware_code=firmware_code)
    return package
