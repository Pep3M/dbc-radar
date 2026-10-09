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
			graduated_at INTEGER,
			name TEXT,
			symbol TEXT
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
	`)
	return db
}

export type Db = ReturnType<typeof openDb>
