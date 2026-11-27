require('dotenv').config();
const connectDB = require('./config/db');
const { assertConfig } = require('./config/env');
const app = require('./app');
const { finalizeExpired } = require('./services/attemptService');

const SWEEP_MS = 60 * 1000;

const start = async () => {
  // Fail closed with a readable message if required configuration is missing.
  assertConfig();
  await connectDB();

  const PORT = process.env.PORT || 5000;
  const server = app.listen(PORT, () => {
    console.log(`Server running in ${process.env.NODE_ENV || 'development'} mode on port ${PORT}`);
  });

  // Every minute: grade attempts whose deadline (+ grace) has passed from their saved answers.
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const n = await finalizeExpired({ limit: 50 });
      if (n > 0) console.log(`[attempts] finalized ${n} expired attempt(s)`);
    } catch (err) {
      console.error('[attempts] sweep failed:', String(err && err.message).slice(0, 200));
    } finally {
      running = false;
    }
  }, SWEEP_MS);
  timer.unref();

  const shutdown = () => {
    clearInterval(timer);
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
};

start().catch((err) => {
  console.error(`Failed to start: ${err.message}`);
  process.exit(1);
});
