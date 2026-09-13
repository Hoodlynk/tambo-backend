import mongoose from 'mongoose';
import config from './config';
import { logger } from '../utils/logger';

const connectDB = async (): Promise<void> => {
  if (!config.mongodbUri) {
    throw new Error('MONGODB_URI is not set. Cannot start without a database.');
  }

  try {
    await mongoose.connect(config.mongodbUri);

    // Uniqueness (envelope ids, tokens, one-open-episode) is enforced by
    // indexes, and mongoose builds them ASYNCHRONOUSLY after connect - a write
    // racing an unbuilt unique index can slip a duplicate in. Block startup
    // until every registered model's indexes exist.
    await Promise.all(
      mongoose.modelNames().map((name) => mongoose.model(name).createIndexes()),
    );

    logger.info('MongoDB connected');
  } catch (error) {
    logger.error({ err: error }, 'MongoDB connection error');
    throw error;
  }
};

export default connectDB;
