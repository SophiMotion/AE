"""ROS namespace-local vector bridge to an owned PTY, never physical serial."""
import json
import math
import os
from pathlib import Path
import re
import secrets
import subprocess
import termios
import time
import tty
import rclpy
from rclpy.node import Node
from std_msgs.msg import String
MAX_LINE_BYTES=2047


def wire_frame(frame):
    return json.dumps(frame,ensure_ascii=True,allow_nan=False,separators=(',',':'))


def hello_frame(binding,session):
    return dict(kind='hello',protocol_version=5,session=session,joint_names=binding['joint_names'],**{k:binding['identity'][k] for k in ('model_sha256','program_sha256','protocol_sha256')})


def validate_binding_v5(binding):
    names=binding['joint_names']
    if not 1<=len(names)<=16 or len(set(names))!=len(names) or any(not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,98}',n) for n in names):
        raise ValueError('invalid ordered joint binding')
    for key in ('model_sha256','program_sha256','protocol_sha256'):
        if not re.fullmatch('[0-9a-f]{64}',binding['identity'][key]): raise ValueError('invalid identity hash')
    if len(binding['initial_positions'])!=len(names) or len(binding['limits'])!=len(names): raise ValueError('incomplete joint binding')
    for value,limits in zip(binding['initial_positions'],binding['limits']):
        low,high=limits['lower'],limits['upper']
        if any(type(v) not in (int,float) or not math.isfinite(v) for v in (value,low,high)) or not low<=value<=high or low>=high: raise ValueError('invalid joint limits')
    for key in ('max_velocity_rad_s','max_acceleration_rad_s2','tolerance_rad'):
        value=binding[key]
        if type(value) not in (int,float) or not math.isfinite(value) or value<=0: raise ValueError('invalid servo limit')
    if binding.get('physical_io',False) is not False: raise ValueError('physical IO disabled')
    for key,fixed in (('watchdog_ms',600),('publish_hz',50),('baudrate',921600)):
        if binding.get(key,fixed)!=fixed: raise ValueError('fixed communication limit mismatch')
    return binding


def strict_json(text):
    def pairs(items):
        result = {}
        for key,value in items:
            if key in result: raise ValueError('duplicate JSON key')
            result[key] = value
        return result
    def constant(value): raise ValueError('nonfinite JSON value')
    value=json.loads(text,object_pairs_hook=pairs,parse_constant=constant)
    if not isinstance(value,dict): raise ValueError('JSON object required')
    return value


