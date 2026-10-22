import { HerzieStage, herzieStage } from "@herzies/shared/gl";
import { createContext, useContext } from "react";

/**
 * The page's herzie canvas sits under the app's overlay windows, so a herzie
 * inside one would be drawn behind its glass. Overlay windows get a stage of
 * their own, hosted inside the open window. Only one is open at a time, so
 * they share it.
 */
export const overlayHerzieStage = new HerzieStage();

/** Which stage the herzies below draw on, and, inside an overlay window,
 * where their sky goes: a layer in the window's panel (clipped to its
 * rounded corners) rather than fixed across the whole app window. */
export const HerzieStageContext = createContext<{
  stage: HerzieStage;
  inOverlay: boolean;
  skySlot: HTMLElement | null;
}>({ stage: herzieStage, inOverlay: false, skySlot: null });

export function useHerzieStage() {
  return useContext(HerzieStageContext);
}
