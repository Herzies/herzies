/** Widens a header icon button's hit area by 3px either side without changing
 * how it looks: an invisible `::before` is part of the button for hover, click
 * and tooltip purposes. Half of the row's `gap-1.5` (6px), so neighbouring
 * icons meet exactly and the pointer is never over dead space between them —
 * change one and the other has to follow. */
export const HEADER_ICON_HIT =
  "relative before:absolute before:inset-y-0 before:-inset-x-[3px]";
