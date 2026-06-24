const { Queue } = require('bullmq');
const { bullMQConnection } = require('../config/redis');

const verificationQueue = new Queue('verification-checks', {
  connection: bullMQConnection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'fixed', delay: 5000 },
    removeOnComplete: { count: 10 },
    removeOnFail: { count: 20 },
  },
});

const JOBS = {
  CHECK_ALL_TIERS: 'check:all-tiers',
};

/** Trigger a full revocation sweep across all verified sellers — used by the scheduler */
const triggerVerificationCheck = () =>
  verificationQueue.add(JOBS.CHECK_ALL_TIERS, {}, { jobId: 'verification-check-run' });

module.exports = { verificationQueue, JOBS, triggerVerificationCheck };