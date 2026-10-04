"""Export an explicit public fixture; never export a database or a whole run tree.

Run manually with --source-root and --run-dir for one reviewed reference run.
The published JSON is committed so a Pages build needs no local ROS installation.
Unknown hardware remains unknown. Recorded checks and series are copied, while
navigation/project metadata and explanatory summaries are labelled separately.
"""
from __future__ import annotations

import argparse
import copy
import json
import re
import shutil
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
PUBLIC_PROJECT = "public-sophicore-wave"
PUBLIC_RUN = "public-sophicore-wave-run"
NOTICE = "公开演示：需求保存在当前浏览器；结果来自已完成的右臂参考动作记录。这里不会新生成、编译或运行 ROS。"


def load(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def pick(value, keys):
    return {key: copy.deepcopy(value[key]) for key in keys.split() if key in value}


def sanitize(value):
    """Defence in depth after field allowlists; no runtime paths or sessions."""
    if isinstance(value, dict):
        return {key: sanitize(item) for key, item in value.items()
                if key not in {"source_path", "command", "build_storage", "namespace", "session",
                               "invocation_id", "run_id", "project_id", "prompt", "response",
                               "api_key", "source_content", "trace_file", "output_dir", "root"}}
    if isinstance(value, list):
        return [sanitize(item) for item in value]
    if isinstance(value, str):
        value = re.sub(r"/ae_v5_[0-9a-f]+", "/ae_public_record", value)
        value = re.sub(r"(?:[A-Za-z]:[\\/]|/mnt/[a-z]/|/home/|/tmp/)[^\s\"'<>]+", "[已移除本机路径]", value)
        value = re.sub(r"https?://[^\s\"'<>]*(?:feishu\.cn|larksuite\.com)[^\s\"'<>]*", "[内部资料不公开]", value)
    return value


def safe_structure(value):
    result = pick(value, "id name format warnings source_url mesh_url content_sha256 mapping_source_sha256 source_sha256 model_sha256 simulation_binding assumptions")
    result["links"] = [pick(link, "name mesh_ids mesh_origin_m visuals mass center_of_mass inertia") for link in value["links"]]
    result["joints"] = [pick(joint, "name label initial_position source_parameter type parent child xyz rpy origin limits axis lower upper") for joint in value["joints"]]
    if result.get("id") == "sophicore-reference":
        result["mesh_url"] = "structure.json"
    return sanitize(result)


def safe_execution(value):
    result = pick(value, "schema_version model_id source_sha256 kinematics_sha256 root_link held_positions units physics_profile assumptions hardware_verified active_joint_names model_sha256")
    result["selected_joint"] = "arm_r_shoulder_lift"
    result["links"] = [pick(item, "name mesh_ids mesh_origin_m visuals mass center_of_mass inertia") for item in value["links"]]
    result["joints"] = [pick(item, "name label initial_position type parent child xyz rpy origin limits axis lower upper") for item in value["joints"]]
    return sanitize(result)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, default=REPO, help="Source-only project with public knowledge files")
    parser.add_argument("--run-dir", type=Path, required=True, help="Exactly one reviewed attempt directory; read only")
    parser.add_argument("--assets-dir", type=Path, help="Existing sanitized structure.json and model.bin")
    args = parser.parse_args()
    root, attempt = args.source_root.resolve(), args.run_dir.resolve()
    sys.path.insert(0, str(root))
    from server.structures import builtins
    from server.motion_v5 import motion_recipe, deterministic_plan, assess_motion
    from server.schemas import TASKS
    from server.workflow import default_workflow
    from worker.contract import project_contract

    raw = load(attempt / "spec-used.json")
    recorded = load(attempt / "result.json")
    if raw.get("pipeline_version") != 5 or raw.get("prd", {}).get("intake", {}).get("motion_plan", {}).get("recipe_id") != "sophicore-right-wave-v1":
        raise ValueError("Only the explicitly reviewed Sophicore right-wave reference may be exported")
    if not recorded.get("passed") or len(recorded["checks"]) != 112 or not all(x["passed"] for x in recorded["checks"]):
        raise ValueError("Expected the reviewed 112-check reference record, without changing its result")
    if recorded.get("physical_verified") or recorded.get("esp32_execution_verified") or recorded.get("flashed"):
        raise ValueError("This public fixture is scoped to software simulation and firmware compilation")

    structures = [safe_structure(item) for item in builtins(root)]
    structure = next(item for item in structures if item["id"] == "sophicore-reference")
    structure["mapping_source_sha256"] = raw["prd"]["intake"]["motion_plan"]["model_source_sha256"]
    project = pick(raw, "task_type parameters hardware pipeline_version workflow communication simulation manifest")
    project.update(id=PUBLIC_PROJECT, name="Sophicore · 右臂招手三次", request="让机器人抬起右手，招手三次，最后把手臂放到身体旁边。",
                   spec_revision=1, status="passed", latest_run_id=PUBLIC_RUN,
                   created_at="2026-10-04T06:07:00Z", updated_at="2026-10-04T06:14:00Z", error=None,
                   structure=structure, execution_model=safe_execution(raw["execution_model"]),
                   motion_program=pick(raw["motion_program"], "schema_version joint_names initial_positions waypoints tolerance_rad max_velocity_rad_s max_acceleration_rad_s2 timeout_s interpolation model_sha256 program_sha256"))
    # This is a fixed public reference specification, not personal project data.
    original_intake = raw["prd"]["intake"]
    intake = pick(original_intake, "schema_version mode intent answers details motion_plan")
    # V5's original empty supplemental groups mean the fixed platform defaults.
    # Make this selection explicit for the browser-only beginner summary. These
    # are display explanations of the recorded fixed contract, not new hardware.
    intake["details"]["motion"].update(pattern="from_answers", completion="all")
    intake["details"]["device_mapping"]["scope"] = "simulation_only"
    for group in ("lifecycle", "coordinates", "communication", "faults", "acceptance", "environment"):
        intake["details"][group]["selection"] = "platform"
    intake["hardware_notes"] = {key: {"value": "", "source": "", "status": "unknown"}
                                for key in ("board_model", "flash_psram", "motor_model", "driver_model", "feedback_model", "supply", "wiring", "docs")}
    intake["accepted_suggestions"] = []
    project["prd"] = dict(use_case="右臂多关节参考动作与通信流程演示", environment="desktop_simulation",
                          constraints="固定底座、零重力、无碰撞接触；没有实物或板上执行验证。",
                          acceptance="核对 8 个路点、3 次完整往返、结束姿势及通信异常；查看已有 112 项检查。",
                          structure_id="sophicore-reference", joint_name="arm_r_shoulder_lift", intake=intake)
    project = sanitize(project)
    # The public IDs are deliberate navigation aliases, never local run IDs.
    project["id"], project["latest_run_id"] = PUBLIC_PROJECT, PUBLIC_RUN
    # Readiness was assessed against the unchanged fixed execution input.
    readiness_spec = copy.deepcopy(raw)
    readiness_spec.update(name=project["name"], request=project["request"])
    project["intake_readiness"] = sanitize(assess_motion(root, readiness_spec)[0])
    # Validate the unchanged recorded model before projecting its public fields.
    # Sanitized display metadata is not used to revalidate the frozen SHA.
    planning_spec = copy.deepcopy(raw)
    planning_spec.update(name=project["name"], request=project["request"], prd=project["prd"])
    plan = sanitize(deterministic_plan(planning_spec, []))
    plan["summary"] = "已核对参考动作的固定模板分工说明；下面的构建与仿真结果来自已有记录。"
    plan["plan_id"] = "public-reference-plan"
    plan["requirement_coverage"]["items"] = [item for item in plan["requirement_coverage"]["items"]
                                            if not item["source_field"].startswith("prd.intake.details.")]
    for item in plan["requirement_coverage"]["items"]:
        item["reason"] = "这行是公开参考规格的说明对应；真实数值验收请查看已记录的路点、往返和通信检查。"
    plan["requirement_coverage"]["scope"] = "参考动作分工说明；空白补充要求不列为已验收项。"
    plan["provenance"] = {"tool": "sophicore-taskprogram-v5.1", "ai_generated": False,
                          "kind": "deterministic_motion_program", "source": "公开参考规格与固定模板；未调用在线 AI"}
    project["plan"] = plan
    project["approval"] = {"spec_revision": 1, "plan_id": "public-reference-plan", "scope": "历史参考规格核对；不代表访问者已审批"}

    checks = [sanitize(pick(item, "name passed detail")) for item in recorded["checks"]]
    result = pick(recorded, "passed engine ros_verified physics_simulation_verified physical_verified esp32_execution_verified flashed execution_order joint_names scope")
    result["checks"] = checks
    result["series"] = [pick(item, "time t value target command positions targets velocities stage_id cycle_index") for item in recorded["series"]]
    # The scalar plotting fields are a view of the first recorded joint, not a new measurement.
    first_joint = raw["motion_program"]["joint_names"][0]
    for row in result["series"]:
        row.setdefault("value", row.get("positions", {}).get(first_joint, 0))
        row.setdefault("target", row.get("targets", {}).get(first_joint, 0))
    result["motion_program"] = project["motion_program"]
    result["metrics"] = {"cases": [sanitize(pick(case, "name motion_completed waypoints_reached total_waypoints completed_cycles expected_cycles waypoints cycle_evidence duration_s"))
                                    for case in recorded["metrics"]["cases"]], "cleanup": {"all_exited": recorded["metrics"]["cleanup"]["all_exited"]}}
    result["firmware"] = pick(recorded["firmware"], "passed core_version flashed esp32_execution_verified physical_verified board fqbn")
    result["firmware"]["boards"] = [pick(board, "board fqbn exit_code passed elapsed_s") for board in recorded["firmware"]["boards"]]
    result["firmware"]["compiled"] = True
    result["esp32_status"] = "compiled"
    result["communication_test"] = {"passed": recorded["communication_test"]["passed"],
                                    "checks": [pick(item, "name passed detail") for item in recorded["communication_test"]["checks"]],
                                    "scope": "ROS ↔ 主机虚拟串口 ↔ 同源固件核心；不是 ESP32 芯片执行或实物通信"}
    result = sanitize(result)

    files = {}
    # These are actual generated source files only. Logs, binary/ELF/map files,
    # raw trace/session files and arbitrary other files are intentionally excluded.
    allowed_files = ["algorithm.py", "device_logic.cpp", "esp32/ae_firmware_v5/ae_firmware_v5.ino",
                     "esp32/ae_firmware_v5/protocol_core_v5.hpp", "esp32/ae_firmware_v5/model_binding_v5.hpp",
                     "ros_ws/src/ae_generated/package.xml", "ros_ws/src/ae_generated/setup.py",
                     "ros_ws/src/ae_generated/ae_generated/motion_task.py",
                     "ros_ws/src/ae_generated/ae_generated/serial_bridge.py",
                     "ros_ws/src/ae_generated/ae_generated/gazebo_motion.py",
                     "ros_ws/src/ae_generated/launch/bench.launch.py"]
    for relative in allowed_files:
        file = attempt / relative
        if file.is_file():
            content = file.read_text(encoding="utf-8-sig")
            # Keep code readable, but do not expose internal runtime namespaces or paths.
            files[relative] = sanitize(content)
    files["motion-program.json"] = json.dumps(project["motion_program"], ensure_ascii=False, indent=2)
    files["communication.json"] = json.dumps({"communication": project["communication"], "simulation": project["simulation"]}, ensure_ascii=False, indent=2)
    files["public-verification-summary.json"] = json.dumps({"notice": NOTICE, "result_origin": "recorded_reference_run",
                                                           "checks": checks, "metrics": result["metrics"], "firmware": result["firmware"]}, ensure_ascii=False, indent=2)
    run = dict(id=PUBLIC_RUN, project_id=PUBLIC_PROJECT, status="passed", attempt=1,
               created_at=project["created_at"], updated_at=project["updated_at"], spec_snapshot=project,
               plan_snapshot=plan, approval=project["approval"], events=[], result=result,
               artifacts=[{"path": path, "size": len(content.encode("utf-8"))} for path, content in files.items()],
               error=None, code_versions=[{"attempt": 1, "ai_generated": False,
                   "code": files["algorithm.py"],
                   "firmware_code": files["device_logic.cpp"],
                   "ros_path": "algorithm.py",
                   "esp_path": "device_logic.cpp",
                   "source": "实际已生成参考工程；脱敏展示摘录"}], provenance=[{"tool": "固定代码模板", "ai_generated": False,
                  "source": "已有参考动作工程的公开源码摘录；不含历史私人提示词、数据库或完整日志"}], deployment=None)
    recipes = {}
    for side in ("right", "left"):
        for cycles in range(1, 11):
            recipe = sanitize(motion_recipe(root, "sophicore-reference", side, cycles))
            recipe["notes"].append("这是可编辑的模型参考；公开验收记录只对应右臂招手三次，修改后不沿用旧结果。")
            recipes[f"sophicore-reference:{side}:{cycles}"] = recipe
    sources = []
    for source in load(root / "knowledge/sources.json")["items"]:
        item = sanitize(pick(source, "id title url version content tags license checked_at board ros_distro content_kind verification_status warnings source_hash"))
        item.update(origin="builtin", uploaded=False)
        sources.append(item)
    environment = {"ros_distro": "humble", "os": "历史记录：Ubuntu 22.04 / WSL2", "mode": "公开演示 · 不连接本机服务",
                   "hardware_connected": False, "demo": True, "probe": {}}
    catalog = {"tasks": TASKS, "boards": [{"id": "esp32", "label": "ESP32 通用编译目标", "fqbn": "esp32:esp32:esp32"},
                                          {"id": "esp32s3", "label": "ESP32-S3 通用编译目标", "fqbn": "esp32:esp32:esp32s3"}],
               "hardware_options": [{"id": "simulated", "label": "模拟设备（没有接线）"}],
               "actuators": [{"id": "virtual_joint", "label": "虚拟关节"}, {"id": "virtual_switch", "label": "虚拟开关"}],
               "sensors": [{"id": "simulated_encoder", "label": "模拟位置反馈"}, {"id": "simulated_scalar", "label": "模拟数值传感器"}],
               "transports": [{"id": "serial_jsonl", "label": "虚拟串口 JSONL"}], "environment": environment,
               "default_workflow": default_workflow(), "supported_pipeline_versions": [3, 5], "pipeline_version": 5, **project_contract()}
    bundle = dict(schema_version=1, catalog=sanitize(catalog), settings={"provider": "openai", "model": "公开演示（未接入 AI）",
                  "base_url": "", "key_configured": False, "codex_available": False, "key_storage": "演示页不收集或保存 API 密钥"},
                  environment=environment, structures=structures, projects=[project], runs=[run], sources=sources, recipes=recipes,
                  files={PUBLIC_RUN: files}, knowledge_stats={"documents": len(sources), "mode": "public_fixture", "notice": "公开资料目录；浏览器筛选，不运行服务端 RAG 检索。"},
                  provenance={"scope": NOTICE, "project_metadata": "reconstructed_public_navigation", "series_and_checks": "recorded_reference_run",
                              "events": "omitted", "private_storage": "never_read"})
    output = REPO / "web/public"
    output.mkdir(parents=True, exist_ok=True)
    assets = args.assets_dir or (output if (output / "model.bin").exists() else REPO / "docs")
    for name in ("structure.json", "model.bin"):
        source = assets / name
        if source.resolve() != (output / name).resolve():
            shutil.copyfile(source, output / name)
    serialized = json.dumps(bundle, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    forbidden = [r"(?<![A-Za-z])[A-Za-z]:\\\\", r"/mnt/[a-z]/", r"/home/", r"/tmp/ae-", r"/ae_v5_[0-9a-f]", r"https?://[^\s\"]*(?:feishu\.cn|larksuite\.com)", r"sk-proj-", r"github_pat_", r"ghp_"]
    for pattern in forbidden:
        if re.search(pattern, serialized):
            raise ValueError("Public privacy scan rejected pattern: " + pattern)
    (output / "public-demo.json").write_text(serialized + "\n", encoding="utf-8")
    print(json.dumps({"exported": True, "projects": len(bundle["projects"]), "runs": len(bundle["runs"]),
                      "checks": len(checks), "samples": len(result["series"]), "recipes": len(recipes),
                      "sources": len(sources), "files": len(files), "privacy_patterns_checked": len(forbidden)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
