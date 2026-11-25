import { MongoClient } from 'mongodb';

let storePromise = null;

export const DEFAULT_DB_NAME = 'githack';

async function connect() {
  if (!process.env.MONGODB_URI) return null;

  const client = new MongoClient(process.env.MONGODB_URI, {
    maxPoolSize: 5,
    serverSelectionTimeoutMS: 5000,
  });

  await client.connect();
  const db = client.db(process.env.MONGODB_DB || DEFAULT_DB_NAME);
  const users = db.collection('users');
  const sessions = db.collection('sessions');
  const proxies = db.collection('proxies');
  const settings = db.collection('settings');

  await Promise.all([
    users.createIndex({ username: 1 }, { unique: true }),
    sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    proxies.createIndex({ owner: 1 }),
  ]);

  return {
    client,
    db,

    async getUser(username) {
      return users.findOne({ username });
    },

    async createUser(username, passwordHash) {
      await users.insertOne({
        username,
        passwordHash,
        createdAt: new Date(),
      });
    },

    async isRegistrationUsed() {
      const record = await settings.findOne({
        _id: 'registration',
        usedAt: { $exists: true },
      });
      return Boolean(record);
    },

    async reserveRegistration(secretHash) {
      try {
        const record = await settings.findOneAndUpdate(
          { _id: 'registration', usedAt: { $exists: false } },
          { $set: { usedAt: new Date(), secretHash } },
          { upsert: true, returnDocument: 'after' },
        );
        return Boolean(record);
      } catch (error) {
        if (error?.code === 11000) return false;
        throw error;
      }
    },

    async releaseRegistration(secretHash) {
      await settings.updateOne(
        { _id: 'registration', secretHash, usedAt: { $exists: true } },
        { $unset: { usedAt: '', secretHash: '' } },
      );
    },

    async createSession(tokenHash, username, expiresAt) {
      await sessions.insertOne({ _id: tokenHash, username, expiresAt });
    },

    async getSession(tokenHash) {
      const session = await sessions.findOne({ _id: tokenHash });
      if (!session) return null;

      if (session.expiresAt && session.expiresAt <= new Date()) {
        await sessions.deleteOne({ _id: tokenHash });
        return null;
      }

      return session;
    },

    async deleteSession(tokenHash) {
      await sessions.deleteOne({ _id: tokenHash });
    },

    async createProxy(record) {
      await proxies.insertOne(record);
      return record;
    },

    async getProxy(id) {
      return proxies.findOne({ _id: id });
    },

    async deleteProxy(id, owner) {
      const query = owner ? { _id: id, owner } : { _id: id };
      const result = await proxies.deleteOne(query);
      return result.deletedCount > 0;
    },

    async listProxies(owner, limit = 100) {
      return proxies
        .find(owner ? { owner } : {})
        .sort({ createdAt: -1 })
        .limit(limit)
        .toArray();
    },

    async close() {
      await client.close();
    },
  };
}

export async function getStore() {
  if (!process.env.MONGODB_URI) return null;

  if (!storePromise) {
    storePromise = connect().catch((error) => {
      storePromise = null;
      throw error;
    });
  }

  return storePromise;
}

export function resetStore() {
  storePromise = null;
}
