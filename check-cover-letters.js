require('dotenv').config();
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

async function main() {
  const res = await fetch(url + '/rest/v1/upwork_proposals?select=job_title,score,status,proposal_text&status=eq.queued&score=gte.7&order=score.desc', {
    headers: { apikey: key, Authorization: 'Bearer ' + key }
  });
  const jobs = await res.json();
  console.log(`Found ${jobs.length} queued jobs with score >= 7:\n`);
  for (const j of jobs) {
    const cl = j.proposal_text || '';
    console.log(`[${j.score}/10] ${(j.job_title || '').slice(0, 60)}`);
    console.log(`  Cover letter: ${cl.length > 0 ? cl.length + ' chars' : 'EMPTY'}`);
  }
}
main().catch(console.error);
