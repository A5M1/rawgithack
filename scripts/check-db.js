// Check the MongoDB connection used by the dashboard.
//
// Usage:
//   MONGODB_URI='mongodb+srv://...' npm run check-db
//   npm run check-db                 # reads .env.local
//
// This prints the database name and ping result without printing the URI.

import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI;

if (!uri) {
  console.error('MONGODB_URI is not set.');
  process.exit(1);
}

const dbName = process.env.MONGODB_DB || 'githack';
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });

try {
  await client.connect();
  const db = client.db(dbName);
  const result = await db.command({ ping: 1 });
  console.log(`MongoDB connection OK (database: ${db.databaseName})`);
  console.log(`Ping: ${JSON.stringify(result)}`);
} catch (error) {
  console.error(`MongoDB connection failed: ${error?.name || 'Error'}`);
  console.error(error?.message || String(error));
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
