"""PTY-only trusted bridge. No physical serial port is opened."""
import os
import re
import termios
import tty
import json
import time
import subprocess
import rclpy
from rclpy.node import Node
from std_msgs.msg import String
from .binding import load_binding,parse_bound_frame,frame,SerialLines

class SerialBridge(Node):
    def __init__(self):
        super().__init__('serial_bridge');self.binding=load_binding()
        self.declare_parameter('device_path','');self.declare_parameter('host_binary','')
        path=self.get_parameter('device_path').value;self.host=None;self.master=None
        if not path:
            import pty
            self.master,slave=pty.openpty();tty.setraw(slave);path=os.ttyname(slave)
            params=self.binding['parameters'];binary=self.get_parameter('host_binary').value
            self.host=subprocess.Popen([binary,str(self.master),self.binding['task_type'],str(params['threshold']),str(params['max_velocity'])],pass_fds=(self.master,),start_new_session=True)
            os.close(slave)
        if not re.fullmatch(r'/dev/pts/\d+',path): raise ValueError('only owned pseudo-terminal is allowed')
        self.fd=os.open(path,os.O_RDWR|os.O_NOCTTY|os.O_NONBLOCK);tty.setraw(self.fd,when=termios.TCSANOW)
        attributes=termios.tcgetattr(self.fd);attributes[4]=attributes[5]=termios.B115200;termios.tcsetattr(self.fd,termios.TCSANOW,attributes)
        self.lines=SerialLines(self.binding);self.pending=bytearray()
        self.state=self.create_publisher(String,'state',10);self.event=self.create_publisher(String,'event',10)
        self.create_subscription(String,'command',lambda m:self.send(m,'command'),10)
        if self.binding['task_type']=='joint_position': self.create_subscription(String,'bench_measurement',lambda m:self.send(m,'measurement'),10)
        self.create_timer(.005,self.poll)
    def error(self,error): self.event.publish(String(data=frame(self.binding,'event',-1,time.monotonic(),0,event='bridge_error',error=str(error))))
    def send(self,message,kind):
        try:
            parse_bound_frame(message.data,self.binding,kind)
            self.pending.extend((message.data+'\n').encode())
            if len(self.pending)>8192: self.pending.clear();raise ValueError('serial output queue overflow')
        except Exception as error: self.error(error)
    def poll(self):
        try:
            if self.pending:
                try: count=os.write(self.fd,self.pending);del self.pending[:count]
                except BlockingIOError: pass
            try: block=os.read(self.fd,4096)
            except BlockingIOError: return
            packets,errors=self.lines.feed(block)
            for error in errors: self.error(error)
            for data,packet in packets: (self.state if packet['kind']=='state' else self.event).publish(String(data=data))
        except Exception as error: self.error(error)
    def close(self):
        os.close(self.fd)
        if self.host:
            self.host.terminate()
            try: self.host.wait(timeout=2)
            except subprocess.TimeoutExpired: self.host.kill();self.host.wait(timeout=2)
        if self.master is not None: os.close(self.master)
def main():
    rclpy.init();node=SerialBridge()
    try: rclpy.spin(node)
    except KeyboardInterrupt: pass
    except Exception:
        if rclpy.ok(): raise
    finally: node.close();node.destroy_node();rclpy.try_shutdown()
