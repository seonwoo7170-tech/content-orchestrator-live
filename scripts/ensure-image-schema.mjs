import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const migrationName = '0028_puter_image_attempted.sql';
export async function ensureImageSchema(query) {
  const columns = await query('PRAGMA table_info(job_images)');
  if (!columns.length) throw new Error('IMAGE_TABLE_MISSING');
  const missing = !columns.some(row => row.name === 'puter_attempted');
  if (missing) {
    const migration = await readFile(new URL('../worker/migrations/' + migrationName, import.meta.url), 'utf8');
    for (const sql of migration.split(';').map(part => part.trim()).filter(Boolean)) await query(sql);
  }
  const ledger = await query("SELECT name FROM sqlite_master WHERE type='table' AND name='d1_migrations'");
  if (ledger.length) {
    await query('INSERT INTO d1_migrations (name) SELECT ? WHERE NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name=?)', [migrationName, migrationName]);
  }
  const verified = await query('PRAGMA table_info(job_images)');
  if (!verified.some(row => row.name === 'puter_attempted')) throw new Error('IMAGE_SCHEMA_NOT_READY');
  return { applied: missing, migration: migrationName };
}

async function main() {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !token) throw new Error('CF_CREDENTIALS_REQUIRED');
  async function cf(path, body) {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000)
    });
    const data = await response.json();
    if (!response.ok || data.success === false) throw new Error(`CF_SCHEMA_${response.status}`);
    return data.result;
  }
  const db = (await cf('/d1/database')).find(row => row.name === 'content-orchestrator');
  if (!db?.uuid) throw new Error('DB_MISSING');
  const result = await ensureImageSchema(async (sql, params = []) => {
    const result = await cf(`/d1/database/${db.uuid}/query`, { sql, params });
    const group = Array.isArray(result) ? result[0] : result;
    if (group.success === false) throw new Error('IMAGE_SCHEMA_QUERY_FAILED');
    return group.results || [];
  });
  console.log('IMAGE_SCHEMA_READY ' + JSON.stringify(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
