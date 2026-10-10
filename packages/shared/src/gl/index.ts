/**
 * The real-3D herzie (three.js): the model the Town walks about, and the
 * HerzieView that draws one anywhere else on a page. Its own entry point,
 * `@herzies/shared/gl`, so pages without herzies don't load three.js.
 */
export * from "./animation.js";
export * from "./HerzieModel.js";
export * from "./HerzieView.js";
export * from "./herzieMaterial.js";
export * from "./stage.js";
