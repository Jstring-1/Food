import 'dotenv/config';
import { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  // Don't crash the process — let /health stay up and DB-backed routes fail
  // gracefully. On Railway, set DATABASE_URL in the service Variables (a .env
  // file is never deployed). Locally, copy .env.example to .env.
  console.warn('WARNING: DATABASE_URL is not set — database queries will fail until it is configured.');
}

export const pool = new Pool({
  connectionString,
  ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : undefined,
  // Ingestion runs long single connections; keep the pool small.
  max: 4,
});
