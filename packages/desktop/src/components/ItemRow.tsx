import { getItem } from "@herzies/shared";

/** One inventory/store row: name + subtitle on the left, an optional action on the right. */
export function ItemRow({
  itemId,
  onInspect,
  inspectTitle = "Inspect item",
  subtitle,
  action,
}: {
  itemId: string;
  onInspect: (itemId: string) => void;
  inspectTitle?: string;
  subtitle: React.ReactNode;
  action?: React.ReactNode;
}) {
  const def = getItem(itemId);
  const name = def?.name ?? itemId;

  return (
    <div className="flex items-center justify-between gap-2 border-b border-[#222] py-1.5">
      <button
        type="button"
        onClick={() => onInspect(itemId)}
        className="group min-w-0 flex-1 cursor-pointer text-left"
        title={inspectTitle}
      >
        <div className="truncate text-ui group-hover:underline">{name}</div>
        <div className="text-[10px] text-text-dim">{subtitle}</div>
      </button>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
