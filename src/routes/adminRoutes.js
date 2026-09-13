const express = require('express');
const router = express.Router();
const asyncHandler = require('../utils/asyncHandler');
const { protect } = require('../middlewares/authMiddleware');
const { allBreakerStates } = require('../utils/circuitBreaker');
const { getQueueStats, getDlq } = require('../queues/notificationQueue');

/**
 * Operational introspection. Auth-gated (any logged-in user) because this is
 * a demo project — a real deployment would put these behind an admin role or
 * expose them only on an internal port.
 */

// @desc    Circuit breaker states
// @route   GET /api/admin/circuits
const getCircuits = asyncHandler(async (req, res) => {
  res.json({ circuits: allBreakerStates() });
});

// @desc    Notification queue depth, retries and dead-letter count
// @route   GET /api/admin/queues
const getQueues = asyncHandler(async (req, res) => {
  res.json(await getQueueStats());
});

// @desc    Inspect dead-lettered jobs (what never got delivered, and why)
// @route   GET /api/admin/queues/dead-letters?limit=20
const getDeadLetters = asyncHandler(async (req, res) => {
  const dlq = getDlq();
  if (!dlq) return res.json({ enabled: false, jobs: [] });

  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  const jobs = await dlq.getJobs(['waiting', 'completed', 'failed'], 0, limit - 1);

  res.json({
    enabled: true,
    count: jobs.length,
    jobs: jobs.map((job) => ({
      id: job.id,
      name: job.name,
      originalJobId: job.data?.originalJobId,
      failedReason: job.data?.failedReason,
      attemptsMade: job.data?.attemptsMade,
      failedAt: job.data?.failedAt,
    })),
  });
});

router.get('/circuits', protect, getCircuits);
router.get('/queues', protect, getQueues);
router.get('/queues/dead-letters', protect, getDeadLetters);

module.exports = router;
