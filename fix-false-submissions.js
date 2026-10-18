require('dotenv').config();
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

async function main() {
  // Get all "submitted" proposals
  const res = await fetch(url + '/rest/v1/upwork_proposals?select=id,job_id,job_title,score,status&status=eq.submitted&order=updated_at.desc', {
    headers: { apikey: key, Authorization: 'Bearer ' + key }
  });
  const submitted = await res.json();
  if (!Array.isArray(submitted)) { console.log('Error:', submitted); return; }

  console.log(`Found ${submitted.length} "submitted" proposals:`);
  for (const p of submitted) {
    console.log(`  id=${p.id} score=${p.score} | ${(p.job_title || '').slice(0, 60)}`);
  }

  // Reset all to "queued" so they can be retried
  for (const p of submitted) {
    const patchRes = await fetch(url + `/rest/v1/upwork_proposals?id=eq.${p.id}`, {
      method: 'PATCH',
      headers: {
        apikey: key,
        Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ status: 'queued' }),
    });
    console.log(`  Reset ${p.id} to "queued": ${patchRes.ok ? 'OK' : patchRes.status}`);
  }

  // Also reset any "auto_sending" to "queued"
  const autoRes = await fetch(url + '/rest/v1/upwork_proposals?select=id,job_title&status=eq.auto_sending', {
    headers: { apikey: key, Authorization: 'Bearer ' + key }
  });
  const autoSending = await autoRes.json();
  if (Array.isArray(autoSending) && autoSending.length > 0) {
    console.log(`\nAlso found ${autoSending.length} "auto_sending":`);
    for (const p of autoSending) {
      const patchRes = await fetch(url + `/rest/v1/upwork_proposals?id=eq.${p.id}`, {
        method: 'PATCH',
        headers: {
          apikey: key,
          Authorization: 'Bearer ' + key,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ status: 'queued' }),
      });
      console.log(`  Reset ${p.id} to "queued": ${patchRes.ok ? 'OK' : patchRes.status}`);
    }
  }

  console.log('\nDone. All false submissions reset to "queued".');
}
main().catch(console.error);
