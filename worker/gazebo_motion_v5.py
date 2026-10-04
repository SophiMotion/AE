"""Bridge source coordinates to the same firmware core; apply only its output."""
import json
import math
from pathlib import Path
import time
import rclpy
from rclpy.node import Node
from std_msgs.msg import String, Float64
from sensor_msgs.msg import JointState

NUMERIC_EPS_RAD = 1e-6  # DART constraint solver boundary allowance (<0.00006 deg).


class GazeboMotion(Node):
    def __init__(self):
        super().__init__('gazebo_motion')
        self.binding = json.loads(Path(__file__).with_name('binding.json').read_text())
        self.names = self.binding['joint_names']; self.initial = self.binding['initial_positions']
        self.declare_parameter('pause_measurement', False)
        self.seq = 0; self.last_sample = -1.; self.last_state = None; self.last_core_seq = -1
        self.session = None; self.last_hardware_measurement = -1
        self.measurement = self.create_publisher(String, 'measurement', 10)
        self.audit = self.create_publisher(String, 'physics_audit', 100)
        self.hardware = self.create_publisher(JointState, 'hardware_state', 10)
        self.outputs = [self.create_publisher(Float64, 'velocity_' + str(i), 10) for i in range(len(self.names))]
        self.create_subscription(JointState, 'raw_joint_state', self.receive_raw, 10)
        self.create_subscription(String, 'event', self.receive_event, 20)
        self.create_subscription(String, 'state', self.receive_state, 20)
        self.create_timer(.02, self.watchdog)

    def record(self, **values):
        self.audit.publish(String(data=json.dumps(values, allow_nan=False, separators=(',', ':'))))

    def receive_event(self, message):
        packet = json.loads(message.data)
        if packet.get('event') == 'hello_ack':
            self.session = packet['session']

    def receive_raw(self, message):
        stamp = message.header.stamp.sec + message.header.stamp.nanosec * 1e-9
        if stamp - self.last_sample < .019: return
        self.last_sample = stamp
        try:
            indices = [next(i for i,n in enumerate(message.name) if n == name or n.endswith('::'+name)) for name in self.names]
            actual = [float(message.position[i]) + offset for i,offset in zip(indices,self.initial)]
            if not all(math.isfinite(v) and lim['lower']-NUMERIC_EPS_RAD <= v <= lim['upper']+NUMERIC_EPS_RAD for v,lim in zip(actual,self.binding['limits'])):
                violations=[(name,v,lim['lower'],lim['upper']) for name,v,lim in zip(self.names,actual,self.binding['limits']) if not math.isfinite(v) or not lim['lower']-NUMERIC_EPS_RAD<=v<=lim['upper']+NUMERIC_EPS_RAD]
                raise ValueError('Gazebo state outside bound source joint limits: '+repr(violations))
            values = [min(lim['upper'],max(lim['lower'],v)) for v,lim in zip(actual,self.binding['limits'])]
            self.record(kind='raw', time=stamp, positions=actual, normalized_positions=values, measurement_seq=self.seq,
                measurement_paused=self.get_parameter('pause_measurement').value)
            if self.get_parameter('pause_measurement').value: return
            self.measurement.publish(String(data=json.dumps({'seq':self.seq,'time':stamp,'positions':values},allow_nan=False)))
            self.seq += 1
        except Exception as error:
            self.record(kind='error', message=str(error))

    def receive_state(self, message):
        packet = json.loads(message.data)
        # The serial bridge only republishes its own handshake-validated core.
        # A late ROS subscriber can discover the session from this validated topic.
        if self.session is None: self.session = packet.get('session')
        if packet.get('session') != self.session or packet['seq'] <= self.last_core_seq: return
        self.last_core_seq = packet['seq']; self.last_state = time.monotonic()
        velocity = packet['velocities'] if packet['active'] else [0.] * len(self.names)
        if len(velocity) != len(self.names) or any(not math.isfinite(v) or abs(v)>self.binding['max_velocity_rad_s']+1e-6 for v in velocity):
            self.record(kind='error',message='invalid core actuator vector'); return
        for publisher,value in zip(self.outputs,velocity): publisher.publish(Float64(data=float(value)))
        self.record(kind='applied',time=packet['time'],core_seq=packet['seq'],velocities=velocity,active=packet['active'])
        if packet['measurement_fresh'] and packet['measurement_seq'] > self.last_hardware_measurement:
            state = JointState(); state.name = self.names; state.position = [float(v) for v in packet['positions']]
            state.header.frame_id = self.binding['identity']['model_sha256'] + ':' + self.binding['identity']['program_sha256']
            ns = round(packet['time']*1e9); state.header.stamp.sec = ns//1000000000; state.header.stamp.nanosec=ns%1000000000
            self.hardware.publish(state); self.last_hardware_measurement=packet['measurement_seq']

    def watchdog(self):
        if self.last_state is not None and time.monotonic()-self.last_state > .65:
            for publisher in self.outputs: publisher.publish(Float64(data=0.))
            self.record(kind='adapter_timeout'); self.last_state=None


def main():
    rclpy.init(); node=GazeboMotion()
    try: rclpy.spin(node)
    except KeyboardInterrupt: pass
    finally:
        if rclpy.ok():
            for publisher in node.outputs: publisher.publish(Float64(data=0.))
        node.destroy_node(); rclpy.try_shutdown()
