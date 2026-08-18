'use strict';

const crypto = require('node:crypto');
const pool = require('../db');
const { sendDiscordDirectMessage } = require('../services/discordDirectMessages');

const WORKER_LOCK = 'bulk_discord_message_worker';
const MAX_ATTEMPTS = 5;
const RECIPIENTS_PER_PASS = 20;
const MIN_SEND_INTERVAL_MS = 250;
const WORKER_INTERVAL_MS = 2000;

let workerRunning = false;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePayload(value) {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function deliveryNonce(jobId, userId) {
  return crypto.createHash('sha256').update(`${jobId}:${userId}`).digest('base64url').slice(0, 25);
}

async function finishJobIfComplete(connection, jobId) {
  const [[remaining]] = await connection.query(
    `SELECT COUNT(*) AS count
     FROM bulk_message_recipients
     WHERE job_id = ? AND status IN ('pending', 'sending')`,
    [jobId]
  );
  if (Number(remaining.count) > 0) return;

  await connection.query(
    `UPDATE bulk_message_jobs
     SET status = IF(failed_count > 0, 'completed_with_errors', 'completed'),
         completed_at = NOW()
     WHERE id = ? AND status IN ('queued', 'running')`,
    [jobId]
  );
}

async function processBulkMessageQueue() {
  if (workerRunning) return;
  workerRunning = true;

  let connection;
  let hasLock = false;
  try {
    connection = await pool.getConnection();
    const [[lock]] = await connection.query('SELECT GET_LOCK(?, 0) AS acquired', [WORKER_LOCK]);
    hasLock = Boolean(lock?.acquired);
    if (!hasLock) return;

    // A process can stop between claiming and delivering. Make those rows eligible again.
    await connection.query(
      `UPDATE bulk_message_recipients
       SET status = 'pending', last_error = 'Recovered after interrupted delivery'
       WHERE status = 'sending' AND updated_at < DATE_SUB(NOW(), INTERVAL 10 MINUTE)`
    );

    for (let index = 0; index < RECIPIENTS_PER_PASS; index += 1) {
      const [[recipient]] = await connection.query(
        `SELECT r.job_id, r.discord_user_id, r.attempts, j.payload_json
         FROM bulk_message_recipients r
         JOIN bulk_message_jobs j ON j.id = r.job_id
         WHERE r.status = 'pending'
           AND r.next_attempt_at <= NOW()
           AND j.status IN ('queued', 'running')
         ORDER BY j.created_at ASC, r.discord_user_id ASC
         LIMIT 1`
      );
      if (!recipient) break;

      await connection.query(
        `UPDATE bulk_message_recipients
         SET status = 'sending', attempts = attempts + 1
         WHERE job_id = ? AND discord_user_id = ? AND status = 'pending'`,
        [recipient.job_id, recipient.discord_user_id]
      );
      await connection.query(
        `UPDATE bulk_message_jobs
         SET status = 'running', started_at = COALESCE(started_at, NOW())
         WHERE id = ? AND status = 'queued'`,
        [recipient.job_id]
      );

      let result;
      try {
        result = await sendDiscordDirectMessage(
          recipient.discord_user_id,
          parsePayload(recipient.payload_json),
          { nonce: deliveryNonce(recipient.job_id, recipient.discord_user_id) }
        );
      } catch (error) {
        result = {
          ok: false,
          retryable: true,
          retryAfterMs: 1000,
          reason: error.message,
        };
      }

      if (result.ok) {
        await connection.query(
          `UPDATE bulk_message_recipients
           SET status = 'sent', last_error = NULL
           WHERE job_id = ? AND discord_user_id = ?`,
          [recipient.job_id, recipient.discord_user_id]
        );
        await connection.query(
          'UPDATE bulk_message_jobs SET sent_count = sent_count + 1 WHERE id = ?',
          [recipient.job_id]
        );
      } else if (result.retryable && Number(recipient.attempts) + 1 < MAX_ATTEMPTS) {
        const retryAt = new Date(Date.now() + Math.max(result.retryAfterMs || 1000, 1000));
        await connection.query(
          `UPDATE bulk_message_recipients
           SET status = 'pending', next_attempt_at = ?, last_error = ?
           WHERE job_id = ? AND discord_user_id = ?`,
          [retryAt, result.reason, recipient.job_id, recipient.discord_user_id]
        );
      } else {
        await connection.query(
          `UPDATE bulk_message_recipients
           SET status = 'failed', last_error = ?
           WHERE job_id = ? AND discord_user_id = ?`,
          [result.reason, recipient.job_id, recipient.discord_user_id]
        );
        await connection.query(
          'UPDATE bulk_message_jobs SET failed_count = failed_count + 1 WHERE id = ?',
          [recipient.job_id]
        );
      }

      await finishJobIfComplete(connection, recipient.job_id);
      if (result.rateLimited) {
        // All deliveries use the same Discord routes. Keep the cross-process lock
        // and wait for Discord's exact retry window instead of hammering the next recipient.
        await wait(Math.max(result.retryAfterMs || 1000, 1000));
        continue;
      }
      await wait(Math.max(result.rateLimitDelayMs || 0, MIN_SEND_INTERVAL_MS));
    }
  } catch (error) {
    console.error('[bulk-message-worker] Delivery pass failed:', error);
  } finally {
    if (connection) {
      if (hasLock) await connection.query('SELECT RELEASE_LOCK(?)', [WORKER_LOCK]).catch(() => {});
      connection.release();
    }
    workerRunning = false;
  }
}

function startBulkMessageWorker() {
  processBulkMessageQueue();
  const timer = globalThis.setInterval(processBulkMessageQueue, WORKER_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

module.exports = {
  MAX_ATTEMPTS,
  deliveryNonce,
  processBulkMessageQueue,
  startBulkMessageWorker,
};
