// Only firmware-authenticated state reaches ros2_control. No Gazebo shortcut.
#include <algorithm>
#include <chrono>
#include <cmath>
#include <iomanip>
#include <memory>
#include <sstream>
#include <string>
#include <vector>
#include "hardware_interface/system_interface.hpp"
#include "hardware_interface/types/hardware_interface_type_values.hpp"
#include "pluginlib/class_list_macros.hpp"
#include "rclcpp/rclcpp.hpp"
#include "sensor_msgs/msg/joint_state.hpp"
#include "std_msgs/msg/string.hpp"

namespace ae_motion_hardware {
class TopicSystem : public hardware_interface::SystemInterface {
  std::shared_ptr<rclcpp::Node> node_;
  rclcpp::executors::SingleThreadedExecutor executor_;
  rclcpp::Publisher<std_msgs::msg::String>::SharedPtr publisher_;
  rclcpp::Subscription<sensor_msgs::msg::JointState>::SharedPtr subscriber_;
  std::vector<double> positions_, commands_, lower_, upper_;
  std::vector<std::string> names_;
  std::string identity_;
  bool received_ = false;
  int64_t stamp_ = -1;
  uint64_t sequence_ = 0;
  std::chrono::steady_clock::time_point last_, start_;
public:
  hardware_interface::CallbackReturn on_init(const hardware_interface::HardwareInfo & info) override {
    if (SystemInterface::on_init(info) != hardware_interface::CallbackReturn::SUCCESS) return hardware_interface::CallbackReturn::ERROR;
    identity_ = info_.hardware_parameters.at("identity");
    auto options = rclcpp::NodeOptions().arguments({"--ros-args", "-p", "use_sim_time:=true", "-r", "/clock:=" + info_.hardware_parameters.at("namespace") + "/clock"});
    node_ = std::make_shared<rclcpp::Node>("motion_hardware", info_.hardware_parameters.at("namespace"), options);
    for (const auto & joint : info_.joints) {
      names_.push_back(joint.name);
      const double initial = std::stod(joint.state_interfaces.at(0).initial_value);
      positions_.push_back(initial); commands_.push_back(initial);
      lower_.push_back(std::stod(joint.command_interfaces.at(0).min));
      upper_.push_back(std::stod(joint.command_interfaces.at(0).max));
    }
    publisher_ = node_->create_publisher<std_msgs::msg::String>("command", 10);
    subscriber_ = node_->create_subscription<sensor_msgs::msg::JointState>("hardware_state", 10,
      [this](sensor_msgs::msg::JointState::ConstSharedPtr m) {
        int64_t stamp = int64_t(m->header.stamp.sec) * 1000000000LL + m->header.stamp.nanosec;
        if (m->name != names_ || m->position.size() != names_.size() || m->header.frame_id != identity_ || stamp <= stamp_) return;
        for (size_t i = 0; i < names_.size(); ++i)
          if (!std::isfinite(m->position[i]) || m->position[i] < lower_[i] - 1e-6 || m->position[i] > upper_[i] + 1e-6) return;
        std::copy(m->position.begin(), m->position.end(), positions_.begin()); stamp_ = stamp; received_ = true; last_ = std::chrono::steady_clock::now();
      });
    executor_.add_node(node_); start_ = std::chrono::steady_clock::now();
    return hardware_interface::CallbackReturn::SUCCESS;
  }
  std::vector<hardware_interface::StateInterface> export_state_interfaces() override {
    std::vector<hardware_interface::StateInterface> out;
    for (size_t i=0; i<names_.size(); ++i) out.emplace_back(names_[i], "position", &positions_[i]);
    return out;
  }
  std::vector<hardware_interface::CommandInterface> export_command_interfaces() override {
    std::vector<hardware_interface::CommandInterface> out;
    for (size_t i=0; i<names_.size(); ++i) out.emplace_back(names_[i], "position", &commands_[i]);
    return out;
  }
  hardware_interface::return_type read(const rclcpp::Time &, const rclcpp::Duration &) override {
    executor_.spin_some();
    // Keep the controller observable during fault tests; its stale targets cannot
    // actuate because the independent C++ firmware watchdog owns motor output.
    return hardware_interface::return_type::OK;
  }
  hardware_interface::return_type write(const rclcpp::Time & time, const rclcpp::Duration &) override {
    if (!received_ || std::chrono::duration<double>(std::chrono::steady_clock::now()-last_).count() > .6) return hardware_interface::return_type::OK;
    for (size_t i=0; i<commands_.size(); ++i)
      if (!std::isfinite(commands_[i]) || commands_[i] < lower_[i] || commands_[i] > upper_[i]) return hardware_interface::return_type::ERROR;
    std::ostringstream out; out << std::setprecision(17) << "{\"seq\":" << sequence_++ << ",\"time\":" << std::max(0.,time.seconds()) << ",\"positions\":[";
    for (size_t i=0; i<commands_.size(); ++i) { if (i) out << ','; out << commands_[i]; }
    out << "]}"; std_msgs::msg::String message; message.data=out.str(); publisher_->publish(message);
    return hardware_interface::return_type::OK;
  }
};
}
PLUGINLIB_EXPORT_CLASS(ae_motion_hardware::TopicSystem, hardware_interface::SystemInterface)
