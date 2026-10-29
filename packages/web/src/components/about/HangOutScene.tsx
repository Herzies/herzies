"use client";

import { SH, SpeechBubble } from "@herzies/shared";
import { HerzieModel, islandScenery, turnToward } from "@herzies/shared/gl";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import * as THREE from "three";
import {
  frameIslandCamera,
  ISLAND_COLS,
  ISLAND_GROUND,
  islandBox,
  islandSun,
} from "./island";
import { useSceneStage } from "./sceneStage";

// The beat sheet, in ms: a stage 2 herzie stands listening to music (in its
// headphones, dancing). A stage 1 herzie walks in, stops, and they say hi,
// then bye, in the Town's chat bubbles; it walks off again. Then again.

/** Where the listener stands, and where the visitor walks in from and
 * stops. */
const LISTENER_X = -1.3;
const VISITOR_FROM = 2.6;
const VISITOR_STOP = 1.35;
const WALK_SPEED = 2.8;
/** Fading in and out at the island's edge. */
const EDGE_FADE = 0.45;
const WALK_MS = ((VISITOR_FROM - VISITOR_STOP) / WALK_SPEED) * 1000;

const ENTER_AT = 600;
const ARRIVE_AT = ENTER_AT + WALK_MS;
/** Who says what, when, and for how long (ms after arriving). */
const LINES: { who: "visitor" | "listener"; text: string; at: number }[] = [
  { who: "visitor", text: "hi", at: 350 },
  { who: "listener", text: "hi", at: 1350 },
  { who: "visitor", text: "bye", at: 3000 },
  { who: "listener", text: "bye", at: 3900 },
];
const LINE_MS = 1300;
const LEAVE_AT = ARRIVE_AT + 4500;
const LOOP_MS = LEAVE_AT + WALK_MS + 1500;

/** Facing the way it walks, and each other when talking (radians; +x is
 * π/2). */
const FACE_LEFT = -Math.PI / 2;
const FACE_RIGHT = Math.PI / 2;
const LISTENER_HEADING = 0.7;
const VISITOR_TALKING = -0.8;

type Line = { who: "visitor" | "listener"; text: string } | null;

/** What's being said `ms` into the loop, by each of them. */
function linesAt(ms: number): {
  visitor: string | null;
  listener: string | null;
} {
  const out = {
    visitor: null as string | null,
    listener: null as string | null,
  };
  for (const l of LINES) {
    const t = ms - ARRIVE_AT - l.at;
    if (t >= 0 && t < LINE_MS) out[l.who] = l.text;
  }
  return out;
}

/**
 * Two herzies hanging out on an island: one listening to music, another
 * dropping by to say hi and bye, over and over. Drawn on the page's shared
 * herzie stage, framed like the other islands (see island.ts), with the
 * Town's chat bubbles over their heads. Starts over each time it comes on
 * screen, and holds still off it.
 */
