require('dotenv').config();
const url = process.env.SUPABASE_URL || 'https://ivhfuhxorppptyuofbgq.supabase.co';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';

async function main() {
  // Get table columns
  const colRes = await fetch(url + '/rest/v1/upwork_proposals?limit=1', {
    headers: { apikey: key, Authorization: 'Bearer ' + key }
  });
  const sample = await colRes.json();
  if (Array.isArray(sample) && sample.length > 0) {
    console.log('=== TABLE COLUMNS ===');
    console.log(Object.keys(sample[0]).join(', '));
  }

  // Get all jobs
  const res = await fetch(url + '/rest/v1/upwork_proposals?select=status,score,job_title,budget&order=updated_at.desc', {
    headers: { apikey: key, Authorization: 'Bearer ' + key }
  });
  const all = await res.json();
  if (!Array.isArray(all)) { console.log('Error:', all); return; }

  const byStatus = {};
  for (const d of all) byStatus[d.status] = (byStatus[d.status] || 0) + 1;
  console.log('\n=== STATUS BREAKDOWN ===');
  for (const [s, c] of Object.entries(byStatus)) console.log(`  ${c}x  ${s}`);
  console.log(`  Total: ${all.length}`);

  // Show recent excluded titles to understand what's being dropped
  const excluded = all.filter(d => d.status === 'excluded');
  console.log('\n=== RECENT EXCLUDED (last 15) ===');
  for (const d of excluded.slice(0, 15)) {
    console.log(`  ${(d.job_title || '').slice(0, 70)} | budget=${d.budget || 'none'}`);
  }

  // Show pending (qualified but never sent)
  const pending = all.filter(d => d.status === 'pending');
  console.log(`\n=== PENDING (${pending.length} total, top 10 by score) ===`);
  pending.sort((a, b) => (b.score || 0) - (a.score || 0));
  for (const d of pending.slice(0, 10)) {
    console.log(`  score=${d.score} | ${(d.job_title || '').slice(0, 60)} | budget=${d.budget || 'none'}`);
  }
}

main().catch(console.error);
