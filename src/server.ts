import app from './app';
import config from './config/config';
import connectDB from './config/database';
import { sweepExpiredMedia } from './services/evidence.service';
import { logger } from './utils/logger';

connectDB()
  .then(() => {
    app.listen(config.port, () => {
      logger.info({ port: config.port }, 'server listening');
      // OTP codes, alerts and packs all ride on this - a wrong driver here is
      // exactly the "OTP is down but nothing errors" incident. Say it at boot.
      console.log(
        `Mail: driver=${config.mail.driver} from="${config.mail.from}"` +
          (config.mail.driver !== 'resend'
            ? ' (NOT a real provider - no email leaves this process)'
            : ''),
      );
    });

    // Retention: Mongo's TTL index deletes envelope DOCUMENTS, but cannot
    // cascade into GridFS - this sweep is the media half of the retention job.
    const HOURLY = 60 * 60 * 1000;
    setInterval(() => {
      sweepExpiredMedia().catch((error) => {
        logger.error({ err: error }, 'media retention sweep failed');
      });
    }, HOURLY).unref();
  })
  .catch((err) => {
    logger.error({ err }, 'failed to start server');
    process.exit(1);
  });
