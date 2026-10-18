require('dotenv').config();
const url = process.env.SUPABASE_URL || 'https://ivhfuhxorppptyuofbgq.supabase.co';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
if (!key) { console.log('No SUPABASE_KEY found'); process.exit(0); }

async function main() {
  // Recent proposals
  const res = await fetch(url + '/rest/v1/upwork_proposals?order=updated_at.desc&limit=25&select=job_id,job_title,score,status,budget,updated_at', {
    headers: { apikey: key, Authorization: 'Bearer ' + key }
  });
  const data = await res.json();

  console.log('=== RECENT PROPOSALS ===');
  console.log(`Total: ${data.length}`);

  // Group by status
  const byStatus = {};
  for (const d of data) {
    byStatus[d.status] = (byStatus[d.status] || 0) + 1;
  }
  console.log('\nBy status:', JSON.stringify(byStatus));

  console.log('\nRecent jobs:');
  for (const d of data.slice(0, 15)) {
    console.log(`  [${d.status}] score=${d.score} | ${d.budget || 'no budget'} | ${d.job_title?.slice(0, 60)} | ${d.updated_at}`);
  }

  // Count totals
  const countRes = await fetch(url + '/rest/v1/upwork_proposals?select=status', {
    headers: { apikey: key, Authorization: 'Bearer ' + key }
  });
  const all = await countRes.json();
  const totals = {};
  for (const d of all) {
    totals[d.status] = (totals[d.status] || 0) + 1;
  }
  console.log('\n=== ALL-TIME TOTALS ===');
  console.log(JSON.stringify(totals, null, 2));
  console.log(`Total records: ${all.length}`);
}

main().catch(console.error);
