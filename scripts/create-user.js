// Create or update a dashboard user.
//
// Usage:
//   MONGODB_URI=... npm run create-user -- <username> <password>
//
// The password is hashed with scrypt before it is written to MongoDB.

import { MongoClient } from 'mongodb';

import { hashPassword, isUsername } from '../lib/auth.js';
import { DEFAULT_DB_NAME } from '../lib/db.js';

const [, , username, password] = process.argv;

if (!username || !password) {
  console.error('Usage: npm run create-user -- <username> <password>');
  process.exit(1);
}

if (!isUsername(username)) {
  console.error('Username must match [A-Za-z0-9_.-]{1,64}');
  process.exit(1);
}

if (password.length < 8) {
  console.error('Password must be at least 8 characters');
  process.exit(1);
}

if (!process.env.MONGODB_URI) {
  console.error('MONGODB_URI is not set');
  process.exit(1);
}

const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();

try {
  const db = client.db(process.env.MONGODB_DB || DEFAULT_DB_NAME);
  const users = db.collection('users');

  await users.createIndex({ username: 1 }, { unique: true });
  await users.updateOne(
    { username },
    {
      $set: { passwordHash: await hashPassword(password), updatedAt: new Date() },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true },
  );

  console.log(`User "${username}" created/updated in ${db.databaseName}.users`);
} finally {
  await client.close();
}
