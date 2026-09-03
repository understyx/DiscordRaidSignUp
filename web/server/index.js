require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { createApp } = require('./app');
const { scheduleWeeklyReset } = require('./scheduler');
const { startBulkMessageWorker } = require('./bulkMessageWorker');
const { startDemoGuildReset } = require('../services/demoGuild');

const PORT = parseInt(process.env.PORT || '8000', 10);

async function start() {
  await startDemoGuildReset();

  const app = createApp();
  app.listen(PORT, () => {
    console.log(`Web server listening on port ${PORT}`);
  });
  scheduleWeeklyReset();
  startBulkMessageWorker();
}

start().catch((error) => {
  console.error('[server] Failed to start:', error);
  process.exitCode = 1;
});
