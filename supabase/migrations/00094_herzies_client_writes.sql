-- Take away client write access to herzies.
--
-- anon and authenticated still held Supabase's default table-wide INSERT,
-- UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER. With the "own herzie" RLS
-- policies limiting rows but not columns, a signed-in player could create a
-- herzie with any xp, level, currency or inventory straight from PostgREST;
-- only bank_expansions had a guard trigger (00080). 00093 already broke
-- client UPDATE and DELETE by revoking SELECT on user_id, which the policies
-- read — this makes that explicit and closes INSERT.
--
-- Every write goes through the service role: /api/herzie registers, the
-- other Next.js routes and the edge functions do the rest. None of them is
-- affected by these grants or by RLS.
revoke insert, update, delete, truncate, references, trigger
  on public.herzies from anon, authenticated;
