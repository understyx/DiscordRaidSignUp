require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { createApp } = require('./app');
const { runMigrations } = require('../migrate');
const { scheduleWeeklyReset } = require('./scheduler');

const app = createApp();
const PORT = parseInt(process.env.PORT || '8000', 10);

runMigrations()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Web server listening on port ${PORT}`);
    });
    scheduleWeeklyReset();
  })
  .catch(err => {
    console.error('[migrate] Fatal error during migrations:', err);
    process.exit(1);
  });
