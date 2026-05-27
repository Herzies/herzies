"use client";

import { Herzie3D } from "@herzies/shared";
import { useEffect, useState } from "react";

const SEEDS = [
  "hero-mochi",
  "hero-pippin",
  "hero-juno",
  "hero-luma",
  "hero-fern",
  "hero-bento",
  "hero-tofu",
  "hero-ziggy",
];

export function Herzie3DHero() {
  // Pick a random seed once mounted to vary across page loads,
  // while keeping SSR markup deterministic (initial = SEEDS[0]).
  const [seed, setSeed] = useState(SEEDS[0]);

  useEffect(() => {
    setSeed(SEEDS[Math.floor(Math.random() * SEEDS.length)]);
  }, []);

  return (
    <div className="flex justify-center items-end gap-8 flex-wrap my-2 mb-4">
      {[1, 2, 3].map((stage) => (
        <div key={stage} className="flex flex-col items-center gap-1">
          <Herzie3D
            userId={seed}
            stage={stage}
            size={4}
            ariaLabel={`A stage ${stage} herzie`}
          />
          <div className="text-[11px] text-text-dim">stage {stage}</div>
        </div>
      ))}
    </div>
  );
}
