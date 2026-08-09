/**
 * Parse-checks every migration's up/down SQL with the real PostgreSQL parser
 * (pg-query-emscripten, WASM). Catches syntax errors without a live server;
 * semantic checks still require `npm run migrate` against a real database.
 */
const fs = require('fs');
const path = require('path');
const PgQuery = require('pg-query-emscripten').default;

(async () => {
  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
  let failures = 0;
  for (const file of files) {
    // Fresh parser per file: the WASM build accumulates state across parses
    // and fails spuriously after many large statement blocks.
    const pgQuery = await new PgQuery();
    const migration = require(path.join(dir, file));
    const captured = [];
    const pgm = { sql: (s) => captured.push(typeof s === 'string' ? s : String(s)) };
    for (const direction of ['up', 'down']) {
      captured.length = 0;
      migration[direction](pgm);
      captured.forEach((sql, i) => {
        try {
          pgQuery.parse(sql);
        } catch (e) {
          failures++;
          console.error(`${file} ${direction} block ${i}: ${e.message.split('\n')[0]}`);
        }
      });
    }
    console.log(`${file}: parsed`);
  }
  if (failures > 0) {
    console.error(`${failures} parse error(s)`);
    process.exit(1);
  }
})();
