/**
 * Stands in for @react-three/rapier in the website's showcase build (see
 * vite.showcase.config.ts): nothing there walks into anything, so the
 * physics engine (and its WebAssembly) stays out of the download. Colliders
 * draw nothing; bodies and the world just hold their children.
 */
import type { ReactNode } from "react";

const Holder = ({ children }: { children?: ReactNode }) => <>{children}</>;
const Nothing = () => null;

export const Physics = Holder;
export const RigidBody = Holder;
export const CuboidCollider = Nothing;
export const CylinderCollider = Nothing;
export const CapsuleCollider = Nothing;
export const BallCollider = Nothing;
export const useRapier = () => {
  throw new Error("no physics in the showcase");
};
export const useBeforePhysicsStep = () => {};
export const useAfterPhysicsStep = () => {};
