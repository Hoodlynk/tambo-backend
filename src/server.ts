import mongoose from 'mongoose';
import app from './app';
import config from './config/config';
import connectDB from './config/database';
import { sweepExpiredMedia } from './services/evidence.service';
import { dispatchDue } from './services/webhook.service';
import { logger } from './utils/logger';
import { sweepQuietDevices } from './services/watchdog.service';

connectDB()
  .then(() => {
    const server = app.listen(config.port, () => {
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

    // Container hosts stop the old instance with SIGTERM on every deploy and
    // kill it after a grace period: finish in-flight uploads (a phone mid-theft
    // is sending evidence) instead of cutting them, then close the database.
    const shutdown = (signal: string): void => {
      logger.info({ signal }, 'shutting down');
      const forced = setTimeout(() => process.exit(1), 10_000);
      forced.unref();
      server.close(() => {
        mongoose.disconnect().finally(() => process.exit(0));
      });
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));

    // Retention: Mongo's TTL index deletes envelope DOCUMENTS, but cannot
    // cascade into GridFS - this sweep is the media half of the retention job.
    const HOURLY = 60 * 60 * 1000;
    setInterval(() => {
      sweepExpiredMedia().catch((error) => {
        logger.error({ err: error }, 'media retention sweep failed');
      });
    }, HOURLY).unref();

    // webhook retries, and first attempts a restart interrupted. A pass can
    // outlast the interval when partners time out, so passes never overlap.
    let dispatching = false;
    setInterval(() => {
      if (dispatching) return;
      dispatching = true;
      dispatchDue()
        .catch((error) => {
          logger.error({ err: error }, 'webhook retry sweep failed');
        })
        .finally(() => {
          dispatching = false;
        });
    }, 30 * 1000).unref();
    // The "went quiet" watchdog: owners hear about a phone that stopped
    // checking in (airplane mode, power-off) - see watchdog.service.
    setInterval(() => {
      sweepQuietDevices().catch((error) => {
        logger.error({ err: error }, 'quiet-device sweep failed');
      });
    }, config.watchdog.sweepIntervalSeconds * 1000).unref();
  })
  .catch((err) => {
    logger.error({ err }, 'failed to start server');
    process.exit(1);
  });
