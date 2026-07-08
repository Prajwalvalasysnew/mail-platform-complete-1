import Redis from 'ioredis';

const host = process.env.REDIS_HOST ?? 'localhost';
const port = Number(process.env.REDIS_PORT ?? 6379);
const password = process.env.REDIS_PASSWORD || undefined;

// Shared connection options
export const redisOptions = {
  host,
  port,
  password,
  maxRetriesPerRequest: null, // Required for BullMQ
  enableReadyCheck: false,
};

// General-purpose Redis client (NOT for BullMQ - BullMQ creates its own)
export const redis = new Redis({
  host,
  port,
  password,
  lazyConnect: true,
});

export async function closeRedis(): Promise<void> {
  await redis.quit();
}
