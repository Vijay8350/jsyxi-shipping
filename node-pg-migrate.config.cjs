require('dotenv').config();

/** node-pg-migrate configuration. Migrations are plain CommonJS .js files. */
module.exports = {
  dir: 'migrations',
  databaseUrl: process.env.DATABASE_URL,
  migrationsTable: 'pgmigrations',
  checkOrder: true,
  verbose: true,
};
