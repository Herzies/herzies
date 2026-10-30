import { studioLighting } from "@herzies/shared/gl";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { ambient } from "./ambient";
import { townLook } from "./depth";
import { homeMode } from "./homeMode";
import { townSave } from "./runtime";

/**
 * The layer Home's things are on: your herzie, what's dropped around it,
 * the holes it falls out of. They're drawn with the world as ever, and
 * again (only them) once the world starts fading on the way Home, over it,
 * so they stay as they are while everything else goes (see vfx/homeFade).
 * Settled at Home, they're all that's drawn.
 */
export const HOME_LAYER = 5;

/** Puts `object`, and everything in it, on Home's layer too. */
export function keepAtHome(object: THREE.Object3D): void {
  object.traverse((o) => {
    o.layers.enable(HOME_LAYER);
  });
}

/** Takes it off again (it stays in the world). */
export function dropFromHome(object: THREE.Object3D): void {
  object.traverse((o) => {
    o.layers.disable(HOME_LAYER);
  });
}

/** A light, and its shadow if it casts one. */
type Lit = THREE.Light & { shadow?: THREE.LightShadow };

const WHITE = new THREE.Color(1, 1, 1);
const BLACK = new THREE.Color(0, 0, 0);

/** How often (frames) the lights are looked for again: the day cycle and
 * the lamps come and go with the island. */
const LIGHTS_EVERY = 30;

/**
 * Draws Home's layer over the finished frame, after the composer (which
 * draws at priority 1). Its things get their light from the world's own
 * lights (put on the layer too) and, while the world's still drawn, its
 * shadows: the shadow maps it already drew are kept, so nothing shades
 * differently in the second drawing. Settled at Home, the canvas is cleared
 * to see-through first (the composer's standing down: see Post), and the
 * shadows are only what Home's things cast.
 */
export function HomeLayer() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const frames = useRef(0);
  const clear = useMemo(() => new THREE.Color(), []);
  /** The world's lights (the day cycle's, the lamps'), found now and then. */
  const lights = useRef<Lit[]>([]);
  // Home's own light, which Home always had: the studio's plain white
  // light, from up and to the right of the camera, whatever the hour. The
  // world's light gives way to it as the world fades, so Home at midnight
  // looks as it did at noon.
  const studio = useMemo(() => {
    const hemi = new THREE.HemisphereLight("#e4ecff", "#6c7390", 0);
    const sun = new THREE.DirectionalLight("#ffffff", 0);
    for (const l of [hemi, sun]) {
      l.layers.set(HOME_LAYER);
      l.userData.homeStudio = true;
    }
    return { hemi, sun };
  }, []);
  useEffect(() => {
    scene.add(studio.hemi, studio.sun, studio.sun.target);
    return () => {
      scene.remove(studio.hemi, studio.sun, studio.sun.target);
    };
  }, [scene, studio]);
  const saved = useMemo(
    () => ({
      sun: new THREE.Vector3(),
      light: new THREE.Color(),
      lamp: new THREE.Color(),
      studioSun: new THREE.Vector3(),
      intensity: [] as number[],
      shadow: [] as number[],
    }),
    [],
  );

  useFrame(() => {
    if (!homeMode.overlay) return;
    if (frames.current++ % LIGHTS_EVERY === 0) {
      const found: Lit[] = [];
      scene.traverse((o) => {
        if (!(o as THREE.Light).isLight || o.userData.homeStudio) return;
        o.layers.enable(HOME_LAYER);
        found.push(o as Lit);
      });
      lights.current = found;
    }
    const full = homeMode.full;
    const background = scene.background;
    const autoClear = gl.autoClear;
    const shadows = gl.shadowMap.autoUpdate;
    const look = townLook.z;
    const layers = camera.layers.mask;
    gl.getClearColor(clear);
    const clearAlpha = gl.getClearAlpha();

    scene.background = null;
    gl.autoClear = false;
    gl.setRenderTarget(null);
    if (full) {
      gl.setClearColor(0x000000, 0);
      gl.clear(true, true, true);
    } else {
      gl.clearDepth();
      gl.shadowMap.autoUpdate = false;
    }
    // Drawn straight to the screen, where three tone-maps and encodes
    // itself: the materials mustn't as well (see depth.ts).
    townLook.z = 0;
    camera.layers.set(HOME_LAYER);
    // Lit as Home: the world's light handed over to the studio's.
    const k = homeMode.worldFade;
    const ws = lights.current;
    saved.intensity.length = saved.shadow.length = 0;
    for (const l of ws) {
      saved.intensity.push(l.intensity);
      saved.shadow.push(l.shadow?.intensity ?? 0);
      l.intensity *= 1 - k;
      if (l.shadow) l.shadow.intensity *= 1 - k;
    }
    // The studio's sun, turned with Home's camera (Home's view had its
    // camera on +z).
    const turn = homeMode.azimuth ?? 0;
    const src = studioLighting.uSun.value;
    saved.studioSun.set(
      src.x * Math.cos(turn) + src.z * Math.sin(turn),
      src.y,
      -src.x * Math.sin(turn) + src.z * Math.cos(turn),
    );
    studio.hemi.intensity = 1.6 * k;
    studio.sun.intensity = 1.4 * k;
    studio.sun.target.position.set(townSave.x, 0, townSave.z);
    studio.sun.position
      .copy(saved.studioSun)
      .multiplyScalar(10)
      .add(studio.sun.target.position);
    studio.sun.target.updateMatrixWorld();
    // The herzies' own light (their bands are lit by these, not three's).
    saved.sun.copy(ambient.uSun.value);
    saved.light.copy(ambient.uLight.value);
    saved.lamp.copy(ambient.uLampColor.value);
    ambient.uSun.value.lerp(saved.studioSun, k).normalize();
    ambient.uLight.value.lerp(WHITE, k);
    ambient.uLampColor.value.lerp(BLACK, k);
    gl.render(scene, camera);

    ambient.uSun.value.copy(saved.sun);
    ambient.uLight.value.copy(saved.light);
    ambient.uLampColor.value.copy(saved.lamp);
    studio.hemi.intensity = studio.sun.intensity = 0;
    ws.forEach((l, i) => {
      l.intensity = saved.intensity[i];
      if (l.shadow) l.shadow.intensity = saved.shadow[i];
    });
    camera.layers.mask = layers;
    townLook.z = look;
    gl.shadowMap.autoUpdate = shadows;
    gl.autoClear = autoClear;
    gl.setClearColor(clear, clearAlpha);
    scene.background = background;
  }, 2);

  return null;
}
