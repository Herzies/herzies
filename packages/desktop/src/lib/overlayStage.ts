import { HerzieStage, herzieStage } from "@herzies/shared/gl";
import { createContext, useContext } from "react";
import {
  onTownSupersample,
  townSupersample,
  wholePixelDpr,
} from "../components/town/pixelSize";

/**
 * The page's herzie canvas sits under the app's overlay windows, so a herzie
 * inside one would be drawn behind its glass. Overlay windows get a stage of
 * their own, hosted inside the open window. Only one is open at a time, so
 * they share it.
 */
export const overlayHerzieStage = new HerzieStage();

/** The visitor panel's own herzie canvas. The page's canvas sits under the
 * panel's glass, and the overlay windows' one follows whichever window is
 * open, which can be one opened over this panel. */
export const visitorHerzieStage = new HerzieStage();

const townLookStages = new Set<HerzieStage>([
  herzieStage,
  overlayHerzieStage,
  visitorHerzieStage,
]);

/** Draws a stage the way the Town does: the same pixel size, and
 * Settings > Graphics > Supersampling. Stages made elsewhere (the boss
 * results' podium) join here. Returns what to call to leave. */
export function followTownLook(stage: HerzieStage): () => void {
  townLookStages.add(stage);
  apply(stage);
  return () => townLookStages.delete(stage);
}

function apply(stage: HerzieStage) {
  stage.pixelScale = wholePixelDpr();
  stage.supersample = townSupersample();
}

function followTown() {
  for (const stage of townLookStages) apply(stage);
}
followTown();
onTownSupersample(followTown);

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
