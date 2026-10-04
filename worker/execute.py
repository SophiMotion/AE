#!/usr/bin/env python3
"""Deterministic local ROS worker. No model has access to this executor."""
import argparse
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from worker.policy import load_compute, safe_output, validate_parameters
from worker.templates import generate
from worker.verification import RosVerifier, check, logic_checks


class Cancelled(Exception):
    pass


class CompletedV3(Exception):
    """Internal control flow; final cleanup still determines exit status."""


def emit(stage, message, level="info"):
    print(json.dumps({"stage": stage, "message": message, "level": level}, ensure_ascii=False), flush=True)


def classify_failure(checks,error=None):
    failed=[item for item in checks if not item['passed']]
    if not failed and error is None: return None
    if isinstance(error,(TimeoutError,OSError,subprocess.SubprocessError)) or any(item['name'].endswith('_state_frequency') or item['name']=='gazebo_physics_backend_loaded' for item in failed): return 'environment'
    if any(item['name'].startswith(('protocol_','firmware_','serial_state_loss')) for item in failed): return 'firmware'
    return 'algorithm'


class Supervisor:
    def __init__(self, output):
        self.output = output
        self.processes = []
        self.handles = []
        self.bad_lease_since = None
        self.owned_descendants = {}
        self.root_identities = {}
        self.closed = False
        self.drain_confirmed = False
        self.subreaper_previous = None
        self.initial_children = {pid: info['start'] for pid, info in self.process_table().items() if info['parent'] == os.getpid()}
        if sys.platform == 'linux':
            import ctypes
            self.libc = ctypes.CDLL(None, use_errno=True)
            previous = ctypes.c_int()
            if self.libc.prctl(37, ctypes.byref(previous), 0, 0, 0) or self.libc.prctl(36, 1, 0, 0, 0):
                raise OSError(ctypes.get_errno(), 'cannot enable local worker child-subreaper')
            self.subreaper_previous = previous.value
        (output / "worker-state.json").write_text(json.dumps({"status": "running", "pid": os.getpid()}), encoding="utf-8")

    def ensure_active(self):
        self.capture_descendants()
        if (self.output / "cancel.flag").exists():
            raise Cancelled("cancel.flag received")
        lease = self.output / "lease.json"
        if lease.exists():
            try:
                heartbeat = json.loads(lease.read_text(encoding="utf-8"))["heartbeat"]
                if isinstance(heartbeat, bool) or not isinstance(heartbeat, (int, float)) or not math.isfinite(heartbeat):
                    raise ValueError("invalid heartbeat")
                self.bad_lease_since = None
                if time.time() - lease.stat().st_mtime > 10:
                    raise Cancelled("server lease expired for over 10 seconds")
            except Cancelled:
                raise
            except (ValueError, KeyError, OSError):
                self.bad_lease_since = self.bad_lease_since or time.monotonic()
                if time.monotonic() - self.bad_lease_since > 2:
                    raise Cancelled("invalid server lease persisted for over 2 seconds")

    def spawn(self, arguments, logfile, environment, cwd=None, pass_fds=()):
        self.ensure_active()
        handle = logfile.open("w", encoding="utf-8")
        self.handles.append(handle)
        process = subprocess.Popen(arguments, stdout=handle, stderr=subprocess.STDOUT, env=environment, cwd=cwd, start_new_session=True,pass_fds=pass_fds)
        self.processes.append(process)
        table=self.process_table()
        if process.pid in table: self.root_identities[process.pid]=table[process.pid]
        self.capture_descendants()
        return process

    @staticmethod
    def process_table():
        table = {}
        for entry in Path('/proc').glob('[0-9]*/stat'):
            try:
                fields = entry.read_text().rsplit(')', 1)[1].split()
                table[int(entry.parent.name)] = {'parent': int(fields[1]), 'group': int(fields[2]), 'start': fields[19], 'state': fields[0]}
            except (OSError, ValueError, IndexError): pass
        return table

    def capture_descendants(self):
        if not self.processes: return
        table = self.process_table()
        owners = {process.pid: process.pid for process in self.processes if process.pid in table and process.pid in self.root_identities and table[process.pid]['start']==self.root_identities[process.pid]['start'] and table[process.pid]['state']!='Z'}
        for pid, identity in self.owned_descendants.items():
            if pid in table and table[pid]['start'] == identity['start'] and table[pid]['state'] != 'Z':
                owners[pid] = identity['owner']
        # This executor is a dedicated worker process. Linux subreaper adopts
        # orphaned descendants even if their parent exits between snapshots.
        # Exclude roots and every direct child present before this Supervisor.
        for pid,info in table.items():
            if info['parent']==os.getpid() and self.root_identities.get(pid,{}).get('start')!=info['start'] and self.initial_children.get(pid)!=info['start']:
                self.owned_descendants[pid]={**info,'owner':0,'adopted':True}
                if info['state']!='Z': owners[pid]=0
        while True:
            additions = {pid: owners[info['parent']] for pid, info in table.items() if pid not in owners and info['parent'] in owners and info['state'] != 'Z'}
            if not additions: break
            for pid, owner in additions.items():
                self.owned_descendants[pid] = {**table[pid], 'owner': owner}
            owners.update(additions)

    def live_descendants(self, owner=None):
        live = []
        for pid, identity in self.owned_descendants.items():
            if owner is not None and identity['owner'] not in (owner,0): continue
            try:
                fields = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
                if fields[19] == identity['start'] and fields[0] != 'Z': live.append(pid)
            except (OSError, IndexError): pass
        return live

    def signal_descendants(self, owner, signum):
        # Children can create their own process group. Signal only descendant
        # PIDs whose kernel start-time still matches; never kill arbitrary groups.
        for pid in reversed(self.live_descendants(owner)):
            self.signal_identity(pid,self.owned_descendants[pid],signum)

    @staticmethod
    def signal_identity(pid, identity, signum):
        descriptor=None
        try:
            if hasattr(os,'pidfd_open') and hasattr(signal,'pidfd_send_signal'): descriptor=os.pidfd_open(pid)
            fields=Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()
            if fields[19]!=identity['start'] or fields[0]=='Z': return
            if descriptor is not None: signal.pidfd_send_signal(descriptor,signum)
            else: os.kill(pid,signum)
        except (ProcessLookupError,FileNotFoundError): pass
        finally:
            if descriptor is not None: os.close(descriptor)

    def all_exited(self):
        return all(process.poll() is not None for process in self.processes) and not self.live_descendants() and (not self.closed or self.drain_confirmed)

    def stop(self, process):
        self.capture_descendants()
        self.signal_descendants(process.pid, signal.SIGTERM)
        if process.pid in self.root_identities:
            self.signal_identity(process.pid,self.root_identities[process.pid],signal.SIGTERM)
        if process.poll() is None:
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                if process.pid in self.root_identities: self.signal_identity(process.pid,self.root_identities[process.pid],signal.SIGKILL)
                process.wait(timeout=2)
        deadline=time.monotonic()+2
        self.capture_descendants()
        while self.live_descendants(process.pid) and time.monotonic()<deadline:
            self.capture_descendants()
            time.sleep(.05)
        self.signal_descendants(process.pid, signal.SIGKILL)
        deadline=time.monotonic()+2
        while self.live_descendants(process.pid) and time.monotonic()<deadline: time.sleep(.05)

    @staticmethod
    def group_alive(group):
        # The CLI can exit before its ROS/Gazebo grandchildren. Inspect only
        # our own session's process group; ignore already-dead zombies.
        for entry in Path('/proc').glob('[0-9]*/stat'):
            try:
                fields=entry.read_text().rsplit(')',1)[1].split()
                if int(fields[2])==group and fields[0] != 'Z': return True
            except (OSError,ValueError,IndexError): pass
        return False

    def run(self, arguments, logfile, environment, cwd=None, timeout=90):
        process = self.spawn(arguments, logfile, environment, cwd)
        deadline = time.monotonic() + timeout
        while process.poll() is None:
            self.ensure_active()
            if time.monotonic() > deadline:
                self.stop(process)
                raise TimeoutError(f"command exceeded {timeout}s: {arguments[0]}")
            time.sleep(0.1)
        return process.returncode

    def close(self):
        if self.closed: return
        for process in reversed(self.processes):
            self.stop(process)
        deadline=time.monotonic()+3
        quiet_since=None
        while True:
            self.capture_descendants()
            if self.owned_descendants: self.signal_descendants(None,signal.SIGKILL)
            for pid,identity in list(self.owned_descendants.items()):
                if identity.get('adopted'):
                    try:
                        fields=Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()
                        if fields[19]==identity['start'] and fields[0]=='Z': os.waitpid(pid,os.WNOHANG)
                    except (OSError,IndexError,ChildProcessError): pass
            if self.all_exited():
                if quiet_since is None: quiet_since=time.monotonic()
                elif time.monotonic()-quiet_since>=.05:
                    self.drain_confirmed=True
                    break
            else: quiet_since=None
            if time.monotonic()>=deadline: break
            time.sleep(.05)
        for handle in self.handles:
            handle.close()
        self.closed=True
        (self.output / "worker-state.json").write_text(json.dumps({"status": "stopped", "all_exited": self.all_exited()}), encoding="utf-8")
        if self.subreaper_previous is not None: self.libc.prctl(36,self.subreaper_previous,0,0,0)


