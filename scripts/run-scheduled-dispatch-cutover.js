const { Pool } = require('pg');
const { quarantineLegacyScheduledDispatches } = require('./scheduled-dispatch-cutover');
require('dotenv').config();

function buildPool() {
  return new Pool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
}

async function runScheduledDispatchCutover(pool = buildPool()) {
  const client = await pool.connect();
  try {
    const result = await quarantineLegacyScheduledDispatches(client);
    console.log(
      `Scheduled dispatch cutover quarantined ${result.scheduledPosts} parent rows, `
        + `${result.platformDispatches} platform rows, and marked `
        + `${result.postsUnverified} posts unverified.`,
    );
    return result;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  runScheduledDispatchCutover().catch((error) => {
    console.error('Scheduled dispatch cutover failed:', error);
    process.exit(1);
  });
}

module.exports = { runScheduledDispatchCutover };
