# Global Chat

## Problem
There's no way for players to interact with each other. The game has social hooks (Song Hunt, item collecting) but no social channel. Players can't show off items, discuss hints, or just hang out.

## Appetite
**Large** — up to a week of focused work. Real-time infra, new UI components, and item autocomplete make this non-trivial.

## Solution
- Chat messages appear **inline in the existing logs list** as `[timestamp] <username>: message`
- Usernames get a **colour assigned per session** (rotating palette, not persistent)
- **Supabase Realtime** listening to Postgres changes on a `chat_messages` table
- Messages are **persisted** — players see the last N messages on load, new messages stream in
- **`BEFORE INSERT` database trigger** with keyword blocklist for basic moderation
- **Heavy input sanitization** — plain text only, no HTML, no script injection. Sanitize both client-side and server-side. **Exception:** Last.fm track URLs (from the `/current_song` slash command) are preserved so shared links work.
- Typing `#` opens an **autocomplete for items from the user's own inventory**. Typing `@` mentions **people in the current chat session or friends** (stored as friend codes; rendered as `@Name`). For the mentioned player, their name appears in **cyan**; for everyone else it uses default message text colour. Typing `/` opens **slash commands** (e.g. `/current_song` — share now playing with a Last.fm link). Selected items render as clickable references in the message
- Clicking an item reference opens the **existing item inspect view as an overlay/modal**
- Song Hunt spoilers: **no technical filtering** — lean into collaboration. First-finders leaderboard already rewards speed
- **Local Supabase** for development

## Rabbit Holes
- **Overlay for item inspect** — existing inspect UI may not be designed for overlay use; might need adaptation
- **Rate limiting** — without it, someone could spam the chat. A simple client-side cooldown may suffice initially, but a server-side check (e.g., max 1 msg/sec per user via trigger) is more robust
- **Last N messages on load** — need to pick a sensible N and ensure the query is indexed properly
- **Realtime connection management** — handling disconnects, reconnects, and duplicate messages gracefully

## No-gos
- No private/direct messages
- No user blocking or reporting system
- No rich media — no images, no link previews, no rendered HTML (Last.fm track URLs from `/current_song` are plain links only)
- No arbitrary links in messages — only Last.fm music URLs are allowed, so slash-command shares work without opening generic URL spam
- No chat channels or rooms — one global channel only
- No technical spoiler filtering for Song Hunt
- No # autocomplete for all game items — inventory only
- No @ autocomplete for arbitrary users — friends and recent chat participants only