def overlay_environment(workspace, environment):
    setup = workspace / "install" / "local_setup.bash"
    process = subprocess.run(["bash", "-c", 'source "$1" && env -0', "bash", str(setup)], env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10, check=True)
    return dict(entry.split("=", 1) for entry in process.stdout.decode().split("\0") if "=" in entry)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--spec", required=True, type=Path)
    parser.add_argument("--code", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--firmware-code", type=Path)
    parser.add_argument("--deploy", action="store_true")
    arguments = parser.parse_args()
    try:
        output = safe_output(arguments.output, ROOT, deploy=arguments.deploy)
    except ValueError as error:
        emit("building", str(error), "error")
        return 2
    output.mkdir(parents=True, exist_ok=True)
    supervisor = Supervisor(output)
    result = {"passed": False, "engine": "not_run", "checks": [], "metrics": {}, "series": [], "ros_verified": False, "esp32_status": "reference_only_not_compiled_not_flashed", "physical_verified": False,'esp32_execution_verified':False,'flashed':False,'failure_scope':None,'firmware':None,'communication_test':None}
    stage = "deploying" if arguments.deploy else "building"
    verifier = None
    try:
        supervisor.ensure_active()
        for path in (arguments.spec, arguments.code):
            if not path.resolve().is_relative_to((ROOT / "runs").resolve()) or not path.is_file():
                raise ValueError("spec and code must be files inside this project's runs")
        if os.environ.get("ROS_DISTRO") != "humble":
            raise RuntimeError("source /opt/ros/humble/setup.bash before running worker")
        os.environ["ROS_DOMAIN_ID"] = "78"
        os.environ["ROS_LOCALHOST_ONLY"] = "1"
        os.environ["ROS_LOG_DIR"] = str(output / "ros_logs")
        spec = json.loads(arguments.spec.read_text(encoding="utf-8-sig"))
        if spec.get("task_type") not in ("joint_position", "sensor_threshold"):
            raise ValueError("unsupported task_type")
        if spec.get("hardware", {}).get("ros_distro", "humble") != "humble":
            raise ValueError("this worker supports ROS 2 Humble only")
        if spec.get('pipeline_version')==3:
            if spec['task_type']=='joint_position' and not spec.get('execution_model'): raise ValueError('V3 joint task requires frozen execution_model')
            if arguments.firmware_code is None or not arguments.firmware_code.resolve().is_relative_to((ROOT/'runs').resolve()) or not arguments.firmware_code.is_file(): raise ValueError('V3 requires --firmware-code inside project runs')
            from worker.execute_v3 import execute_v3
            execute_v3(output,spec,arguments.code.read_text(encoding='utf-8-sig'),arguments.firmware_code.read_text(encoding='utf-8-sig'),supervisor,dict(os.environ),emit,overlay_environment,result,deploy=arguments.deploy)
            raise CompletedV3()
        spec["parameters"] = validate_parameters(spec.get("parameters", {}))
        from worker.firmware import validate_hardware,probe_firmware_toolchain,compile_firmware,compile_host_core
        new_firmware=validate_hardware(spec.get('hardware',{}),spec['task_type'])
        code = arguments.code.read_text(encoding="utf-8-sig")
        compute = load_compute(code)
        result["checks"].append(check("bounded_ast_policy", True, "one pure numeric function; fixed signature; no system/file/network calls or loops"))
        result["checks"].extend(logic_checks(compute, spec["task_type"], spec["parameters"]))
        emit(stage, "任务逻辑已通过代码范围检查；生成独立 ROS、模拟设备和 ESP32 参考工程")
        generate(output, spec, code)
        (output / "spec-used.json").write_text(json.dumps(spec, ensure_ascii=False, indent=2), encoding="utf-8")
        environment = dict(os.environ)
        if new_firmware:
            if not probe_firmware_toolchain()['available']:
                result['failure_scope']='environment'
                raise RuntimeError('固定 ESP32 工具链尚未就绪，请查看 .tools/firmware-toolchain-install.log；无需 AI 修改控制函数')
            emit(stage,'运行真实 Arduino CLI：编译 '+spec['hardware']['board']+' 固件，保留 ELF/BIN 与编译日志')
            result['failure_scope']='firmware'
            result['firmware']=compile_firmware(spec,output,supervisor,environment)
            result['checks'].append(check('firmware_cross_compile',result['firmware']['passed'],'fixed core 3.3.12, ArduinoJson 7.4.3; firmware-compile.log and firmware-build.json'))
            if not result['firmware']['passed']:
                result['failure_scope']='firmware'
                raise RuntimeError('ESP32 固件编译失败；保留真实编译器错误，不进入控制函数修复')
            result['esp32_status']='compiled_not_flashed_not_executed'
            emit(stage,'编译同一份 C++ 固件协议核心的主机测试进程（不等于 ESP32 芯片执行）')
            result['native_protocol_build']=compile_host_core(output,supervisor,environment)
            result['failure_scope']=None
        workspace = output / "ros_ws"
        emit(stage, "运行真实 colcon build（ROS 2 Humble）")
        build_exit = supervisor.run(["colcon", "build", "--merge-install", "--event-handlers", "console_direct+"], output / "build.log", environment, cwd=workspace)
        result["checks"].append(check("colcon_build", build_exit == 0, f"exit_code={build_exit}; build.log"))
        if build_exit:
            result['failure_scope']='environment'
            raise RuntimeError("colcon build failed; see build.log")
        environment = overlay_environment(workspace, environment)
        stage = "deploying" if arguments.deploy else "testing"
        result["engine"] = "ros2_humble_numerical_device"
        emit(stage, "启动分进程 ROS 任务与数值模拟设备，执行固定多场景验收")
        verifier = RosVerifier(supervisor, environment, output, spec["task_type"], spec["parameters"])
        verifier.main_cases()
        emit(stage, "验证失联零命令、重复命令和错误消息拒绝")
        verifier.fault_cases()
        if new_firmware:
            emit(stage,'执行真实 ROS ↔ PTY ↔ 主机固件协议核心双向通信与断流验收')
            result['communication_test']=verifier.serial_cases()
            from worker.protocol_verification import verify_core_faults
            emit(stage,'独立注入串口分片、重复/过期、错误/超长帧、失联与恢复')
            protocol_checks=verify_core_faults(output,spec['task_type'],spec['parameters'],supervisor,environment)
            result['communication_test']['checks'].extend(protocol_checks)
            verifier.checks.extend(protocol_checks)
            result['communication_test']['passed']=all(item['passed'] for item in result['communication_test']['checks'])
        from worker.physics import available
        gazebo_available = available()
        if spec['task_type'] == 'joint_position' and gazebo_available:
            emit(stage, '启动 headless Gazebo Fortress/DART 与 ROS bridge，读取真实仿真关节位置')
            verifier.physics_case()
            result['engine'] = 'gazebo_fortress_dart_joint_and_ros2_numerical_fault_cases'
        result["checks"].extend(verifier.checks)
        result["series"] = verifier.series
        physics_checks = [item for item in verifier.checks if item['name'].startswith('gazebo_')]
        result["metrics"] = {"samples": len(verifier.series), "cases": verifier.cases, "ros_domain_id": 78, "localhost_only": True, "validation_owner": "trusted worker/verification.py", "deployment_scope": "isolated local ROS re-run" if arguments.deploy else "local verification", "gazebo_available": gazebo_available, "physics_simulation_verified": bool(physics_checks) and all(item['passed'] for item in physics_checks)}
        result["ros_verified"] = verifier.received_count > 0 and all(item["passed"] for item in verifier.checks if "message_contract" in item["name"])
        result["passed"] = all(item["passed"] for item in result["checks"])
        result['failure_scope']=classify_failure(result['checks'])
        emit(stage, "验收通过" if result["passed"] else "独立验收失败；保留每个场景日志和时序", "info" if result["passed"] else "error")
    except CompletedV3:
        pass
    except Cancelled as error:
        result["cancelled"] = True
        result["checks"].append(check("cancelled", False, error))
        emit(stage, str(error), "warning")
    except Exception as error:
        result["error"] = str(error)
        result["checks"].append(check("worker_execution", False, f"{type(error).__name__}: {error}"))
        if result['failure_scope'] is None: result['failure_scope']=classify_failure(result['checks']+(verifier.checks if verifier else []),error)
        emit(stage, str(error), "error")
    finally:
        if verifier is not None:
            if not result['series']:
                result['series'] = verifier.series
            present = {item['name'] for item in result['checks']}
            result['checks'].extend(item for item in verifier.checks if item['name'] not in present)
            result['metrics'].setdefault('cases', verifier.cases)
            verifier.close()
        supervisor.close()
        result["metrics"]["cleanup"] = {"owned_process_count": len(supervisor.processes), "all_exited": supervisor.all_exited()}
        if supervisor.owned_descendants: result['metrics']['cleanup']['tracked_descendant_count']=len(supervisor.owned_descendants)
        if not supervisor.all_exited():
            result['passed']=False
            result['failure_scope']='environment'
            result['checks'].append(check('process_cleanup',False,'owned descendant process did not exit'))
        (output / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    return 0 if result["passed"] else (130 if result.get("cancelled") else 1)


if __name__ == "__main__":
    raise SystemExit(main())