class SerialBridge(Node):
    def __init__(self):
        super().__init__('serial_bridge_v5')
        self.declare_parameter('binding_path','');self.declare_parameter('host_binary','');self.declare_parameter('device_path','')
        binding_path=self.get_parameter('binding_path').value or str(Path(__file__).with_name('binding.json'))
        self.binding=validate_binding_v5(json.loads(Path(binding_path).read_text(encoding='utf-8')))
        self.session=secrets.token_hex(16);self.master=None;self.host=None;self.fd=None
        self.pending=bytearray();self.buffer=bytearray();self.discard=False;self.bound=False
        self.last_state=-1;self.last_measurement=-1;self.last_rx=time.monotonic();self.last_hello=0
        self.state=self.create_publisher(String,'state',10);self.event=self.create_publisher(String,'event',10)
        path=self.get_parameter('device_path').value
        if path: raise ValueError('V5 bridge requires its own PTY; externally supplied ports are disabled')
        binary=Path(self.get_parameter('host_binary').value)
        if not binary.is_file(): raise ValueError('compiled V5 host_binary required')
        import pty
        try:
            self.master,slave=pty.openpty();tty.setraw(slave)
            self.fd=slave;os.set_blocking(slave,False)
            settings=termios.tcgetattr(slave);settings[4]=settings[5]=termios.B921600;termios.tcsetattr(slave,termios.TCSANOW,settings)
            self.host=subprocess.Popen([str(binary.resolve()),str(self.master)],pass_fds=(self.master,),start_new_session=True)
            self.queue(hello_frame(self.binding,self.session));self.last_hello=time.monotonic()
        except Exception:
            self.close();raise
        self.create_subscription(String,'command',lambda message:self.send(message,'command'),10)
        self.create_subscription(String,'measurement',lambda message:self.send(message,'measurement'),10)
        self.create_timer(.002,self.poll)

    def error(self,error):
        self.event.publish(String(data=wire_frame({'kind':'event','event':'bridge_error','reason':str(error),'session':self.session})))

    def queue(self,packet):
        line=(wire_frame(packet)+'\n').encode()
        if len(line)>MAX_LINE_BYTES+1: raise ValueError('serial line exceeds V5 budget')
        if len(self.pending)+len(line)>32768:
            self.pending.clear();raise ValueError('serial write queue overflow')
        self.pending.extend(line)

    def send(self,message,kind):
        try:
            if not self.bound: return
            packet=strict_json(message.data)
            allowed={'kind','session','seq','time','positions'}
            if set(packet)-allowed or not {'seq','time','positions'}<=set(packet): raise ValueError('unexpected input frame fields')
            if packet.get('kind',kind)!=kind or packet.get('session',self.session)!=self.session: raise ValueError('input stream/session mismatch')
            if type(packet['seq']) is not int or not 0<=packet['seq']<=2147483647: raise ValueError('invalid input sequence')
            stamp=packet['time']
            if isinstance(stamp,bool) or not isinstance(stamp,(float,int)) or not math.isfinite(stamp) or stamp<0: raise ValueError('invalid input simulation timestamp')
            positions=packet['positions']
            if not isinstance(positions,list) or len(positions)!=len(self.binding['joint_names']): raise ValueError('incomplete joint vector')
            if any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) for v in positions): raise ValueError('invalid position')
            self.queue(dict(packet,kind=kind,session=self.session))
        except Exception as error: self.error(error)

    def consume(self,line):
        packet=strict_json(line)
        if packet.get('session')!=self.session: raise ValueError('device session mismatch')
        if packet.get('kind')=='event':
            if packet.get('event')=='hello_ack': self.bound=True
            self.event.publish(String(data=wire_frame(packet)));return
        if packet.get('kind')!='state' or not self.bound: raise ValueError('unexpected device packet')
        seq=packet.get('seq');measurement=packet.get('measurement_seq')
        if type(seq) is not int or seq<=self.last_state or type(measurement) is not int or measurement<self.last_measurement: raise ValueError('device sequence replay')
        for key in ('positions','target_positions','velocities'):
            values=packet.get(key)
            if not isinstance(values,list) or len(values)!=len(self.binding['joint_names']) or any(type(v) not in (int,float) or not math.isfinite(v) for v in values): raise ValueError('invalid device vector')
        if any(type(packet.get(k)) is not bool for k in ('active','command_fresh','measurement_fresh')): raise ValueError('invalid freshness fields')
        if packet['active'] != (packet['command_fresh'] and packet['measurement_fresh']): raise ValueError('contradictory device state')
        if not packet['active'] and any(v!=0 for v in packet['velocities']): raise ValueError('inactive device emitted movement')
        self.last_state=seq;self.last_measurement=measurement;self.last_rx=time.monotonic()
        self.state.publish(String(data=wire_frame(packet)))

    def poll(self):
        try:
            if self.host.poll() is not None: raise RuntimeError('same-source firmware process exited')
            if not self.bound and time.monotonic()-self.last_hello>.5:
                self.queue(hello_frame(self.binding,self.session));self.last_hello=time.monotonic()
            if self.pending:
                try: count=os.write(self.fd,self.pending);del self.pending[:count]
                except BlockingIOError: pass
            try: block=os.read(self.fd,8192)
            except BlockingIOError: return
            for byte in block:
                if byte==10:
                    if self.discard: self.error('oversized/NUL device frame')
                    elif self.buffer:
                        try: self.consume(self.buffer.decode('ascii'))
                        except Exception as error: self.error(error)
                    self.buffer.clear();self.discard=False
                elif byte==0 or len(self.buffer)>=MAX_LINE_BYTES: self.discard=True
                elif not self.discard: self.buffer.append(byte)
        except Exception as error: self.error(error)

    def close(self):
        if self.host:
            self.host.terminate()
            try: self.host.wait(timeout=2)
            except subprocess.TimeoutExpired: self.host.kill();self.host.wait(timeout=2)
            self.host=None
        for key in ('fd','master'):
            fd=getattr(self,key,None)
            if fd is not None: os.close(fd);setattr(self,key,None)


def main():
    rclpy.init();node=SerialBridge()
    try: rclpy.spin(node)
    except KeyboardInterrupt: pass
    finally: node.close();node.destroy_node();rclpy.try_shutdown()
