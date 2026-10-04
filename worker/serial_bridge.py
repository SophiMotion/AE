"""ROS JSON bridge to a test-owned PTY. No physical ports are opened."""
import json
import os
import re
import termios
import tty
import rclpy
from rclpy.node import Node
from std_msgs.msg import String
from .policy import parse_frame


class SerialBridge(Node):
    def __init__(self):
        super().__init__('serial_bridge',enable_rosout=False)
        self.declare_parameter('device_path','')
        path=self.get_parameter('device_path').value
        if not re.fullmatch(r'/dev/pts/[0-9]+',path):
            raise ValueError('this verification bridge opens only its supervisor-owned PTY')
        self.fd=os.open(path,os.O_RDWR|os.O_NOCTTY|os.O_NONBLOCK)
        tty.setraw(self.fd)
        settings=termios.tcgetattr(self.fd)
        settings[4]=settings[5]=termios.B115200
        termios.tcsetattr(self.fd,termios.TCSANOW,settings)
        self.buffer=bytearray();self.discard=False
        self.state=self.create_publisher(String,'state',10)
        self.event=self.create_publisher(String,'event',10)
        self.create_subscription(String,'command',self.command,10)
        self.create_timer(.01,self.receive)

    def error(self,reason):
        self.event.publish(String(data=json.dumps({'kind':'bridge_error','error':str(reason)})))

    def command(self,message):
        try:
            frame=parse_frame(message.data)
            wire=json.dumps({key:frame[key] for key in ('seq','time','value')},allow_nan=False,separators=(',',':')).encode()+b'\n'
            if len(wire)>512: raise ValueError('command exceeds serial line size')
            count=os.write(self.fd,wire)
            if count!=len(wire): raise OSError('partial serial command write')
        except Exception as error: self.error(error)

    def receive(self):
        try:
            chunk=os.read(self.fd,4096)
        except BlockingIOError: return
        except OSError as error: self.error(error);return
        for byte in chunk:
            if byte==10:
                if self.discard: self.error('oversized device line')
                elif self.buffer:
                    try:
                        frame=json.loads(self.buffer)
                        if frame.get('kind')=='state':
                            parse_frame(self.buffer.decode())
                            self.state.publish(String(data=json.dumps(frame,allow_nan=False)))
                        elif frame.get('kind')=='event':
                            self.event.publish(String(data=json.dumps({**frame,'kind':frame['event']},allow_nan=False)))
                        else: self.error('unknown serial frame kind')
                    except Exception as error: self.error(error)
                self.buffer.clear();self.discard=False
            elif byte!=13:
                if len(self.buffer)>=511 or byte==0: self.discard=True
                elif not self.discard: self.buffer.append(byte)

    def destroy_node(self):
        if hasattr(self,'fd'): os.close(self.fd)
        return super().destroy_node()


def main():
    rclpy.init();node=SerialBridge()
    try: rclpy.spin(node)
    except KeyboardInterrupt: pass
    except Exception:
        if rclpy.ok(): raise
    finally:
        node.destroy_node()
        if rclpy.ok(): rclpy.shutdown()
