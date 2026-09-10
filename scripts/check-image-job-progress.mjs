const jobId = Number(process.argv[2]);
if (!Number.isInteger(jobId) || jobId < 1) throw new Error('JOB_ID_REQUIRED');
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token) throw new Error('CF_CREDENTIALS_REQUIRED');
const base = `https://api.cloudflare.com/client/v4/accounts/${account}`;
async function cf(path, body) {
  const response = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000)
  });
  const data = await response.json();
  if (!response.ok || data.success === false) throw new Error(`CF_READ_${response.status}`);
  return data.result;
}
const db = (await cf('/d1/database')).find(row => row.name === 'content-orchestrator');
if (!db?.uuid) throw new Error('DB_MISSING');
async function query(sql) {
  const result = await cf(`/d1/database/${db.uuid}/query`, { sql, params: [jobId] });
  return (Array.isArray(result) ? result[0] : result).results || [];
}
for (let attempt = 0; attempt < 20; attempt++) {
  const images = await query(`SELECT id,role,position,status,provider,provider_status,provider_checked_at,
    provider_attempt_count,provider_error_code,updated_at FROM job_images WHERE job_id=? ORDER BY position,id`);
  const jobs = await query(`SELECT id,status,updated_at,json_extract(result_json,'$.imagePipeline.complete') AS image_complete
    FROM jobs WHERE id=?`);
  console.log('IMAGE_JOB_PROGRESS ' + JSON.stringify({ jobId, attempt, jobs, images }));
  if (images.length >= 3 && images.every(row => row.status === 'attached') && jobs[0]?.image_complete === 1) {
    console.log(`IMAGE_JOB_COMPLETE jobId=${jobId} attached=${images.length}`);
    process.exit(0);
  }
  if (attempt < 19) await new Promise(resolve => setTimeout(resolve, 30000));
}
throw new Error(`IMAGE_JOB_STILL_PENDING:${jobId}`);
