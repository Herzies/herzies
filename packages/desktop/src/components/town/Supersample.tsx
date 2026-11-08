import { SupersamplePass } from "@herzies/shared/gl";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { SUPERSAMPLE } from "./pixelSize";

/**
 * Supersampling's last step (see pixelSize.ts and shared's SupersamplePass),
 * once everything's on the canvas: the world through the composer, Home's
 * layer over it (see HomeLayer).
 */
export function Supersample({ block = SUPERSAMPLE }: { block?: number }) {
  const gl = useThree((s) => s.gl);
  const pass = useMemo(() => new SupersamplePass(block), [block]);
  useEffect(() => () => pass.dispose(), [pass]);

  // After the composer (1) and Home's layer (2).
  useFrame(() => pass.apply(gl), 3);

  return null;
}
