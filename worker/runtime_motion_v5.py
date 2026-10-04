"""Execute the reviewed vector program through the actual ROS JTC action."""
import json
from pathlib import Path
import time
import rclpy
from rclpy.node import Node
from rclpy.action import ActionClient
from rclpy.clock import Clock,ClockType
from control_msgs.action import FollowJointTrajectory
from trajectory_msgs.msg import JointTrajectoryPoint
from builtin_interfaces.msg import Duration
from std_msgs.msg import String


class MotionTask(Node):
    def __init__(self):
        super().__init__('motion_task')
        self.program=json.loads(Path(__file__).with_name('program.json').read_text())
        self.binding=json.loads(Path(__file__).with_name('binding.json').read_text())
        self.events=self.create_publisher(String,'task_event',50)
        self.client=ActionClient(self,FollowJointTrajectory,'trajectory/follow_joint_trajectory')
        self.goal=None; self.future=None; self.result=None; self.ready=0; self.started=time.monotonic(); self.submitted=False
        self.declare_parameter('cancel_after_s',0.)
        self.create_subscription(String,'state',self.state,10)
        self.timer_clock=Clock(clock_type=ClockType.STEADY_TIME)
        self.create_timer(.05,self.tick,clock=self.timer_clock)

    def emit(self,event,**extra):
        self.events.publish(String(data=json.dumps({'event':event,'identity':self.binding['identity'],**extra},allow_nan=False)))

    def state(self,message):
        state=json.loads(message.data)
        if state['measurement_fresh']: self.ready+=1

    def tick(self):
        if getattr(self,'failed',False):return
        if not self.submitted:
            if time.monotonic()-self.started>45.:
                self.failed=True;self.emit('startup_timeout');return
            if self.ready<10 or not self.client.server_is_ready() or self.get_clock().now().nanoseconds==0: return
            goal=FollowJointTrajectory.Goal(); goal.trajectory.joint_names=self.program['joint_names']
            self.start_s=self.get_clock().now().nanoseconds*1e-9+.3
            ns=round(self.start_s*1e9); goal.trajectory.header.stamp.sec=ns//1000000000;goal.trajectory.header.stamp.nanosec=ns%1000000000
            rows=[{'positions':self.program['initial_positions'],'time_from_start_s':0.}]+self.program['waypoints']
            for row in rows:
                point=JointTrajectoryPoint();point.positions=[float(v) for v in row['positions']]
                point.velocities=[0.]*len(point.positions);point.accelerations=[0.]*len(point.positions)
                nanos=round(row['time_from_start_s']*1e9);point.time_from_start=Duration(sec=nanos//1000000000,nanosec=nanos%1000000000)
                goal.trajectory.points.append(point)
            goal.goal_time_tolerance=Duration(sec=2)
            self.emit('submitted',start_s=self.start_s)
            self.future=self.client.send_goal_async(goal);self.future.add_done_callback(self.accepted)
            self.submitted=True;self.sent_at=time.monotonic()
        elif self.result is None and not getattr(self,'timed_out',False) and (self.get_clock().now().nanoseconds*1e-9-self.start_s>=self.program['timeout_s'] or time.monotonic()-self.sent_at>self.program['timeout_s']*5+10):
            self.timed_out=True
            if self.goal:self.goal.cancel_goal_async()
            self.emit('timed_out',timeout_s=self.program['timeout_s'])
        elif self.goal and self.get_parameter('cancel_after_s').value>0 and not hasattr(self,'cancelled'):
            if self.get_clock().now().nanoseconds*1e-9-self.start_s>=self.get_parameter('cancel_after_s').value:
                self.cancelled=True;self.goal.cancel_goal_async();self.emit('cancel_requested')

    def accepted(self,future):
        self.goal=future.result()
        if not self.goal.accepted:
            self.emit('rejected');return
        self.emit('accepted');self.goal.get_result_async().add_done_callback(self.completed)
        if getattr(self,'timed_out',False):self.goal.cancel_goal_async()

    def completed(self,future):
        self.result=future.result()
        self.emit('completed',status=self.result.status,error_code=self.result.result.error_code,error_string=self.result.result.error_string)


def main():
    rclpy.init();node=MotionTask()
    try:rclpy.spin(node)
    except KeyboardInterrupt:pass
    finally:node.destroy_node();rclpy.try_shutdown()
