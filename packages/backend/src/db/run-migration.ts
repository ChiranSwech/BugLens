import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from './pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function run() {
  console.log('[Migration] Connecting to database...');
  const sqlPath = path.join(__dirname, '../../db/002_add_missing_bug_fields.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  
  console.log('[Migration] Running SQL script:');
  console.log(sql);
  
  try {
    await pool.query(sql);
    console.log('[Migration] Migration successfully completed!');
  } catch (err) {
    console.error('[Migration] Migration failed:', err);
  } finally {
    await pool.end();
  }
}

run();