export function HangOutScene({
  listenerSeed,
  visitorSeed,
  size,
  active,
}: {
  listenerSeed: string;
  visitorSeed: string;
  size: number;
  active: boolean;
}) {
  const [stage, box] = useSceneStage();
  const bubbles = useRef<Record<"visitor" | "listener", HTMLDivElement | null>>(
    {
      visitor: null,
      listener: null,
    },
  );
  const [said, setSaid] = useState<{
    visitor: string | null;
    listener: string | null;
  }>({ visitor: null, listener: null });
  const { width, height } = islandBox(size);
  const live = useRef({ active, groundInset: height * ISLAND_GROUND });
  live.current.active = active;
  live.current.groundInset = height * ISLAND_GROUND;
  const restart = useRef(false);
  useEffect(() => {
    if (active) restart.current = true;
  }, [active]);

  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const scene = new THREE.Scene();
    scene.add(islandScenery(), islandSun());
    const look = { layoutCols: ISLAND_COLS, layoutRows: SH, anchorScenery: 0 };
    const listener = new HerzieModel(
      { seed: listenerSeed, stage: 2, equipped: { head: "headphones" } },
      { ...look, seed: 1 },
    );
    listener.root.position.set(LISTENER_X, 0, 0);
    listener.heading = LISTENER_HEADING;
    listener.dancing = true;
    const visitor = new HerzieModel(
      { seed: visitorSeed, stage: 1 },
      { ...look, seed: 2 },
    );
    // Out of sight until it walks in (see the frame loop).
    visitor.root.visible = false;
    scene.add(listener.root, visitor.root);

    const cam = new THREE.PerspectiveCamera(50, 1, 0.05, 100);
    const head = new THREE.Vector3();
    let clock = 0;
    let tint = -1;
    let shown: Line[] = [null, null];
    let heading = FACE_LEFT;

    /** Puts a bubble over a herzie's head (in the box's px). */
    const place = (
      el: HTMLDivElement | null,
      model: HerzieModel,
      w: number,
      h: number,
    ) => {
      if (!el) return;
      model.root.getWorldPosition(head);
      head.y += model.height + 0.15;
      head.project(cam);
      const x = ((head.x + 1) / 2) * w;
      const y = ((1 - head.y) / 2) * h;
      el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
    };

    const remove = stage.add({
      element,
      scene,
      camera: cam,
      idle: () => !live.current.active,
      update(dt, w, h) {
        // Framed even while it holds still: the stage can draw it just off
        // screen (scrolling with the page, it draws a margin).
        frameIslandCamera(cam, w, h, live.current.groundInset);
        if (!live.current.active) return;
        if (restart.current) {
          restart.current = false;
          clock = 0;
        }
        clock += dt * 1000;
        if (clock >= LOOP_MS) clock = 0;

        // The visitor: walking in, standing there talking, walking off.
        let x = VISITOR_FROM;
        let speed = 0;
        let target = VISITOR_TALKING;
        if (clock < ENTER_AT) {
          target = FACE_LEFT;
        } else if (clock < ARRIVE_AT) {
          x = VISITOR_FROM - ((clock - ENTER_AT) / 1000) * WALK_SPEED;
          speed = WALK_SPEED;
          target = FACE_LEFT;
        } else if (clock < LEAVE_AT) {
          x = VISITOR_STOP;
        } else {
          x = Math.min(
            VISITOR_FROM,
            VISITOR_STOP + ((clock - LEAVE_AT) / 1000) * WALK_SPEED,
          );
          speed = x < VISITOR_FROM ? WALK_SPEED : 0;
          target = FACE_RIGHT;
        }
        // Turning on the spot as it walks off; snapped round to face in.
        if (clock < ENTER_AT) heading = FACE_LEFT;
        else heading = turnToward(heading, target, 12, 9, dt);
        visitor.root.position.set(x, 0, 0.2);
        visitor.heading = heading;
        const there = clock >= ENTER_AT && clock < LEAVE_AT + WALK_MS;
        const fade = there
          ? Math.max(0, Math.min(1, (VISITOR_FROM - x) / EDGE_FADE))
          : 0;
        visitor.root.visible = fade > 0;
        if (Math.abs(fade - tint) > 0.01) {
          visitor.setTint(0, fade);
          tint = fade;
        }
        visitor.update(dt, speed);
        listener.update(dt, 0);

        // The bubbles: React shows the words; placed here, every frame.
        const now = linesAt(clock);
        const next: Line[] = [
          now.visitor ? { who: "visitor", text: now.visitor } : null,
          now.listener ? { who: "listener", text: now.listener } : null,
        ];
        if (
          next[0]?.text !== shown[0]?.text ||
          next[1]?.text !== shown[1]?.text
        ) {
          shown = next;
          setSaid({ visitor: now.visitor, listener: now.listener });
        }
        place(bubbles.current.visitor, visitor, w, h);
        place(bubbles.current.listener, listener, w, h);
      },
    });
    return () => {
      remove();
      listener.dispose();
      visitor.dispose();
    };
  }, [listenerSeed, visitorSeed, stage, box]);

  return (
    <div
      ref={box}
      role="img"
      aria-label="A herzie listening to music in its headphones, and another dropping by to say hi"
      style={{ width, height, flexShrink: 0, position: "relative", zIndex: 1 }}
    >
      {(["visitor", "listener"] as const).map((who) => (
        <div
          key={who}
          ref={(el) => {
            bubbles.current[who] = el;
          }}
          className="pointer-events-none absolute top-0 left-0 w-max"
        >
          <SpeechBubble
            line={said[who]}
            typed={said[who]?.length ?? 0}
            tail="down"
          />
        </div>
      ))}
    </div>
  );
}
