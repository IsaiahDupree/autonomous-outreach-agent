// Test a single proposal submission to verify the fix works
require('dotenv').config();
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

async function main() {
  // Get the highest-scoring queued job
  const res = await fetch(url + '/rest/v1/upwork_proposals?select=id,job_id,job_title,job_url,score,budget,proposal_text&status=eq.queued&order=score.desc&limit=5', {
    headers: { apikey: key, Authorization: 'Bearer ' + key }
  });
  const queued = await res.json();
  if (!Array.isArray(queued) || queued.length === 0) {
    console.log('No queued proposals to test');
    return;
  }

  console.log('Top 5 queued proposals ready for submission:');
  for (const p of queued) {
    const hasCoverLetter = (p.proposal_text || '').length > 50;
    console.log(`  [${p.score}/10] ${(p.job_title || '').slice(0, 60)}`);
    console.log(`    Budget: ${p.budget || 'none'}`);
    console.log(`    Cover letter: ${hasCoverLetter ? p.proposal_text.length + ' chars' : 'MISSING'}`);
    console.log(`    URL: ${p.job_url || 'MISSING'}`);
    console.log('');
  }
}
main().catch(console.error);
