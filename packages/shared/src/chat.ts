/** Maximum length (UTF-16 code units) of a chat message body after trim. */
export const CHAT_MESSAGE_MAX_LENGTH = 400;

/**
 * How long a global-chat message stays visible before it's considered expired.
 * The chat is intentionally ephemeral: messages older than this are hidden by
 * the API and purged from the database by a scheduled job. Keep this in sync
 * with the retention interval in the chat-retention migration.
 */
export const CHAT_RETENTION_HOURS = 24;

/** Retention window expressed in milliseconds, for client/server filtering. */
export const CHAT_RETENTION_MS = CHAT_RETENTION_HOURS * 60 * 60 * 1000;
