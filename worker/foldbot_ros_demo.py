"""Generated ROS 2 demonstration; no robot transport or motion implementation.

Default invocation prints an offline example and exits without importing rclpy.
Only an explicit --run-ros creates a ROS node, which logs examples and publishes
no messages. This example has not been run against ROS or accepted on hardware.
"""
import argparse
import json


def example_status():
    return {
        "mode": "offline_demo",
        "hardware_connected": False,
        "motion_enabled": False,
        "firmware_build": "unknown_until_live_read",
        "fold_position": "unknown_not_measured",
        "arm_unit": "raw_not_degrees",
        "evidence": "example_only_not_device_feedback",
    }


def main(args=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-ros", action="store_true",
                        help="Explicitly start a log-only ROS node; no robot transport")
    options, ros_args = parser.parse_known_args(args)
    payload = json.dumps(example_status(), ensure_ascii=False)
    if not options.run_ros:
        print(payload)
        return
    import rclpy
    from rclpy.node import Node

    rclpy.init(args=ros_args)
    node = Node("foldbot_generated_demo")
    node.get_logger().warning("UNTESTED DEMO: no robot connection or motion output")
    timer = node.create_timer(2.0, lambda: node.get_logger().info(payload))
    try:
        rclpy.spin(node)
    finally:
        node.destroy_timer(timer)
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
