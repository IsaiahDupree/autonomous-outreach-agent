require('dotenv').config();
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

async function main() {
  // Get all qualified jobs (score >= 5) with full details
  const res = await fetch(url + '/rest/v1/upwork_proposals?select=job_title,score,budget,status,job_url,job_description,created_at&score=gte.5&order=score.desc', {
    headers: { apikey: key, Authorization: 'Bearer ' + key }
  });
  const jobs = await res.json();
  if (!Array.isArray(jobs)) { console.log('Error:', jobs); return; }

  // Parse posted time and proposals from description
  const parsed = jobs.map(j => {
    const desc = (j.job_description || '').toLowerCase();

    // Extract proposals count from description
    let proposals = 'unknown';
    const propMatch = desc.match(/(\d+)\s*to\s*(\d+)\s*proposal/i)
      || desc.match(/(\d+)\+?\s*proposal/i)
      || desc.match(/proposals?[:\s]*(\d+)/i);
    if (propMatch) proposals = propMatch[0];

    return {
      title: (j.job_title || '').slice(0, 70),
      score: j.score,
      budget: j.budget || 'none',
      status: j.status,
      url: j.job_url || '',
      created: j.created_at,
    };
  });

  // Status breakdown
  const byStatus = {};
  for (const j of parsed) byStatus[j.status] = (byStatus[j.status] || 0) + 1;
  console.log('=== QUALIFIED JOBS (score >= 5): ' + parsed.length + ' total ===');
  console.log('Status:', Object.entries(byStatus).map(([s,c]) => c + 'x ' + s).join(', '));

  // Sort by created_at (most recent first)
  parsed.sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());

  console.log('\n=== TOP JOBS (sorted by recency, score >= 5) ===\n');
  for (const j of parsed.slice(0, 30)) {
    const age = Math.round((Date.now() - new Date(j.created).getTime()) / 3600000);
    console.log(`  [${j.score}/10] ${j.title}`);
    console.log(`    Budget: ${j.budget} | Status: ${j.status} | Added: ${age}h ago`);
    console.log(`    ${j.url}`);
    console.log('');
  }
}
main().catch(console.error);
