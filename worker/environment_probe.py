#!/usr/bin/env python3
"""Inspect sourced ROS and probe two local nodes in a dedicated ROS domain.

Run only after sourcing /opt/ros/humble/setup.bash. This script sends its own
String token on /ae_probe; it does not call services, actions, or robot topics.
"""

import importlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone


ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "docs" / "ros-environment.json"
DOMAIN = 78
TIMEOUT_SECONDS = 10.0

# Set before importing rclpy: never inherit the caller's robot domain.
os.environ["ROS_DOMAIN_ID"] = str(DOMAIN)
os.environ["ROS_LOCALHOST_ONLY"] = "1"
os.environ["ROS_LOG_DIR"] = str(ROOT / ".tools" / "ros-probe-logs")


def command_output(arguments):
    result = subprocess.run(arguments, capture_output=True, text=True, timeout=10)
    return {
        "exit_code": result.returncode,
        "stdout": result.stdout.strip(),
        "stderr": result.stderr.strip(),
    }


def package_inventory():
    packages = {}
    for name in (
        "rclpy", "std_msgs", "sensor_msgs", "geometry_msgs", "nav_msgs",
        "diagnostic_msgs", "rcl_interfaces", "builtin_interfaces",
        "launch_testing", "launch_testing_ros", "gazebo_ros", "gazebo_msgs",
        "ros_gz_sim", "ros_gz_bridge", "launch", "launch_ros",
    ):
        spec = importlib.util.find_spec(name)
        packages[name] = {
            "python_module_found": spec is not None,
            "module_origin": spec.origin if spec else None,
        }
    from ament_index_python.packages import get_packages_with_prefixes
    installed = get_packages_with_prefixes()
    for name, entry in packages.items():
        entry["ament_package_prefix"] = installed.get(name)
    return packages


def run_pubsub():
    import rclpy
    from rclpy.context import Context
    from rclpy.executors import SingleThreadedExecutor
    from rclpy.node import Node
    from rclpy.qos import QoSProfile, ReliabilityPolicy, DurabilityPolicy
    from rclpy.utilities import get_rmw_implementation_identifier
    from std_msgs.msg import String

    context = Context()
    executor = None
    publisher_node = None
    subscriber_node = None
    token = "ae_environment_probe:" + uuid.uuid4().hex
    received = []
    published_count = 0
    started = time.monotonic()
    try:
        rclpy.init(args=[], context=context, domain_id=DOMAIN)
        node_options = {
            "context": context,
            "namespace": "/ae_probe",
            "enable_rosout": False,
            "use_global_arguments": False,
            "cli_args": ["--ros-args", "--disable-external-lib-logs"],
        }
        suffix = uuid.uuid4().hex[:12]
        publisher_node = Node("publisher_" + suffix, **node_options)
        subscriber_node = Node("subscriber_" + suffix, **node_options)
        qos = QoSProfile(
            depth=10,
            reliability=ReliabilityPolicy.RELIABLE,
            durability=DurabilityPolicy.VOLATILE,
        )
        publisher = publisher_node.create_publisher(String, "/ae_probe", qos)

        def on_message(message):
            if message.data == token:
                received.append({"data": message.data, "elapsed_seconds": time.monotonic() - started})

        subscription = subscriber_node.create_subscription(String, "/ae_probe", on_message, qos)

        def publish_token():
            nonlocal published_count
            publisher.publish(String(data=token))
            published_count += 1

        publisher_node.create_timer(0.1, publish_token)
        executor = SingleThreadedExecutor(context=context)
        executor.add_node(publisher_node)
        executor.add_node(subscriber_node)
        # Bound the whole local probe, including initialization and discovery.
        deadline = started + TIMEOUT_SECONDS
        while not received and time.monotonic() < deadline:
            executor.spin_once(timeout_sec=min(0.1, max(0.0, deadline - time.monotonic())))
        return {
            "passed": bool(received),
            "process_id": os.getpid(),
            "node_names": [publisher_node.get_fully_qualified_name(), subscriber_node.get_fully_qualified_name()],
            "topic": "/ae_probe",
            "message_type": "std_msgs/msg/String",
            "timeout_seconds": TIMEOUT_SECONDS,
            "elapsed_seconds": time.monotonic() - started,
            "published_count": published_count,
            "matching_received_count": len(received),
            "received": received,
            "publisher_subscription_count": publisher.get_subscription_count(),
            "subscriber_publisher_count": subscriber_node.count_publishers("/ae_probe"),
            "rmw_implementation": get_rmw_implementation_identifier(),
            "qos": {"depth": 10, "reliability": "reliable", "durability": "volatile"},
            "same_process_two_nodes": True,
        }
    finally:
        if executor is not None:
            executor.shutdown(timeout_sec=1.0)
        if subscriber_node is not None:
            subscriber_node.destroy_node()
        if publisher_node is not None:
            publisher_node.destroy_node()
        if context.ok():
            context.shutdown()


def main():
    report = {
        "schema_version": 1,
        "checked_at_utc": datetime.now(timezone.utc).isoformat(),
        "scope": "environment inventory and same-process local ROS pub/sub only",
        "platform": platform.platform(),
        "python_version": sys.version,
        "python_executable": sys.executable,
        "ros_distro": os.environ.get("ROS_DISTRO"),
        "ros_domain_id": DOMAIN,
        "ros_localhost_only": "1",
        "source_setup": "/opt/ros/humble/setup.bash",
        "environment": {
            key: os.environ.get(key)
            for key in ("RMW_IMPLEMENTATION", "AMENT_PREFIX_PATH", "COLCON_PREFIX_PATH", "ROS_LOG_DIR")
        },
        "executables": {name: shutil.which(name) for name in ("ros2", "colcon", "gazebo", "gz", "ign")},
        "limitations": [
            "No Gazebo simulation, launch_testing suite, colcon build, or physical robot execution was performed.",
            "Pub/sub success proves two nodes in one process; it does not prove cross-process or cloud/edge transport.",
            "No existing workspace at /home/lx/foldbot_ws_runtime was read or modified.",
            "No robot services, actions, motion topics, or existing ROS domain were used.",
        ],
    }
    try:
        report["os_release"] = Path("/etc/os-release").read_text(encoding="utf-8").strip()
        report["packages"] = package_inventory()
        report["installed_gazebo_packages"] = command_output([
            "dpkg-query", "-W", "-f=${Package}\t${Version}\t${db:Status-Status}\n",
            "gazebo*", "libgazebo*", "ros-humble-gazebo*", "ros-humble-ros-gz*",
        ])
        report["pubsub"] = run_pubsub()
        report["passed"] = report["pubsub"]["passed"]
    except Exception as error:
        report["passed"] = False
        report["error"] = {"type": type(error).__name__, "message": str(error)}
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"passed": report["passed"], "report_path": str(REPORT), "pubsub": report.get("pubsub"), "error": report.get("error")}, ensure_ascii=False))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
