// Create or update a dashboard user.
//
// Usage:
//   MONGODB_URI=... npm run create-user -- <username> <password>
//
// The password is hashed with scrypt before it is written to MongoDB.

import { MongoClient } from 'mongodb';

import { hashPassword, isReservedUsername } from '../lib/auth.js';
import { DEFAULT_DB_NAME } from '../lib/db.js';

const args = process.argv.slice(2);
const admin = args.includes('--admin');
const [username, password] = args.filter((arg) => arg !== '--admin');

if (!username || !password) {
  console.error('Usage: npm run create-user -- <username> <password> [--admin]');
  process.exit(1);
}

if (!/^[A-Za-z0-9_]{3,32}$/.test(username)) {
  console.error('Username must be 3-32 characters using only letters, numbers and underscore');
  process.exit(1);
}

if (isReservedUsername(username) && !(admin && username === 'admin')) {
  console.error(`Username "${username}" is reserved. Only "admin" can be created with --admin.`);
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
      $set: {
        passwordHash: await hashPassword(password),
        role: admin ? 'admin' : 'user',
        updatedAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true },
  );

  console.log(
    `User "${username}" created/updated in ${db.databaseName}.users (role: ${admin ? 'admin' : 'user'})`,
  );
} finally {
  await client.close();
}
