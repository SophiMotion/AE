"""Independent acceptance rules, never generated or edited by the model."""
import json
import math
import time
import uuid

from .policy import parse_frame
from .contract import SIMULATION_DEFAULTS


def check(name, passed, detail):
    return {"name": name, "passed": bool(passed), "detail": str(detail)}


def logic_checks(compute, kind, parameters):
    checks = []
    if kind == "joint_position":
        for index, (value, target, velocity) in enumerate(((0.0, 0.6, 0.8), (0.4, -0.4, 0.3), (-0.2, 0.2, 0.1), (0.6, 0.6, 0.8))):
            try:
                command = compute(value, target, parameters["threshold"], velocity)
                error = target - value
                valid = abs(command) <= velocity + 1e-9 and (command * error > 0 if abs(error) > 0 else abs(command) < 1e-9)
                checks.append(check(f"logic_joint_case_{index}", valid, f"value={value}, target={target}, velocity_bound={velocity}, command={command}"))
            except Exception as error:
                checks.append(check(f"logic_joint_case_{index}", False, error))
    else:
        for index, (value, threshold) in enumerate(((0.0, 0.5), (0.49, 0.5), (0.5, 0.5), (0.51, 0.5), (1.0, 0.5), (0.0, 0.0), (1.0, 1.0), (0.4, 0.7))):
            try:
                command = compute(value, parameters["target"], threshold, parameters["max_velocity"])
                expected = 1.0 if value >= threshold else 0.0
                checks.append(check(f"logic_sensor_case_{index}", command == expected, f"value={value}, threshold={threshold}, command={command}, expected={expected}"))
            except Exception as error:
                checks.append(check(f"logic_sensor_case_{index}", False, error))
    return checks


