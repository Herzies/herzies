import { useQuestBoard } from "../lib/quests";
import type { Quest } from "../tauri-bridge";
import { List } from "./List";
import { SegmentBar } from "./SegmentBar";
import { View } from "./View";

/** One quest: who gave it, what it asks, and how far along it is. */
function QuestRow({ quest }: { quest: Quest }) {
  const done = quest.status === "complete";
  return (
    <div className="flex flex-col gap-1 rounded px-2.5 py-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-ui font-bold text-text">{quest.title}</span>
        <span className="shrink-0 text-ui-sm text-green">
          {quest.giverName}
        </span>
      </div>
      {quest.description ? (
        <div className="text-ui-sm text-text-dim">{quest.description}</div>
      ) : null}
      <div className="flex items-center gap-2">
        <SegmentBar
          className="flex-1"
          progress={quest.progress / quest.target}
          colour={done ? "bg-yellow" : "bg-green"}
        />
        <span className="shrink-0 text-ui-sm text-text-dim">
          {quest.progress}/{quest.target}
        </span>
      </div>
      {done ? (
        <div className="text-ui-sm text-yellow">
          Ready to turn in. See {quest.giverName}.
        </div>
      ) : null}
    </div>
  );
}

/**
 * The Quests window: what you've taken on from folks in Town and how far
 * along each is. Finished ones wait here until you turn them in to whoever
 * gave them. Shares its board with the givers (lib/quests.ts).
 */
export function QuestsView({ active }: { active: boolean }) {
  const board = useQuestBoard(active);
  const open = (board?.quests ?? []).filter((q) => q.status !== "claimed");
  // Finished first: they're waiting on you.
  open.sort(
    (a, b) => Number(b.status === "complete") - Number(a.status === "complete"),
  );
  const doneToday = (board?.quests ?? []).filter((q) => q.status === "claimed");

  return (
    <View colour="cyan" childrenClassName="flex min-h-0 flex-col">
      <List contentStyle={{ padding: "8px 12px" }}>
        {!board ? (
          <div className="text-ui-sm text-text-dim">...</div>
        ) : (
          <>
            <section className="mb-4">
              <h3 className="mb-1.5 text-[10px] tracking-wider text-text-dim uppercase">
                Active
              </h3>
              {open.length === 0 ? (
                <div className="text-ui-sm text-text-dim">
                  No quests. Talk to folks in Town.
                </div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {open.map((q) => (
                    <QuestRow key={q.id} quest={q} />
                  ))}
                </div>
              )}
            </section>
            {doneToday.length > 0 ? (
              <section className="mb-4">
                <h3 className="mb-1.5 text-[10px] tracking-wider text-text-dim uppercase">
                  Done today
                </h3>
                <div className="flex flex-col gap-1">
                  {doneToday.map((q) => (
                    <div
                      key={q.id}
                      className="flex justify-between gap-2 px-2.5 text-ui-sm text-text-dim"
                    >
                      <span>{q.title}</span>
                      <span>{q.giverName}</span>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
          </>
        )}
      </List>
    </View>
  );
}
