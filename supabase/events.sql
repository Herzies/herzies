-- Events system for herzies game server
-- Run this in the Supabase SQL editor after schema.sql

-- Events table (secret tracks, challenges, etc.)
create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  title text not null,
  description text,
  active boolean not null default true,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  config jsonb not null default '{}',
  created_at timestamptz not null default now()
);

-- Event claims (who claimed what)
create table if not exists public.event_claims (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  claimed_at timestamptz not null default now(),
  unique(event_id, user_id)
);

-- Indexes
create index if not exists idx_events_active on public.events(active, starts_at, ends_at);
create index if not exists idx_event_claims_event on public.event_claims(event_id);
create index if not exists idx_event_claims_user on public.event_claims(user_id);

-- RLS for events
alter table public.events enable row level security;

-- No public read policy: clients must go through /api/events/active,
-- which strips sensitive fields (trackTitle, trackArtist) before responding.
-- Service role bypasses RLS for server-side reads.
drop policy if exists "Events are publicly readable" on public.events;
revoke select on public.events from anon, authenticated;

-- Only service role (game server) can insert/update events
-- No INSERT/UPDATE policies for anon/authenticated = only service role can write

-- RLS for event_claims
alter table public.event_claims enable row level security;

-- Users can see their own claims
drop policy if exists "Users can see own claims" on public.event_claims;
create policy "Users can see own claims"
  on public.event_claims for select
  using (auth.uid() = user_id);

-- Only service role (game server) can insert claims
-- No INSERT policy for anon/authenticated = only service role can write

-- Multipliers table (admin-managed XP bonuses)
create table if not exists public.multipliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  bonus real not null check (bonus > 0),
  active boolean not null default true,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_multipliers_active on public.multipliers(active, starts_at, ends_at);

alter table public.multipliers enable row level security;

-- Anyone can see active multipliers
drop policy if exists "Multipliers are publicly readable" on public.multipliers;
create policy "Multipliers are publicly readable"
  on public.multipliers for select
  using (true);

-- Only service role can write multipliers
