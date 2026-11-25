import express from 'express';

import { handle } from './lib/app.js';

const app = express();
app.disable('x-powered-by');

// Vercel's Express integration routes every request to this app. The original
// URL, method and headers are preserved, so lib/app.js can keep doing the
// host-based routing and proxy logic.
app.use((req, res, next) => {
  handle(req, res).catch(next);
});

// Local development: `npm run dev`. On Vercel the app is imported, not run.
if (!process.env.VERCEL) {
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log(`rawgithack listening on http://localhost:${port}`);
  });
}

export default app;
