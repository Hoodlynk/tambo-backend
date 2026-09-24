import app from './app';
import config from './config/config';
import connectDB from './config/database';
import { sweepExpiredMedia } from './services/evidence.service';
import { sweepQuietDevices } from './services/watchdog.service';

connectDB()
  .then(() => {
    app.listen(config.port, () => {
      console.log(`Server running on port ${config.port}`);
    });

    // Retention: Mongo's TTL index deletes envelope DOCUMENTS, but cannot
    // cascade into GridFS - this sweep is the media half of the retention job.
    const HOURLY = 60 * 60 * 1000;
    setInterval(() => {
      sweepExpiredMedia().catch((error) => {
        console.error('Media retention sweep failed:', error);
      });
    }, HOURLY).unref();

    // The "went quiet" watchdog: owners hear about a phone that stopped
    // checking in (airplane mode, power-off) - see watchdog.service.
    setInterval(() => {
      sweepQuietDevices().catch((error) => {
        console.error('Quiet-device sweep failed:', error);
      });
    }, config.watchdog.sweepIntervalSeconds * 1000).unref();
  })
  .catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
