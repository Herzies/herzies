-- Proposed occurrences awaiting the admin's approval.
--
-- A weekly routine drafts song hunts through /api/curator/song-hunt. Its
-- proposals are complete configs, which on their own would make the
-- occurrence live (00081 derives active from completeness) — this flag holds
-- them back until the admin approves from the admin page. The admin API
-- derives `active` as: not skipped AND complete AND NOT needs_approval.
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS needs_approval boolean NOT NULL DEFAULT false;