class RosVerifier:
    def __init__(self, supervisor, environment, output, kind, parameters):
        import rclpy
        from rclpy.context import Context
        self.rclpy = rclpy
        self.context = Context()
        rclpy.init(args=[], context=self.context, domain_id=78)
        self.supervisor = supervisor
        self.environment = environment
        self.output = output
        self.kind = kind
        self.parameters = parameters
        self.cases = []
        self.series = []
        self.checks = []
        self.received_count = 0

    def close(self):
        if self.context.ok():
            self.context.shutdown()

    def case(self, name, duration, nodes, parameters=None, action=None, physics=False, serial=False):
        from rclpy.node import Node
        from rclpy.executors import SingleThreadedExecutor
        from std_msgs.msg import String
        namespace = "/ae_" + uuid.uuid4().hex[:16]
        observer = Node("verifier", namespace=namespace, context=self.context, enable_rosout=False)
        executor = SingleThreadedExecutor(context=self.context)
        executor.add_node(observer)
        data = {"states": {}, "commands": {}, "events": [], "errors": [], "namespace": namespace}
        started = time.monotonic()

        def receive_state(message):
            try:
                frame = parse_frame(message.data)
                if frame["seq"] in data["states"]:
                    data["errors"].append("duplicate state seq")
                if self.kind == 'sensor_threshold' and not 0 <= frame['value'] <= 1:
                    raise ValueError('sensor state beyond normalized bounds')
                if self.kind == 'joint_position' and abs(frame['value']) > 3.001:
                    raise ValueError('joint state beyond position limits')
                if data['states']:
                    last = next(reversed(data['states'].values()))
                    if frame['seq'] <= last['seq'] or frame['time'] < last['time']:
                        data['errors'].append('state sequence/time not monotonic')
                data["states"][frame["seq"]] = frame
            except Exception as error:
                data["errors"].append("state format: " + str(error))

        def receive_command(message):
            try:
                frame = parse_frame(message.data)
                if self.kind == "joint_position" and abs(frame["value"]) > self.parameters["max_velocity"] + 1e-9:
                    raise ValueError("command exceeds velocity bound")
                if self.kind == "sensor_threshold" and frame["value"] not in (0.0, 1.0):
                    raise ValueError("command is not digital")
                if frame['seq'] in data['commands']:
                    data['errors'].append('duplicate command sequence')
                data["commands"][frame["seq"]] = frame
            except Exception as error:
                data["errors"].append("command format/range: " + str(error))

        def receive_event(message):
            try:
                event = json.loads(message.data)
                data["events"].append(event)
                if event.get("kind") in ("task_error", "device_error",'bridge_error','protocol_error'):
                    data["errors"].append(str(event))
            except Exception as error:
                data["errors"].append("event format: " + str(error))

        observer.create_subscription(String, "state", receive_state, 10)
        observer.create_subscription(String, "command", receive_command, 10)
        observer.create_subscription(String, "event", receive_event, 10)
        state_pub = observer.create_publisher(String, "state", 10)
        command_pub = observer.create_publisher(String, "command", 10)
        processes = []
        descriptors=[]
        values = dict(self.parameters)
        values.update(parameters or {})
        try:
            if serial:
                import pty,os,tty
                master,slave=pty.openpty();descriptors=[master,slave]
                tty.setraw(slave)
                device_path=os.ttyname(slave)
                host=self.output/'esp32'/'host_protocol'
                processes.append(self.supervisor.spawn([str(host),str(master),self.kind,str(values['threshold']),str(values['max_velocity'])],self.output/(name+'-host-core.log'),self.environment,pass_fds=(master,)))
                data['transport_host_pid']=processes[-1].pid
                data['expected_exit_pids']=[]
            if physics:
                from .physics import WORLD
                environment = dict(self.environment, IGN_PARTITION=namespace[1:], GZ_PARTITION=namespace[1:])
                world = self.output / (name + '.sdf')
                world.write_text(WORLD.replace('__NAMESPACE__', namespace), encoding='utf-8')
                processes.append(self.supervisor.spawn(['ign', 'gazebo', '-s', '-r', '-v', '3', str(world)], self.output / (name + '-gazebo.log'), environment))
                bridge = '/opt/ros/humble/lib/ros_gz_bridge/parameter_bridge'
                bridge_args = [bridge, namespace+'/velocity@std_msgs/msg/Float64]ignition.msgs.Double', namespace+'/raw_joint_state@sensor_msgs/msg/JointState[ignition.msgs.Model']
                processes.append(self.supervisor.spawn(bridge_args, self.output / (name + '-bridge.log'), environment))
            else:
                environment = self.environment
            for executable in nodes:
                binary = self.output / "ros_ws" / "install" / "lib" / "ae_generated" / executable
                args = [str(binary), "--ros-args", "-r", "__ns:=" + namespace, "-p", "task_type:=" + self.kind]
                if executable=='serial_bridge': args.extend(['-p','device_path:='+device_path])
                for key in ("target", "threshold", "max_velocity", "initial_value"):
                    if key in values:
                        args.extend(["-p", f"{key}:={float(values[key])}"])
                processes.append(self.supervisor.spawn(args, self.output / f"{name}-{executable}.log", environment))
            ready_at = None
            startup_deadline = started + SIMULATION_DEFAULTS["startup_timeout_seconds"]
            while ready_at is None or time.monotonic() - ready_at < duration:
                self.supervisor.ensure_active()
                for process in processes:
                    if process.poll() is not None and process.pid not in data.get('expected_exit_pids',[]):
                        raise RuntimeError(f"ROS child exited early: pid={process.pid}, exit={process.returncode}, case={name}")
                executor.spin_once(timeout_sec=0.025)
                if ready_at is None:
                    ready = ("task_node" not in nodes or state_pub.get_subscription_count() >= 2) and (not any(node in nodes for node in ('sim_device','gazebo_device','serial_bridge')) or command_pub.get_subscription_count() >= 2) and (not (physics or serial) or len(data['states']) > 0)
                    if ready:
                        ready_at = time.monotonic()
                    elif time.monotonic() > startup_deadline:
                        raise TimeoutError("ROS endpoint discovery exceeded 8 seconds in " + name)
                if action and ready_at is not None:
                    action(time.monotonic() - ready_at, state_pub, command_pub, data)
        finally:
            for process in processes:
                self.supervisor.stop(process)
            executor.shutdown(timeout_sec=1)
            observer.destroy_node()
            for descriptor in descriptors: os.close(descriptor)
        data["elapsed"] = time.monotonic() - started
        self.received_count += len(data["states"])
        self.cases.append({"name": name, "duration": duration, "namespace": namespace, "state_count": len(data["states"]), "command_count": len(data["commands"]), "errors": data["errors"], "events": data["events"]})
        (self.output / f"{name}-trace.json").write_text(json.dumps(data, indent=2), encoding="utf-8")
        return data

    def physics_case(self):
        data = self.case('gazebo_primary', self.parameters['duration'], ['gazebo_device', 'task_node'], physics=True)
        self.inspect_task_case(data, 'gazebo_primary', self.parameters['target'], self.parameters['threshold'], primary_series=True)
        physics_log = (self.output/'gazebo_primary-gazebo.log').read_text(encoding='utf-8',errors='replace')
        self.checks.append(check('gazebo_physics_backend_loaded', '[Err]' not in physics_log and 'Failed to find plugin' not in physics_log, 'Fortress server log must have no physics/plugin error; see gazebo_primary-gazebo.log'))
        self.checks.append(check('gazebo_physics_measurements', len(data['states']) >= 10, 'joint positions received from Fortress JointStatePublisher through ros_gz_bridge; no Python integration in adapter'))

    def serial_cases(self):
        start=len(self.checks)
        primary=self.case('serial_primary',self.parameters['duration'],['serial_bridge','task_node'],serial=True)
        self.inspect_task_case(primary,'serial_primary',self.parameters['target'],self.parameters['threshold'])
        if self.kind=='sensor_threshold':
            threshold=.7 if self.parameters['threshold']<.6 else .3
            alternate=self.case('serial_alternate_threshold',3.5,['serial_bridge','task_node'],{'threshold':threshold},serial=True)
            self.inspect_task_case(alternate,'serial_alternate_threshold',self.parameters['target'],threshold)
        sent={'done':False}
        def disconnect(elapsed,state_pub,command_pub,data):
            if elapsed>1 and not sent['done']:
                host=next(process for process in self.supervisor.processes if process.pid==data['transport_host_pid'])
                data['expected_exit_pids'].append(host.pid)
                self.supervisor.stop(host);sent['done']=True
        lost=self.case('serial_state_loss',2.5,['serial_bridge','task_node'],action=disconnect,serial=True)
        timeout=any(event.get('kind')=='task_timeout' for event in lost['events'])
        last=list(lost['commands'].values())[-1] if lost['commands'] else {}
        self.checks.append(check('serial_state_loss_safe_zero',timeout and last.get('value')==0,'native transport producer stopped; real ROS task watchdog must issue zero'))
        return {'passed':all(item['passed'] for item in self.checks[start:]),'checks':self.checks[start:],'scope':'host_protocol_core_pty_ros','esp32_execution_verified':False,'flashed':False,'physical_verified':False,'samples':len(primary['states'])}

    def main_cases(self):
        primary = self.case("primary", self.parameters["duration"], ["sim_device", "task_node"], {"initial_value": 0.0})
        self.inspect_task_case(primary, "primary", self.parameters["target"], self.parameters["threshold"], primary_series=True)
        if self.kind == "joint_position":
            target = -0.4 if self.parameters["target"] >= 0 else 0.4
            secondary = self.case("alternate_target", 5.5, ["sim_device", "task_node"], {"target": target, "initial_value": 0.1})
            self.inspect_task_case(secondary, "alternate_target", target, self.parameters["threshold"])
            steady = self.case("already_at_target", 2.0, ["sim_device", "task_node"], {"target": 0.2, "initial_value": 0.2})
            self.inspect_task_case(steady, "already_at_target", 0.2, self.parameters["threshold"])
        else:
            threshold = 0.7 if self.parameters["threshold"] < 0.6 else 0.3
            alternate = self.case("alternate_threshold", 3.5, ["sim_device", "task_node"], {"threshold": threshold})
            self.inspect_task_case(alternate, "alternate_threshold", self.parameters["target"], threshold)

    def inspect_task_case(self, data, name, target, threshold, primary_series=False):
        pairs = [(state, data["commands"][seq]) for seq, state in data["states"].items() if seq in data["commands"]]
        wrong_stamps = sum(state['time'] != command['time'] for state, command in pairs)
        self.checks.append(check(name + "_message_contract", not data["errors"] and len(pairs) >= 10 and wrong_stamps == 0, f"states={len(data['states'])}, paired_commands={len(pairs)}, mismatched_timestamps={wrong_stamps}, errors={data['errors']}"))
        states=list(data['states'].values())
        span=states[-1]['time']-states[0]['time'] if len(states)>1 else 0
        observed_hz=(len(states)-1)/span if span>0 else 0
        self.checks.append(check(name+'_state_frequency', 13 <= observed_hz <= 25, f'nominal=20Hz, observed={observed_hz:.3f}Hz; wall-clock scheduling tolerance 13..25Hz'))
        if primary_series:
            self.series = [{"time": state["time"], "value": state["value"], "target": target if self.kind == "joint_position" else threshold, "command": command["value"]} for state, command in pairs]
        if self.kind == "joint_position":
            final = [state["value"] for state in list(data["states"].values())[-5:]]
            error = max((abs(value - target) for value in final), default=math.inf)
            self.checks.append(check(name + "_position_tolerance", bool(final) and error <= self.parameters["tolerance"], f"target={target}, max_final_error={error}, tolerance={self.parameters['tolerance']}"))
        else:
            wrong = [(state["value"], command["value"]) for state, command in pairs if command["value"] != (1.0 if state["value"] >= threshold else 0.0)]
            coverage = {"below": any(state["value"] < threshold for state, _ in pairs), "equal": any(state["value"] == threshold for state, _ in pairs), "above": any(state["value"] > threshold for state, _ in pairs)}
            required_coverage = coverage['equal'] and (coverage['below'] or threshold == 0) and (coverage['above'] or threshold == 1)
            self.checks.append(check(name + "_threshold_behavior", not wrong and len(pairs) >= 10 and required_coverage, f"wrong={wrong[:5]}, coverage={coverage}; boundary thresholds omit impossible side"))

    def fault_cases(self):
        from std_msgs.msg import String
        sent = {"done": False}

        def send_initial(elapsed, state_pub, command_pub, data):
            if elapsed > 0.2 and not sent["done"]:
                state_pub.publish(String(data=json.dumps({"seq": 10, "time": 0.0, "value": 0.1})))
                sent["done"] = True

        timeout = self.case("state_timeout", 1.8, ["task_node"], action=send_initial)
        timeout_events = [event for event in timeout["events"] if event.get("kind") == "task_timeout"]
        self.checks.append(check("state_loss_safe_zero", bool(timeout_events) and any(frame["value"] == 0 for seq, frame in timeout["commands"].items() if seq > 10), f"events={timeout_events}, commands={timeout['commands']}"))

        sent = {"first": False, "duplicate": False, "invalid": False}
        first_value = min(0.2, self.parameters["max_velocity"]) if self.kind == "joint_position" else 1.0

        def send_duplicate(elapsed, state_pub, command_pub, data):
            if elapsed > 0.2 and not sent["first"]:
                command_pub.publish(String(data=json.dumps({"seq": 100, "time": 0, "value": first_value})))
                sent["first"] = True
            if elapsed > 0.4 and not sent["duplicate"]:
                command_pub.publish(String(data=json.dumps({"seq": 100, "time": 0, "value": 0.0})))
                sent["duplicate"] = True
            if elapsed > 0.55 and not sent["invalid"]:
                command_pub.publish(String(data='{"seq":101,"time":0,"value":"invalid"}'))
                sent["invalid"] = True

        duplicate = self.case("duplicate_and_device_timeout", 1.8, ["sim_device"], action=send_duplicate)
        applied = [event for event in duplicate["events"] if event.get("kind") == "command_applied" and event.get("seq") == 100]
        rejected = [event for event in duplicate["events"] if event.get("kind") == "command_duplicate" and event.get("seq") == 100]
        self.checks.append(check("duplicate_command_not_reapplied", len(applied) == 1 and bool(rejected) and rejected[0].get("held_value") == first_value, f"applied={applied}, rejected={rejected}"))
        device_timeouts = [event for event in duplicate["events"] if event.get("kind") == "device_timeout"]
        self.checks.append(check("device_watchdog_safe_zero", bool(device_timeouts) and list(duplicate["states"].values())[-1].get("applied") == 0, f"events={device_timeouts}"))
        self.checks.append(check("malformed_command_rejected", any(event.get("kind") == "device_error" for event in duplicate["events"]), "malformed frame deliberately injected; device_error required"))
