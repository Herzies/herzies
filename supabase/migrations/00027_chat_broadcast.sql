-- Move global chat from Realtime "Postgres Changes" to "Broadcast from Database".
--
-- Postgres Changes streams the WAL and runs an RLS authorization check per
-- connected client for every row change — the least scalable Realtime mode.
-- Broadcast is a lightweight pub/sub: a trigger emits each new message (enriched
-- with the sender's name + friend code, so it matches the GET /chat payload) to
-- a private "chat" topic, and clients render straight from the payload instead
-- of re-fetching.

-- 1. Broadcast each new chat message to the "chat" topic.
create or replace function public.broadcast_chat_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  sender record;
begin
  select name, friend_code
    into sender
  from public.herzies
  where user_id = new.user_id;

  perform realtime.send(
    jsonb_build_object(
      'id', new.id,
      'userId', new.user_id,
      'username', coalesce(sender.name, 'Unknown'),
      'friendCode', sender.friend_code,
      'content', new.content,
      'itemRefs', coalesce(new.item_refs, '{}'::text[]),
      'userRefs', coalesce(new.user_refs, '{}'::text[]),
      'createdAt', new.created_at
    ),
    'new_message', -- event name clients listen for
    'chat',        -- topic (matches the channel name on the client)
    true           -- private channel (requires Broadcast authorization below)
  );
  return null;
end;
$$;

drop trigger if exists trg_broadcast_chat_message on public.chat_messages;
create trigger trg_broadcast_chat_message
  after insert on public.chat_messages
  for each row execute function public.broadcast_chat_message();

-- 2. Broadcast authorization: RLS on realtime.messages governs who can use a
-- private Realtime topic. Allow authenticated users to receive on "chat".
drop policy if exists "Authenticated users can receive chat broadcasts"
  on realtime.messages;
create policy "Authenticated users can receive chat broadcasts"
  on realtime.messages
  for select
  to authenticated
  using (
    (select realtime.topic()) = 'chat'
    and realtime.messages.extension = 'broadcast'
  );

-- 3. Postgres Changes is no longer used for chat, so stop streaming the table
-- over WAL to the realtime publication.
do $$
begin
  if exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'chat_messages'
  ) then
    alter publication supabase_realtime drop table public.chat_messages;
  end if;
end;
$$;
