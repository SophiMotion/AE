"""Trusted ROS task. Task algorithm is the only generated Python component."""
import time
from pathlib import Path
import rclpy
from rclpy.node import Node
from std_msgs.msg import String
from .binding import load_binding,parse_bound_frame,frame
from .policy import load_compute

class Task(Node):
    def __init__(self):
        super().__init__('task_node')
        self.binding=load_binding();self.kind=self.binding['task_type']
        for key in ('target','threshold','max_velocity'): self.declare_parameter(key,float(self.binding['parameters'][key]))
        self.compute=load_compute(Path(__file__).with_name('logic.py').read_text())
        self.command=self.create_publisher(String,'command',10);self.events=self.create_publisher(String,'event',10)
        self.create_subscription(String,'state',self.receive,10)
        self.last_seq=-1;self.last_stamp=-1;self.last_received=None;self.create_timer(.05,self.watchdog)
    def event(self,name,value=0,**extra):
        self.events.publish(String(data=frame(self.binding,'event',self.last_seq,time.monotonic(),value,event=name,**extra)))
    def receive(self,message):
        try:
            data=parse_bound_frame(message.data,self.binding,'state')
            if data['seq']<=self.last_seq or data['time']<self.last_stamp: self.event('state_duplicate');return
            lo,hi=self.binding['value_bounds']
            if not lo-1e-6<=data['value']<=hi+1e-6: raise ValueError('state out of approved model bounds')
            value=self.compute(data['value'],self.get_parameter('target').value,self.get_parameter('threshold').value,self.get_parameter('max_velocity').value)
            limit=self.get_parameter('max_velocity').value
            if self.kind=='joint_position' and abs(value)>limit+1e-9: raise ValueError('velocity exceeds approved maximum')
            if self.kind=='sensor_threshold' and value not in (0,1): raise ValueError('digital command required')
            self.last_seq=data['seq'];self.last_stamp=data['time'];self.last_received=time.monotonic()
            self.command.publish(String(data=frame(self.binding,'command',data['seq'],data['time'],value)))
        except Exception as error: self.event('task_error',error=str(error))
    def watchdog(self):
        if self.last_received is not None and time.monotonic()-self.last_received>.6:
            self.last_received=None;self.last_seq+=1
            self.command.publish(String(data=frame(self.binding,'command',self.last_seq,time.monotonic(),0.0)));self.event('task_timeout')
def task_main():
    rclpy.init();node=Task()
    try: rclpy.spin(node)
    except KeyboardInterrupt: pass
    except Exception:
        if rclpy.ok(): raise
    finally: node.destroy_node();rclpy.try_shutdown()
