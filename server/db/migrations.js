/**
 * Versioned schema migrations.
 *
 * The old schema was a single `CREATE TABLE IF NOT EXISTS` blob, which meant any
 * change to an existing install silently did nothing. Migrations are numbered,
 * applied in order inside a transaction, and tracked with `PRAGMA user_version`,
 * so upgrading an existing spockchat.db is safe and repeatable.
 *
 * Rules for adding a migration:
 *   - append only; never edit a migration that has shipped
 *   - it must be safe to run against a database that already contains data
 */

const migrations = [
  {
    version: 1,
    name: 'baseline',
    up: db => db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id            TEXT PRIMARY KEY,
        username      TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at    INTEGER DEFAULT (unixepoch())
      );
      CREATE TABLE IF NOT EXISTS friendships (
        id              TEXT PRIMARY KEY,
        user_id         TEXT NOT NULL,
        friend_id       TEXT NOT NULL,
        friend_username TEXT NOT NULL,
        friend_host     TEXT NOT NULL,
        status          TEXT DEFAULT 'pending',
        created_at      INTEGER DEFAULT (unixepoch()),
        UNIQUE(user_id, friend_username)
      );
      CREATE TABLE IF NOT EXISTS chats (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        type       TEXT NOT NULL,
        admin_id   TEXT,
        ai_enabled INTEGER DEFAULT 0,
        ai_model   TEXT DEFAULT 'llama3',
        ai_host    TEXT DEFAULT 'http://localhost:11434',
        created_at INTEGER DEFAULT (unixepoch())
      );
      CREATE TABLE IF NOT EXISTS chat_members (
        chat_id   TEXT NOT NULL,
        user_id   TEXT NOT NULL,
        username  TEXT NOT NULL,
        is_admin  INTEGER DEFAULT 0,
        joined_at INTEGER DEFAULT (unixepoch()),
        PRIMARY KEY (chat_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS messages (
        id              TEXT PRIMARY KEY,
        chat_id         TEXT NOT NULL,
        sender_id       TEXT,
        sender_username TEXT NOT NULL,
        content         TEXT NOT NULL,
        type            TEXT DEFAULT 'text',
        created_at      INTEGER DEFAULT (unixepoch())
      );
      CREATE TABLE IF NOT EXISTS invites (
        id               TEXT PRIMARY KEY,
        chat_id          TEXT NOT NULL,
        chat_name        TEXT NOT NULL,
        inviter_id       TEXT NOT NULL,
        inviter_username TEXT NOT NULL,
        invitee_username TEXT NOT NULL,
        status           TEXT DEFAULT 'pending',
        created_at       INTEGER DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_messages_chat      ON messages(chat_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_friendships_user   ON friendships(user_id);
      CREATE INDEX IF NOT EXISTS idx_chat_members_user  ON chat_members(user_id);
      CREATE INDEX IF NOT EXISTS idx_invites_invitee    ON invites(invitee_username, status);
    `),
  },

  {
    version: 2,
    name: 'message-delivery-guarantees',
    // Adds the three columns that make message delivery survive packet loss:
    //   seq            — per-chat monotonic counter, the basis for gap detection
    //   client_msg_id  — idempotency key, so a client retry cannot duplicate
    //   created_at_ms  — millisecond ordering; second precision collided badly
    up: db => {
      db.exec(`
        ALTER TABLE messages ADD COLUMN seq           INTEGER;
        ALTER TABLE messages ADD COLUMN client_msg_id TEXT;
        ALTER TABLE messages ADD COLUMN created_at_ms INTEGER;
      `);
      // Backfill: give existing rows a stable ordering within each chat.
      db.exec(`
        UPDATE messages
           SET created_at_ms = COALESCE(created_at_ms, created_at * 1000)
         WHERE created_at_ms IS NULL;
      `);
      db.exec(`
        WITH numbered AS (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY created_at, rowid) AS n
            FROM messages
        )
        UPDATE messages
           SET seq = (SELECT n FROM numbered WHERE numbered.id = messages.id)
         WHERE seq IS NULL;
      `);
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_chat_seq
          ON messages(chat_id, seq);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_id
          ON messages(chat_id, client_msg_id) WHERE client_msg_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_messages_chat_order
          ON messages(chat_id, seq DESC);
      `);
    },
  },

  {
    version: 3,
    name: 'friendship-state-and-federation-outbox',
    up: db => {
      db.exec(`
        ALTER TABLE friendships ADD COLUMN direction  TEXT DEFAULT 'outgoing';
        ALTER TABLE friendships ADD COLUMN updated_at INTEGER;
        ALTER TABLE friendships ADD COLUMN last_error TEXT;
      `);
      db.exec(`UPDATE friendships SET updated_at = COALESCE(updated_at, created_at);`);

      // Durable retry queue for peer-to-peer calls. A friend request accepted
      // while the other machine is asleep is delivered when it comes back,
      // instead of being lost the way it used to be.
      db.exec(`
        CREATE TABLE IF NOT EXISTS federation_outbox (
          id           TEXT PRIMARY KEY,
          peer_host    TEXT NOT NULL,
          endpoint     TEXT NOT NULL,
          payload      TEXT NOT NULL,
          attempts     INTEGER DEFAULT 0,
          next_retry_at INTEGER NOT NULL,
          last_error   TEXT,
          created_at   INTEGER DEFAULT (unixepoch()),
          status       TEXT DEFAULT 'pending'
        );
        CREATE INDEX IF NOT EXISTS idx_outbox_due
          ON federation_outbox(status, next_retry_at);
      `);
    },
  },

  {
    version: 4,
    name: 'invite-origin-and-chat-metadata',
    up: db => {
      db.exec(`
        ALTER TABLE invites ADD COLUMN origin_host TEXT;
        ALTER TABLE invites ADD COLUMN responded_at INTEGER;
        ALTER TABLE chats   ADD COLUMN updated_at INTEGER;
        ALTER TABLE chats   ADD COLUMN archived INTEGER DEFAULT 0;
      `);
      db.exec(`UPDATE chats SET updated_at = COALESCE(updated_at, created_at);`);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_invites_chat ON invites(chat_id);
        CREATE INDEX IF NOT EXISTS idx_chats_admin  ON chats(admin_id);
      `);
    },
  },

  {
    version: 5,
    name: 'delivery-receipts',
    // Lets a client prove what it has actually rendered, so the server can tell
    // the difference between "delivered" and "sent into the void".
    up: db => db.exec(`
      CREATE TABLE IF NOT EXISTS delivery_cursors (
        chat_id    TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        last_seq   INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (chat_id, user_id)
      );
    `),
  },
];

const LATEST_VERSION = migrations[migrations.length - 1].version;

module.exports = { migrations, LATEST_VERSION };
