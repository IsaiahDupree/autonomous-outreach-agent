require("dotenv").config();
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

const statements = [
  "ALTER TABLE upwork_proposals ADD COLUMN IF NOT EXISTS payment_verified boolean",
  "ALTER TABLE upwork_proposals ADD COLUMN IF NOT EXISTS screening_question_count integer",
  "ALTER TABLE upwork_proposals ADD COLUMN IF NOT EXISTS bid_competitiveness numeric",
  "ALTER TABLE upwork_proposals ADD COLUMN IF NOT EXISTS submitted_at timestamptz",
  "ALTER TABLE analytics_snapshots ADD COLUMN IF NOT EXISTS plus_insights jsonb",
];

async function run() {
  // Supabase doesn't expose DDL via REST API directly.
  // We need to use the Supabase Dashboard SQL editor or the Management API.
  // Let's check if supabase CLI is available.
  console.log("Supabase URL:", url);
  console.log("Key length:", key ? key.length : 0);

  // Try the pg-meta API (available at /pg/query for service role on some plans)
  // Or we can use the database connection string directly
  const dbUrl = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;

  if (dbUrl) {
    console.log("Found DATABASE_URL, connecting directly...");
    // Use pg if available
    try {
      const { Client } = require("pg");
      const client = new Client({ connectionString: dbUrl });
      await client.connect();
      for (const sql of statements) {
        console.log("Running:", sql.slice(0, 80) + "...");
        await client.query(sql);
        console.log("  OK");
      }

      // Create indexes
      console.log("Creating indexes...");
      await client.query("CREATE INDEX IF NOT EXISTS idx_proposals_status ON upwork_proposals(status)").catch(() => {});
      await client.query("CREATE INDEX IF NOT EXISTS idx_proposals_created_at ON upwork_proposals(created_at)").catch(() => {});
      console.log("  OK");

      await client.end();
      console.log("\nMigration complete!");
    } catch (e) {
      console.log("pg error:", e.message);
      console.log("\nFallback: Run this SQL manually in Supabase Dashboard > SQL Editor:");
      printSql();
    }
  } else {
    console.log("\nNo DATABASE_URL found.");
    console.log("Run this SQL in Supabase Dashboard > SQL Editor:");
    printSql();
  }
}

function printSql() {
  console.log("\n--- COPY BELOW ---");
  console.log(statements.join(";\n") + ";");
  console.log("\nCREATE INDEX IF NOT EXISTS idx_proposals_status ON upwork_proposals(status);");
  console.log("CREATE INDEX IF NOT EXISTS idx_proposals_created_at ON upwork_proposals(created_at);");
  console.log("--- END ---");
}

run().catch(e => console.error(e));
