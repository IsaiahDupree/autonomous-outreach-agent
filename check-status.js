require('dotenv').config();
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

async function main() {
  // Status breakdown
  const res = await fetch(url + '/rest/v1/upwork_proposals?select=status&order=updated_at.desc', {
    headers: { apikey: key, Authorization: 'Bearer ' + key }
  });
  const all = await res.json();
  if (!Array.isArray(all)) { console.log('Error:', all); return; }
  const byStatus = {};
  for (const d of all) byStatus[d.status] = (byStatus[d.status] || 0) + 1;
  console.log('=== STATUS BREAKDOWN ===');
  for (const [s, c] of Object.entries(byStatus).sort((a,b) => b[1] - a[1])) console.log('  ' + c + 'x  ' + s);
  console.log('  Total: ' + all.length);

  // Show queued jobs
  const queued = await fetch(url + '/rest/v1/upwork_proposals?select=*&status=eq.queued&order=score.desc&limit=5', {
    headers: { apikey: key, Authorization: 'Bearer ' + key }
  });
  const q = await queued.json();
  if (Array.isArray(q) && q.length > 0) {
    console.log('\n=== QUEUED (columns: ' + Object.keys(q[0]).join(', ') + ') ===');
    for (const d of q) {
      console.log('  score=' + d.score + ' | ' + (d.job_title || '').slice(0, 65) + ' | budget=' + (d.budget || 'none'));
    }
  } else {
    console.log('\nQueued result:', JSON.stringify(q).slice(0, 200));
  }
}
main().catch(console.error);
