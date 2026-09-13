const os = require('os');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const swaggerUi = require('swagger-ui-express');

const authRoutes = require('./routes/authRoutes');
const txnRoutes = require('./routes/txnRoutes');
const walletRoutes = require('./routes/walletRoutes');
const userRoutes = require('./routes/userRoutes');
const paymentRequestRoutes = require('./routes/paymentRequestRoutes');
const splitBillRoutes = require('./routes/splitBillRoutes');
const recurringRoutes = require('./routes/recurringRoutes');
const adminRoutes = require('./routes/adminRoutes');
const requestLogger = require('./middlewares/requestLogger');
const { globalLimiter } = require('./middlewares/rateLimiter');
const { errorHandler, notFound } = require('./middlewares/errorHandler');
const { allBreakerStates } = require('./utils/circuitBreaker');
const { getQueueStats } = require('./queues/notificationQueue');

/**
 * The OpenAPI spec is served straight from the module rather than from a
 * generated file, so the docs can never be stale relative to the running
 * code. `npm run swagger` still writes swagger-output.json for anyone who
 * wants the JSON on disk.
 */
const openApiSpec = require('./docs/openapi');

/**
 * Builds and returns the Express app WITHOUT calling app.listen() or
 * connecting to MongoDB, so tests can drive it with supertest.
 */
const app = express();

/**
 * Trust proxy — REQUIRED when running behind nginx.
 *
 * Without this, req.ip is nginx's address for every request, so all the
 * per-IP rate limiters would bucket the entire internet together: one noisy
 * client would lock out everyone, and a brute-forcer would be indistinguishable
 * from normal traffic.
 *
 * We set the NUMBER OF HOPS rather than `true`. Trusting the whole chain lets
 * a client spoof X-Forwarded-For and choose its own rate-limit bucket.
 * 0 = direct (default), 1 = behind one nginx.
 */
const TRUST_PROXY_HOPS = Number(process.env.TRUST_PROXY_HOPS || 0);
if (TRUST_PROXY_HOPS > 0) app.set('trust proxy', TRUST_PROXY_HOPS);

/** Identifies which replica served a request — makes load balancing visible. */
const INSTANCE_ID = process.env.INSTANCE_ID || os.hostname();

// Secure HTTP headers (XSS protection, hides server info, etc.)
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Structured logging + X-Request-Id correlation on every request
app.use(requestLogger);

// Echo which instance handled this request (visible through the LB)
app.use((req, res, next) => {
  res.setHeader('X-Instance-Id', INSTANCE_ID);
  next();
});

// General API protection, applies to every route below
app.use(globalLimiter);

app.use(
  '/api-docs',
  swaggerUi.serve,
  swaggerUi.setup(openApiSpec, {
    customSiteTitle: 'PhonePe Clone API',
    swaggerOptions: { persistAuthorization: true, docExpansion: 'none', tagsSorter: 'alpha' },
  })
);

/** The raw spec, for client codegen or importing into other tools. */
app.get('/api-docs.json', (req, res) => res.json(openApiSpec));

app.get('/', (req, res) => {
  res.send('PhonePe Clone Backend is running...');
});

/**
 * Liveness/readiness probe. nginx uses this for passive health checks and
 * Docker for HEALTHCHECK; it also reports circuit-breaker and queue state so
 * one call tells you whether the system's dependencies are healthy.
 */
app.get('/health', async (req, res) => {
  const mongoose = require('mongoose');
  const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];

  let queue;
  try {
    queue = await getQueueStats();
  } catch (err) {
    queue = { enabled: false, error: err.message };
  }

  const circuits = allBreakerStates();
  const anyCircuitOpen = circuits.some((c) => c.state === 'OPEN');

  res.json({
    status: 'ok',
    instance: INSTANCE_ID,
    uptimeSeconds: Math.round(process.uptime()),
    mongo: states[mongoose.connection.readyState] || 'unknown',
    queue,
    circuits,
    degraded: anyCircuitOpen, // dependencies are failing, but we're still serving
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/transactions', txnRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/users', userRoutes);
app.use('/api/payment-requests', paymentRequestRoutes);
app.use('/api/split-bills', splitBillRoutes);
app.use('/api/recurring', recurringRoutes);
app.use('/api/admin', adminRoutes);

// Must be last: 404 catch-all, then the centralized error handler
app.use(notFound);
app.use(errorHandler);

module.exports = app;
module.exports.INSTANCE_ID = INSTANCE_ID;
