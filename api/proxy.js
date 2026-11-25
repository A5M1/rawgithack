import { handle } from '../lib/app.js';

// Vercel Node.js function entrypoint. vercel.json routes every request here;
// the function keeps the original request URL.
export default async function proxy(req, res) {
  await handle(req, res);
}
