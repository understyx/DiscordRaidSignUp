require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { createApp } = require('./app');
const { scheduleWeeklyReset } = require('./scheduler');
const { startBulkMessageWorker } = require('./bulkMessageWorker');

const app = createApp();
const PORT = parseInt(process.env.PORT || '8000', 10);

app.listen(PORT, () => {
  console.log(`Web server listening on port ${PORT}`);
});
scheduleWeeklyReset();
startBulkMessageWorker();
