-- Global chat messages

-- Create table
create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  content text not null check (char_length(content) between 1 and 500),
  item_refs text[] not null default '{}',
  created_at timestamptz not null default now()
);

-- Index for fetching recent messages
create index if not exists idx_chat_messages_created_at on public.chat_messages(created_at desc);

-- Enable RLS
alter table public.chat_messages enable row level security;

-- SELECT: any authenticated user can read all messages
create policy "Authenticated users can read chat messages"
  on public.chat_messages for select
  using (auth.uid() is not null);

-- INSERT: authenticated users can only insert their own messages
create policy "Authenticated users can insert own chat messages"
  on public.chat_messages for insert
  with check (auth.uid() = user_id);

-- Keyword blocklist trigger
create or replace function check_chat_content()
returns trigger as $$
declare
  blocked_words text[] := array[
    'nigger', 'nigga', 'faggot', 'fag', 'retard', 'kike', 'spic',
    'chink', 'wetback', 'tranny', 'cunt', 'whore', 'slut'
  ];
  word text;
begin
  foreach word in array blocked_words loop
    if NEW.content ~* ('\m' || word || '\M') then
      raise exception 'Message contains blocked content';
    end if;
  end loop;
  return NEW;
end;
$$ language plpgsql set search_path = '';

create trigger trg_check_chat_content
  before insert on public.chat_messages
  for each row execute function check_chat_content();

-- Rate limit trigger
create or replace function check_chat_rate_limit()
returns trigger as $$
begin
  if exists (
    select 1 from public.chat_messages
    where user_id = NEW.user_id
      and created_at > now() - interval '1 second'
  ) then
    raise exception 'Rate limit exceeded: please wait before sending another message';
  end if;
  return NEW;
end;
$$ language plpgsql set search_path = '';

create trigger trg_check_chat_rate_limit
  before insert on public.chat_messages
  for each row execute function check_chat_rate_limit();

-- Enable Realtime
alter publication supabase_realtime add table chat_messages;
