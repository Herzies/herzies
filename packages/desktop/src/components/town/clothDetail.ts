import type { ClothDetail } from "@herzies/shared/gl";

/** Past this far from the camera (world units) a cloak is simulated at half
 * rate, and past FROZEN not at all: its swing can't be told apart from
 * there, and a crowd of them shouldn't cost the frame. */
const HALF = 18;
const FROZEN = 45;

/** How much to simulate the cloak of a herzie `distance` from the camera. */
export function clothDetailAt(distance: number): ClothDetail {
  return distance > FROZEN ? "frozen" : distance > HALF ? "half" : "full";
}
