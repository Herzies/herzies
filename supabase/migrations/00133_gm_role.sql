-- Game masters: herzies run by the game's own staff. A GM shows a small "GM"
-- mark left of its name in Town and in chat.
--
-- Set by hand, with the service role:
--   update public.herzies set gm = true where user_id = '…';
--
-- Clients don't read the column (their SELECT grants on herzies list columns,
-- 00093): the mark reaches them on the Town ticket and on chat messages.

alter table public.herzies
  add column gm boolean not null default false;

-- As 00027, adding `gm: true` to a GM's live chat messages.
create or replace function public.broadcast_chat_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  sender record;
begin
  select name, friend_code, gm
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
    ) || case when coalesce(sender.gm, false)
              then jsonb_build_object('gm', true) else '{}'::jsonb end,
    'new_message', -- event name clients listen for
    'chat',        -- topic (matches the channel name on the client)
    true           -- private channel (requires Broadcast authorization)
  );
  return null;
end;
$$;

revoke execute on function public.broadcast_chat_message() from public, anon, authenticated;
