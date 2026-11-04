import "./globals.css";
import { HerzieModel, WALK_SPEED } from "@herzies/shared/gl";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import * as THREE from "three";

/**
 * Dev only (`vite dev`, /cat-lab.html): Sleptwell, the cat spirit, up close,
 * to tune how it moves (gl/cat.ts, gl/catModel.ts). A herzie runs a script
 * of walks, turns and stops while the camera keeps the cat in frame.
 *  ?cam=side|front|top|back  where the camera looks from (default side)
 *  ?dist=3                   how far off it is
 *  ?afk=40                   seconds in when the herzie goes away (sleep)
 *  ?fetch=20                 seconds in when it's sent to fetch something
 *  ?hills=1                  rolling ground
 *  ?water=1                  a pond across its way (x 4..8)
 * `lab.t` is the script's time.
 */
const params = new URLSearchParams(location.search);
const cam = params.get("cam") ?? "side";
const dist = Number(params.get("dist") ?? 3);
const afkAt = Number(params.get("afk") ?? 1e9);
const fetchAt = Number(params.get("fetch") ?? 1e9);
const hills = params.get("hills") === "1";
const water = params.get("water") === "1";

const groundAt = (x: number, z: number) =>
  hills ? Math.sin(x * 0.35) * 0.5 + Math.cos(z * 0.3) * 0.4 : 0;
const walkable = (x: number, z: number) =>
  !(water && x > 4 && x < 8 && z > -6 && z < 6);

/** The herzie's script: [until (s), speed (× walk), turn rate (rad/s)]. */
const SCRIPT: [number, number, number][] = [
  [1.5, 0, 0],
  [5, 1, 0],
  [6.2, 1, 1.3],
  [8.5, 1, 0],
  [9, 0, 0],
  [11, 0, 2.5],
  [13, 0.45, 0],
  [30, 0, 0],
  [33, 1.2, 0.4],
  [1e9, 0, 0],
];

const lab = { t: 0 };
Object.assign(window, { lab });

function Lab() {
  const herzie = useMemo(
    () =>
      new HerzieModel({
        seed: "cat-lab",
        stage: 3,
        equipped: { spirit: "sleptwell" },
      }),
    [],
  );
  useEffect(() => {
    herzie.groundAt = groundAt;
    herzie.walkable = walkable;
    return () => herzie.dispose();
  }, [herzie]);
  const camera = useThree((s) => s.camera);
  const mouth = useMemo(() => new THREE.Vector3(), []);
  const at = useMemo(() => new THREE.Vector3(), []);
  useFrame((_, frameDt) => {
    const dt = Math.min(frameDt, 1 / 20);
    lab.t += dt;
    const step = SCRIPT.find(([until]) => lab.t < until) ?? SCRIPT[0];
    const speed = step[1] * WALK_SPEED;
    herzie.heading += step[2] * dt;
    const p = herzie.root.position;
    p.x += Math.sin(herzie.heading) * speed * dt;
    p.z += Math.cos(herzie.heading) * speed * dt;
    p.y = groundAt(p.x, p.z);
    herzie.afk = lab.t > afkAt;
    if (lab.t > fetchAt && lab.t < fetchAt + 6)
      herzie.fetch(new THREE.Vector3(p.x - 5, 0, p.z + 3));
    else if (lab.t >= fetchAt + 6) herzie.fetch(null);
    herzie.update(dt, speed);
    // The camera keeps the cat in frame, from the side asked.
    herzie.companionPosition(mouth);
    at.lerp(mouth, at.lengthSq() === 0 ? 1 : 1 - Math.exp(-4 * dt));
    const o =
      cam === "front"
        ? [0, 0.6, dist]
        : cam === "top"
          ? [0.01, dist * 1.4, 0]
          : cam === "back"
            ? [0, 0.8, -dist]
            : [-dist, 0.5, 0.01];
    camera.position.set(at.x + o[0], at.y + o[1], at.z + o[2]);
    camera.lookAt(at.x, at.y - 0.15, at.z);
  });
  return <primitive object={herzie.root} />;
}

function Ground() {
  const geometry = useMemo(() => {
    const g = new THREE.PlaneGeometry(80, 80, 160, 160);
    g.rotateX(-Math.PI / 2);
    const pos = g.getAttribute("position");
    const colors: number[] = [];
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      pos.setY(i, groundAt(x, z));
      const wet = !walkable(x, z);
      const check = (Math.floor(x) + Math.floor(z)) & 1;
      colors.push(
        ...(wet
          ? [0.25, 0.45, 0.7]
          : check
            ? [0.38, 0.55, 0.3]
            : [0.34, 0.5, 0.27]),
      );
    }
    g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    g.computeVertexNormals();
    return g;
  }, []);
  return (
    <mesh geometry={geometry}>
      <meshLambertMaterial vertexColors flatShading />
    </mesh>
  );
}

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <div style={{ position: "fixed", inset: 0 }}>
      <Canvas camera={{ fov: 45, near: 0.05 }}>
        <color attach="background" args={["#a9cbe6"]} />
        <hemisphereLight args={["#ffffff", "#556644", 1.2]} />
        <directionalLight position={[-10, 20, 8]} intensity={1.2} />
        <Ground />
        <Lab />
      </Canvas>
    </div>,
  );
