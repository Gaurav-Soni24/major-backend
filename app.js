// Builds the Express app. No listening and no database connection happen on import,
// so tests can `require('./app')` with an empty environment.
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { corsOrigins, trustProxy } = require('./config/env');
const { createLimiters } = require('./middlewares/rateLimiters');
const { noSqlGuard } = require('./middlewares/sanitize');
const { errorHandler, notFoundHandler } = require('./middlewares/errorHandler');

const isSubmissionPath = (p) => /^\/api\/submissions\/?$/.test(p) || /^\/api\/submissions\/[^/]+\/answers\/?$/.test(p);
const isFlagPath = (p) => /^\/api\/submissions\/flag\/?$/.test(p);

/**
 * @param {{ rateLimit?: boolean }} [options] rateLimit: set false to disable all limiters (tests).
 */
const createApp = ({ rateLimit = true } = {}) => {
  const app = express();
  const limiters = createLimiters({ enabled: rateLimit });

  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy());

  app.use(helmet());

  // CORS allow-list. Requests without an Origin header (curl, server-to-server) are not affected.
  app.use(
    cors((req, cb) => {
      const origin = req.get('origin');
      const list = corsOrigins();
      let allowed = !origin || list.includes(origin);
      if (!allowed && list.length === 0) {
        // Unset list: open in development, same-host only in production.
        allowed = process.env.NODE_ENV !== 'production' || (() => {
          try {
            return new URL(origin).host === req.get('host');
          } catch (e) {
            return false;
          }
        })();
      }
      cb(null, { origin: allowed, credentials: false, maxAge: 600 });
    })
  );

  if (process.env.NODE_ENV === 'development') app.use(morgan('dev'));

  // Health check: never touches the database.
  app.get('/health', (req, res) => res.status(200).json({ success: true, status: 'ok', uptime: Math.round(process.uptime()) }));
  app.get('/', (req, res) => res.send('Quizify API Server is running...'));

  // Scoped body-size limits (contract): 100 kb default, 1 mb for submit/autosave, 2 mb for flag images.
  const small = express.json({ limit: '100kb' });
  const medium = express.json({ limit: '1mb' });
  const large = express.json({ limit: '2mb' });
  app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    if (isFlagPath(req.path)) return large(req, res, next);
    if (isSubmissionPath(req.path)) return medium(req, res, next);
    return small(req, res, next);
  });

  app.use('/api', limiters.general, noSqlGuard);

  app.use('/api/auth', require('./routes/authRoutes')(limiters));
  app.use('/api/quizzes', require('./routes/quizRoutes')(limiters));
  app.use('/api/submissions', require('./routes/submitRoutes')(limiters));
  app.use('/api/ai', require('./routes/aiRoutes')(limiters));
  app.use('/api/dashboard', require('./routes/dashboardRoutes')(limiters));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
};

module.exports = createApp();
module.exports.createApp = createApp;
