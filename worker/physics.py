"""Trusted Fortress world and ROS bridge adapter; measurements come from DART."""
WORLD = '''<?xml version="1.0"?>
<sdf version="1.8"><world name="ae_world">
<gravity>0 0 0</gravity>
<physics name="dart" type="dart"><max_step_size>0.001</max_step_size><real_time_factor>1</real_time_factor></physics>
<plugin filename="ignition-gazebo-physics-system" name="gz::sim::systems::Physics"><engine><filename>/usr/lib/x86_64-linux-gnu/ign-physics-5/engine-plugins/libignition-physics5-dartsim-plugin.so.5</filename></engine></plugin>
<plugin filename="ignition-gazebo-user-commands-system" name="gz::sim::systems::UserCommands"/>
<model name="ae_joint">
<link name="base"><inertial><mass>1</mass><inertia><ixx>0.1</ixx><iyy>0.1</iyy><izz>0.1</izz></inertia></inertial></link>
<link name="rotor"><inertial><mass>1</mass><inertia><ixx>0.1</ixx><iyy>0.1</iyy><izz>0.1</izz></inertia></inertial><collision name="rotor_collision"><geometry><box><size>0.4 0.05 0.05</size></box></geometry></collision></link>
<joint name="base_fixed" type="fixed"><parent>world</parent><child>base</child></joint>
<joint name="hinge" type="revolute"><parent>base</parent><child>rotor</child><axis><xyz>0 0 1</xyz><limit><lower>-3</lower><upper>3</upper><effort>100</effort><velocity>2</velocity></limit></axis></joint>
<plugin filename="ignition-gazebo-joint-controller-system" name="gz::sim::systems::JointController"><joint_name>hinge</joint_name><topic>__NAMESPACE__/velocity</topic></plugin>
<plugin filename="ignition-gazebo-joint-state-publisher-system" name="gz::sim::systems::JointStatePublisher"><joint_name>hinge</joint_name><topic>__NAMESPACE__/raw_joint_state</topic><update_rate>20</update_rate></plugin>
</model></world></sdf>
'''

ADAPTER = '''import json
import time
import rclpy
from rclpy.node import Node
from std_msgs.msg import String, Float64
from sensor_msgs.msg import JointState
from .policy import parse_frame, SequenceGate
from .contract import COMMUNICATION_DEFAULTS

class GazeboDevice(Node):
    def __init__(self):
        super().__init__('gazebo_device')
        self.declare_parameter('max_velocity', 0.8)
        self.limit=float(self.get_parameter('max_velocity').value)
        self.command_gate=SequenceGate()
        self.state_pub=self.create_publisher(String,'state',10)
        self.event_pub=self.create_publisher(String,'event',10)
        self.velocity_pub=self.create_publisher(Float64,'velocity',10)
        self.create_subscription(String,'command',self.receive_command,10)
        self.create_subscription(JointState,'raw_joint_state',self.receive_joint,10)
        self.started=time.monotonic()
        self.last_command=None
        self.last_sample=None
        self.applied=0.0
        self.seq=0
        self.create_timer(0.05,self.watchdog)

    def event(self,kind,**fields):
        self.event_pub.publish(String(data=json.dumps({'kind':kind,**fields})))

    def receive_command(self,message):
        try:
            frame=parse_frame(message.data)
            if abs(frame['value'])>self.limit+1e-9: raise ValueError('command exceeds approved velocity')
            if not self.command_gate.accept(frame['seq']):
                self.event('command_duplicate',seq=frame['seq'],held_value=self.applied)
                return
            self.applied=frame['value']
            self.last_command=time.monotonic()
            self.velocity_pub.publish(Float64(data=self.applied))
            self.event('command_applied',seq=frame['seq'],value=self.applied)
        except Exception as error:
            self.event('device_error',error=str(error))

    def receive_joint(self,message):
        try:
            index=next(i for i,name in enumerate(message.name) if name=='hinge' or name.endswith('::hinge'))
            value=float(message.position[index])
            now=time.monotonic()
            if self.last_sample is not None and now-self.last_sample<1.0/COMMUNICATION_DEFAULTS['state_frequency_hz']: return
            frame=parse_frame(json.dumps({'seq':self.seq,'time':now-self.started,'value':value,'applied':self.applied}))
            if abs(value)>3.001: raise ValueError('Gazebo joint beyond position limit')
            self.state_pub.publish(String(data=json.dumps(frame)))
            self.last_sample=now
            self.seq+=1
        except Exception as error:
            self.event('device_error',error=str(error))

    def watchdog(self):
        if self.last_command is not None and time.monotonic()-self.last_command>COMMUNICATION_DEFAULTS['watchdog_seconds']:
            self.applied=0.0
            self.last_command=None
            self.velocity_pub.publish(Float64(data=0.0))
            self.event('device_timeout',value=0.0)

def main():
    rclpy.init()
    node=GazeboDevice()
    try: rclpy.spin(node)
    except KeyboardInterrupt: pass
    except Exception:
        if rclpy.ok(): raise
    finally:
        node.velocity_pub.publish(Float64(data=0.0)) if rclpy.ok() else None
        node.destroy_node()
        if rclpy.ok(): rclpy.shutdown()
'''


def available():
    from pathlib import Path
    import shutil
    return bool(shutil.which("ign") and Path("/opt/ros/humble/lib/ros_gz_bridge/parameter_bridge").is_file())
