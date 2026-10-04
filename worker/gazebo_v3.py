"""Only firmware command-applied events drive Gazebo; raw states feed bench."""
import time
import rclpy
from rclpy.node import Node
from std_msgs.msg import String,Float64
from sensor_msgs.msg import JointState
from .binding import load_binding,parse_bound_frame,frame

class GazeboBench(Node):
    def __init__(self):
        super().__init__('gazebo_device');self.binding=load_binding();self.offset=self.binding['initial_position']
        self.started=time.monotonic();self.last_sample=None;self.last_event=None;self.last_seq=-1;self.seq=0
        self.measurement=self.create_publisher(String,'bench_measurement',10);self.event=self.create_publisher(String,'event',10);self.velocity=self.create_publisher(Float64,'velocity',10)
        self.create_subscription(JointState,'raw_joint_state',self.receive_joint,10)
        self.create_subscription(String,'event',self.receive_event,10);self.create_timer(.05,self.watchdog)
    def error(self,error): self.event.publish(String(data=frame(self.binding,'event',self.last_seq,time.monotonic(),0,event='device_error',error=str(error))))
    def receive_joint(self,message):
        try:
            name=self.binding['identity']['joint_name'];index=next(i for i,n in enumerate(message.name) if n==name or n.endswith('::'+name))
            now=time.monotonic()
            if self.last_sample is not None and now-self.last_sample<.049: return
            value=float(message.position[index])+self.offset;lo,hi=self.binding['value_bounds']
            if not lo-1e-5<=value<=hi+1e-5: raise ValueError('Gazebo selected joint exceeds source limits')
            self.measurement.publish(String(data=frame(self.binding,'measurement',self.seq,now-self.started,value)));self.seq+=1;self.last_sample=now
        except Exception as error: self.error(error)
    def receive_event(self,message):
        try:
            packet=parse_bound_frame(message.data,self.binding,'event');event=packet.get('event')
            if event not in ('command_applied','device_timeout','measurement_timeout','device_logic_error'): return
            value=packet['value']
            if abs(value)>self.binding['parameters']['max_velocity']+1e-9: raise ValueError('firmware applied velocity exceeds bound')
            if event=='command_applied':
                if packet['seq']<=self.last_seq: return
                self.last_seq=packet['seq']
            else: value=0.0
            self.velocity.publish(Float64(data=float(value)));self.last_event=time.monotonic()
        except Exception as error: self.error(error)
    def watchdog(self):
        # Trusted transport safety fallback, never a normal bypass of core.
        if self.last_event is not None and time.monotonic()-self.last_event>.65:
            self.velocity.publish(Float64(data=0.0));self.last_event=None
            self.event.publish(String(data=frame(self.binding,'event',self.last_seq,time.monotonic(),0,event='adapter_timeout')))
def main():
    rclpy.init();node=GazeboBench()
    try: rclpy.spin(node)
    except KeyboardInterrupt: pass
    except Exception:
        if rclpy.ok(): raise
    finally:
        if rclpy.ok(): node.velocity.publish(Float64(data=0.0))
        node.destroy_node();rclpy.try_shutdown()
