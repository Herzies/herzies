-- @-mentions of people in chat (friend codes)

alter table public.chat_messages
  add column if not exists user_refs text[] not null default '{}';
