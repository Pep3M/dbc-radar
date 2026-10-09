import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const openDb = (path: string) => {
	mkdirSync(dirname(path), { recursive: true })
	const db = new Database(path, { create: true, strict: true })
	db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')
	db.exec(`
		CREATE TABLE IF NOT EXISTS pools (
			pool TEXT PRIMARY KEY,
			config TEXT NOT NULL,
			base_mint TEXT,
			quote_mint TEXT,
			base_decimals INTEGER,
			quote_decimals INTEGER,
			creator TEXT,
			created_at INTEGER,
			created_slot INTEGER,
			created_signature TEXT,
			first_seen_at INTEGER NOT NULL,
			last_trade_at INTEGER,
			last_price REAL,
			quote_reserve REAL,
			migration_threshold REAL,
			progress REAL,
			graduated_at INTEGER
		);
		CREATE INDEX IF NOT EXISTS pools_created_at ON pools (created_at);
		CREATE INDEX IF NOT EXISTS pools_last_trade_at ON pools (last_trade_at);

		CREATE TABLE IF NOT EXISTS trades (
			signature TEXT NOT NULL,
			idx INTEGER NOT NULL,
			pool TEXT NOT NULL,
			trader TEXT NOT NULL,
			side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
			quote_amount REAL NOT NULL,
			usd_amount REAL,
			base_amount REAL NOT NULL,
			price REAL,
			slot INTEGER NOT NULL,
			ts INTEGER NOT NULL,
			PRIMARY KEY (signature, idx)
		);
		CREATE INDEX IF NOT EXISTS trades_pool_ts ON trades (pool, ts);
		CREATE INDEX IF NOT EXISTS trades_ts ON trades (ts);

		CREATE TABLE IF NOT EXISTS tokens (
			mint TEXT PRIMARY KEY,
			name TEXT,
			symbol TEXT,
			image TEXT,
			twitter TEXT,
			website TEXT,
			metadata_at INTEGER,
			mcap_usd REAL,
			liquidity_usd REAL,
			market_at INTEGER,
			holders INTEGER,
			top10_pct REAL,
			bot_pct REAL,
			fresh_holders INTEGER,
			holders_at INTEGER
		);

		-- DBC pool configs are shared by many pools: fetched once via RPC, then cached here.
		CREATE TABLE IF NOT EXISTS dbc_configs (
			config TEXT PRIMARY KEY,
			fee_claimer TEXT,
			quote_mint TEXT,
			token_decimal INTEGER,
			migration_option INTEGER,
			migration_fee_option INTEGER,
			migration_quote_threshold TEXT,
			sqrt_start_price TEXT,
			curve TEXT,
			fetched_at INTEGER NOT NULL
		);

		CREATE TABLE IF NOT EXISTS alerts (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			dedupe_key TEXT NOT NULL UNIQUE,
			type TEXT NOT NULL,
			pool TEXT NOT NULL,
			symbol TEXT,
			detail TEXT NOT NULL,
			payload TEXT NOT NULL,
			deliveries TEXT NOT NULL DEFAULT '[]',
			ts INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS alerts_ts ON alerts (ts);

		-- Telegram bot: one row per private chat that pressed /start. prefs is JSON (TelegramPrefs).
		CREATE TABLE IF NOT EXISTS telegram_subscribers (
			chat_id INTEGER PRIMARY KEY,
			name TEXT,
			prefs TEXT NOT NULL,
			active INTEGER NOT NULL DEFAULT 1,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);
		-- Bot key/value state (getUpdates offset).
		CREATE TABLE IF NOT EXISTS telegram_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		-- Dedupe for Telegram-only triggers (per-level curve crossings, flags outside ALERT_FLAGS).
		CREATE TABLE IF NOT EXISTS telegram_sent (key TEXT PRIMARY KEY, ts INTEGER NOT NULL);
	`)
	migrate(db)
	// One-off cleanup of names stored before enrich.ts stripped bidi controls.
	for (const [table, column] of [
		['tokens', 'name'],
		['tokens', 'symbol'],
		['alerts', 'symbol'],
	]) {
		let expr = column
		for (const code of [
			0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
		]) {
			expr = `replace(${expr}, char(${code}), '')`
		}
		db.run(`UPDATE ${table} SET ${column} = ${expr} WHERE ${column} <> ${expr}`)
	}
	return db
}

// Additive migrations for databases created by earlier versions.
const COLUMNS: [table: string, column: string, type: string][] = [
	['trades', 'quote_reserve', 'REAL'],
	['pools', 'damm_pool', 'TEXT'],
	['tokens', 'holders_top', 'TEXT'],
]

const migrate = (db: Database) => {
	for (const [table, column, type] of COLUMNS) {
		const existing = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all()
		if (!existing.some((c) => c.name === column))
			db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
	}
}

export type Db = ReturnType<typeof openDb>
