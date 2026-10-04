import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  ArrowCounterClockwise,
  CircleNotch,
  Cube,
  Pause,
  Play,
} from "@phosphor-icons/react";
import type { Structure } from "./api";
import { jointBounds } from "./modelView";

interface SourceModel {
  meshes: {
    id: number;
    name: string;
    positions: number[];
    indices: number[];
    color?: number[];
  }[];
  metadata: { source?: string; sha256?: string; units?: string };
}
type Point = { time: number; value: number; target: number; command: number };
export default function StructureView({
  structure,
  jointName,
  target = 0,
  series,
  vectorSeries,
  previewPositions,
}: {
  structure: Structure;
  jointName?: string | null;
  target?: number;
  series?: Point[];
  vectorSeries?: {
    time: number;
    positions: Record<string, number>;
    stage_id?: string;
    cycle_index?: number;
  }[];
  previewPositions?: Record<string, number>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const pose = useRef<
    (name: string, value: number, positions?: Record<string, number>) => void
  >(() => {});
  const reset = useRef<() => void>(() => {});
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [mesh, setMesh] = useState<SourceModel | null>(null);
  const [angle, setAngle] = useState(target);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const movable = structure.joints?.filter((j) => j.type !== "fixed") || [];
  const joint = movable.find((j) => j.name === jointName) || movable[0];
  const replay = !!joint && (!!series?.length || !!vectorSeries?.length);
  const frames = vectorSeries?.length ? vectorSeries : series;
  const { lower, upper } = jointBounds(joint);
  useEffect(() => {
    setAngle(Math.max(lower, Math.min(upper, target)));
    setFrame(0);
    setPlaying(false);
  }, [structure.id, joint?.name, target, lower, upper]);
  useEffect(() => {
    const controller = new AbortController();
    setMesh(null);
    setError("");
    if (!structure.mesh_url) {
      setLoading(false);
      return;
    }
    setLoading(true);
    fetch(structure.mesh_url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(`结构模型读取失败（${response.status}）`);
        const data = (await response.json()) as SourceModel;
        if (!Array.isArray(data.meshes) || !data.meshes.length)
          throw new Error("模型没有可显示的网格");
        if (!controller.signal.aborted) setMesh(data);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError((e as Error).message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [structure.id, structure.mesh_url]);
  useEffect(() => {
    if (!host.current || (structure.mesh_url && !mesh)) return;
    const container = host.current;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    } catch {
      setError("当前浏览器无法开启 3D 显示。结构信息仍可查看。");
      return;
    }
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#101518");
    const camera = new THREE.PerspectiveCamera(38, 1, 0.001, 1000);
    camera.up.set(0, 0, 1);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.setAttribute(
      "aria-label",
      `${structure.name}，拖动旋转，滚轮缩放`,
    );
    renderer.domElement.setAttribute("role", "img");
    container.append(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.09;
    scene.add(new THREE.HemisphereLight(0xdce9f2, 0x39423c, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 3.2);
    key.position.set(4, -4, 7);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xe87b61, 0.8);
    fill.position.set(-3, 4, 2);
    scene.add(fill);
    const group = new THREE.Group();
    scene.add(group);
    const links = new Map<string, THREE.Group>();
    const joints = new Map<
      string,
      { object: THREE.Group; axis: THREE.Vector3; type: string }
    >();
    for (const link of structure.links || []) {
      const node = new THREE.Group();
      node.name = link.name;
      links.set(link.name, node);
      for (const visual of mesh && link.mesh_ids?.length
        ? []
        : link.visuals || []) {
        const size = visual.size || [0.1, 0.1, 0.1];
        const geometry =
          visual.type === "cylinder"
            ? new THREE.CylinderGeometry(
                visual.radius || 0.05,
                visual.radius || 0.05,
                visual.length || 0.1,
                32,
              )
            : visual.type === "sphere"
              ? new THREE.SphereGeometry(visual.radius || 0.05, 24, 16)
              : new THREE.BoxGeometry(size[0], size[1], size[2]);
        if (visual.type === "cylinder") geometry.rotateX(Math.PI / 2);
        const color = visual.color || [0.65, 0.71, 0.75, 1];
        const part = new THREE.Mesh(
          geometry,
          new THREE.MeshStandardMaterial({
            color: new THREE.Color(color[0], color[1], color[2]),
            metalness: 0.25,
            roughness: 0.45,
            transparent: (color[3] ?? 1) < 1,
            opacity: color[3] ?? 1,
          }),
        );
        part.position.fromArray(visual.xyz || [0, 0, 0]);
        const [r, p, y] = visual.rpy || [0, 0, 0];
        part.rotation.set(r, p, y, "ZYX");
        node.add(part);
      }
    }
    if (mesh) {
      const scale = mesh.metadata?.units?.toLowerCase() === "m" ? 1 : 0.001;
      const owners = new Map<number, Structure["links"][number]>();
      for (const link of structure.links)
        for (const id of link.mesh_ids || []) owners.set(id, link);
      for (const source of mesh.meshes) {
        if (!source.positions?.length || !source.indices?.length) continue;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
          "position",
          new THREE.Float32BufferAttribute(source.positions, 3),
        );
        geometry.setIndex(source.indices);
        geometry.scale(scale, scale, scale);
        const owner = owners.get(source.id);
        if (owner) {
          const origin = owner.mesh_origin_m || [0, 0, 0];
          geometry.translate(-origin[0], -origin[1], -origin[2]);
        }
        geometry.computeVertexNormals();
        const rgb = source.color || [0.65, 0.69, 0.71],
          divisor = Math.max(...rgb.slice(0, 3)) > 1 ? 255 : 1;
        const part = new THREE.Mesh(
          geometry,
          new THREE.MeshStandardMaterial({
            color: new THREE.Color(
              rgb[0] / divisor,
              rgb[1] / divisor,
              rgb[2] / divisor,
            ),
            metalness: 0.32,
            roughness: 0.48,
          }),
        );
        part.name = source.name;
        if (owner) links.get(owner.name)!.add(part);
        else group.add(part);
      }
    }
    const childNames = new Set<string>();
    for (const definition of structure.joints || []) {
      const parent = links.get(definition.parent),
        child = links.get(definition.child);
      if (!parent || !child || parent === child) continue;
      const origin = new THREE.Group();
      origin.position.fromArray(
        definition.origin?.xyz || definition.xyz || [0, 0, 0],
      );
      const [r, p, y] = definition.origin?.rpy || definition.rpy || [0, 0, 0];
      origin.rotation.set(r, p, y, "ZYX");
      const moving = new THREE.Group();
      origin.add(moving);
      parent.add(origin);
      moving.add(child);
      childNames.add(definition.child);
      const axis = new THREE.Vector3()
        .fromArray(definition.axis || [0, 0, 1])
        .normalize();
      joints.set(definition.name, {
        object: moving,
        axis,
        type: definition.type,
      });
    }
    for (const [name, node] of links)
      if (!childNames.has(name)) group.add(node);
    const setJoint = (name: string, value: number) => {
      const selected = joints.get(name);
      if (!selected) return;
      if (selected.type === "prismatic")
        selected.object.position.copy(selected.axis).multiplyScalar(value);
      else if (selected.type !== "fixed")
        selected.object.quaternion.setFromAxisAngle(selected.axis, value);
    };
    pose.current = (name, value, positions) => {
      for (const definition of structure.joints)
        setJoint(definition.name, definition.initial_position || 0);
      if (positions)
        Object.entries(positions).forEach(([axis, actual]) =>
          setJoint(axis, actual),
        );
      else setJoint(name, value);
    };
    for (const definition of structure.joints)
      setJoint(definition.name, definition.initial_position || 0);
    const box = new THREE.Box3().setFromObject(group);
    const center = box.isEmpty()
      ? new THREE.Vector3()
      : box.getCenter(new THREE.Vector3());
    const size = box.isEmpty()
      ? new THREE.Vector3(1, 1, 1)
      : box.getSize(new THREE.Vector3());
    const extent = Math.max(size.x, size.y, size.z, 0.2);
    const grid = new THREE.GridHelper(extent * 3, 24, 0x48514f, 0x263034);
    grid.rotation.x = Math.PI / 2;
    grid.position.set(
      center.x,
      center.y,
      box.isEmpty() ? 0 : box.min.z - 0.002,
    );
    scene.add(grid);
    const axes = new THREE.AxesHelper(extent * 0.22);
    axes.position.copy(grid.position);
    scene.add(axes);
    reset.current = () => {
      controls.target.copy(center);
      camera.position.set(
        center.x + extent * 1.2,
        center.y - extent * 1.65,
        center.z + extent * 0.9,
      );
      camera.near = Math.max(0.001, extent / 1000);
      camera.far = extent * 100;
      camera.updateProjectionMatrix();
      controls.update();
    };
    reset.current();
    const observer = new ResizeObserver(() => {
      const width = container.clientWidth,
        height = container.clientHeight;
      if (!width || !height) return;
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    });
    observer.observe(container);
    const onLost = (event: Event) => {
      event.preventDefault();
      setError("3D 显示连接已中断，请重新选择结构。");
    };
    renderer.domElement.addEventListener("webglcontextlost", onLost);
    renderer.setAnimationLoop(() => {
      controls.update();
      renderer.render(scene, camera);
    });
    return () => {
      pose.current = () => {};
      reset.current = () => {};
      observer.disconnect();
      controls.dispose();
      renderer.setAnimationLoop(null);
      scene.traverse((object) => {
        const drawable = object as THREE.Mesh;
        drawable.geometry?.dispose();
        const materials = drawable.material
          ? Array.isArray(drawable.material)
            ? drawable.material
            : [drawable.material]
          : [];
        materials.forEach((material) => material.dispose());
      });
      renderer.domElement.removeEventListener("webglcontextlost", onLost);
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [structure, mesh]);
  useEffect(() => {
    if (joint)
      pose.current(
        joint.name,
        replay ? (series?.[frame]?.value ?? 0) : angle,
        vectorSeries?.[frame]?.positions || previewPositions,
      );
  }, [
    joint,
    angle,
    frame,
    replay,
    series,
    vectorSeries,
    previewPositions,
    mesh,
    structure,
  ]);
  useEffect(() => {
    if (!playing || !replay || !frames) return;
    const timer = setTimeout(
      () => {
        if (frame >= frames.length - 1) setPlaying(false);
        else setFrame(frame + 1);
      },
      Math.max(
        16,
        ((frames[frame + 1]?.time ?? 0) - frames[frame].time) * 1000,
      ),
    );
    return () => clearTimeout(timer);
  }, [playing, replay, frame, frames]);
  return (
    <div className="structure-view">
      <div className="viewer-toolbar">
        <span>
          <Cube size={16} />
          {mesh
            ? structure.format === "sophicore-kinematic"
              ? "Sophicore 关节结构"
              : "原站结构参考"
            : structure.id.startsWith("builtin-")
              ? "内置测试模型"
              : "导入结构预览"}
        </span>
        <button
          className="icon-button"
          aria-label="重置3D视角"
          onClick={() => reset.current()}
        >
          <ArrowCounterClockwise size={17} />
        </button>
      </div>
      <div className="viewer-canvas" ref={host} />
      {(loading || error) && (
        <div className="viewer-overlay">
          {loading ? (
            <>
              <CircleNotch className="spin" size={27} />
              <strong>正在读取原站结构</strong>
              <p>首次需加载约 58 MB 网格。</p>
            </>
          ) : (
            <>
              <Cube size={27} />
              <p>{error}</p>
            </>
          )}
        </div>
      )}
      <div className="viewer-caption">
        <span>拖动旋转 · 滚轮缩放</span>
        <span>
          {mesh
            ? `${mesh.meshes.length} 个部件 · 模型姿态预览`
            : "结构预览，未驱动实物"}
        </span>
      </div>
      {replay ? (
        <div className="viewer-controls">
          <button
            className="icon-button"
            aria-label={playing ? "暂停轨迹回放" : "播放轨迹回放"}
            onClick={() => {
              if (frame === frames!.length - 1) setFrame(0);
              setPlaying(!playing);
            }}
          >
            {playing ? <Pause size={17} /> : <Play size={17} />}
          </button>
          <input
            type="range"
            aria-label="运行轨迹时间"
            min={0}
            max={frames!.length - 1}
            value={frame}
            onChange={(e) => {
              setPlaying(false);
              setFrame(Number(e.target.value));
            }}
          />
          <span>{(frames![frame]?.time ?? 0).toFixed(2)} s</span>
          <small>
            {vectorSeries?.length
              ? `计划阶段 ${vectorSeries[frame]?.stage_id || "未记录"} · 计划往返 ${vectorSeries[frame]?.cycle_index ?? 0} · 全组实际角度`
              : `${joint?.label || joint?.name} · 本轮绝对角度`}
          </small>
        </div>
      ) : previewPositions ? (
        <div className="viewer-controls">
          <small>全组目标姿势预览 · 仅供人工核对，尚未运行</small>
        </div>
      ) : (
        joint && (
          <div className="viewer-controls">
            <label htmlFor={`pose-${structure.id}`}>关节预览</label>
            <input
              id={`pose-${structure.id}`}
              type="range"
              min={lower}
              max={upper}
              step={0.005}
              value={angle}
              onChange={(e) => setAngle(Number(e.target.value))}
            />
            <span>
              {angle.toFixed(2)} {joint.type === "prismatic" ? "m" : "rad"}
            </span>
            <small>
              {joint?.label || joint?.name} · 只看姿态，不修改任务目标
            </small>
          </div>
        )
      )}
    </div>
  );
}
