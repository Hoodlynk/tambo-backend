import app from './app';
import config from './config/config';
import connectDB from './config/database';
import { sweepExpiredMedia } from './services/evidence.service';

connectDB()
  .then(() => {
    app.listen(config.port, () => {
      console.log(`Server running on port ${config.port}`);
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
        console.error('Media retention sweep failed:', error);
      });
    }, HOURLY).unref();
  })
  .catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
