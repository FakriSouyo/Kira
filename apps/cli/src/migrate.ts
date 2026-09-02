import { openDb } from '@harness/database';

const db = openDb();
const tables = db.raw
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all() as { name: string }[];

console.log('✓ Migrations applied. Tables:');
for (const t of tables) console.log(`  - ${t.name}`);

db.raw.close();
