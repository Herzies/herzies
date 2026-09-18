-- One-off: bring existing grounds down to the GROUND_DROP_CAP of 10 (see
-- 00065, which caps new rolls but deliberately leaves standing backlogs
-- alone). 17 players held 819 drops between them, 11 of them over the cap,
-- the largest sitting on 281 — which is the returning-player pile the cap
-- exists to prevent.
--
-- Keeps each player's 10 most recent drops and deletes the rest (683 rows).
-- Ordering is by dropped_at DESC with id DESC as a tiebreak, so the result is
-- deterministic even when timestamps collide.
--
-- Note this is the "most recent" rule, not the "most valuable" one: 611 of
-- the 819 drops are CDs, so the survivors skew heavily to CDs and 178 of the
-- deleted rows are non-common. That was a deliberate product call in favour
-- of a rule that is simple to explain to players.

-- The deleted rows are copied out first. This is real player property and the
-- delete is otherwise irreversible; keep the table around until the change
-- has settled, then drop it.
CREATE TABLE IF NOT EXISTS public.pending_drops_trim_backup_00066 (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  item_id text NOT NULL,
  dropped_at timestamptz NOT NULL,
  backed_up_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.pending_drops_trim_backup_00066 ENABLE ROW LEVEL SECURITY;

WITH ranked AS (
  SELECT id, row_number() OVER (
           PARTITION BY user_id ORDER BY dropped_at DESC, id DESC
         ) AS rn
  FROM public.pending_drops
)
INSERT INTO public.pending_drops_trim_backup_00066 (id, user_id, item_id, dropped_at)
SELECT pd.id, pd.user_id, pd.item_id, pd.dropped_at
FROM public.pending_drops pd
JOIN ranked r ON r.id = pd.id
WHERE r.rn > 10
ON CONFLICT (id) DO NOTHING;

DELETE FROM public.pending_drops pd
USING public.pending_drops_trim_backup_00066 b
WHERE pd.id = b.id;
