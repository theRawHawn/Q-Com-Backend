import { Redis } from 'ioredis';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  REQUIRED_REDIS_VERSION,
  REQUIRED_REDIS_DOCKER_IMAGE,
  extractRedisServerVersion,
  formatRedisVersionMismatchError,
} from '../src/config/redisVersion.js';

export async function verifyRedisExactVersion(
  redisUrl: string = process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  expectedVersion: string = REQUIRED_REDIS_VERSION
): Promise<string> {
  if (process.env.EXPECTED_REDIS_VERSION && process.env.EXPECTED_REDIS_VERSION !== REQUIRED_REDIS_VERSION) {
    throw new Error(
      `[FATAL] Contradictory EXPECTED_REDIS_VERSION=${process.env.EXPECTED_REDIS_VERSION}. ` +
      `Authoritative QCOM Redis version is strictly ${REQUIRED_REDIS_VERSION}.`
    );
  }
  const client = new Redis(redisUrl, {
    lazyConnect: true,
    connectTimeout: 4000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });

  try {
    await client.connect();
    const info = await client.info('server');
    const actualVersion = extractRedisServerVersion(info);

    console.log(`[Redis Version Check] Target URL:       ${redisUrl.replace(/:[^:@]+@/, ':***@')}`);
    console.log(`[Redis Version Check] Expected version: redis_version:${expectedVersion} (${REQUIRED_REDIS_DOCKER_IMAGE})`);
    console.log(`[Redis Version Check] Actual version:   redis_version:${actualVersion}`);

    if (actualVersion !== expectedVersion) {
      throw new Error(formatRedisVersionMismatchError(actualVersion, expectedVersion));
    }

    console.log(`[Redis Version Check] ✓ Verified exact match: redis_version:${actualVersion}`);
    return actualVersion;
  } finally {
    try {
      await client.quit();
    } catch {
      client.disconnect();
    }
  }
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  verifyRedisExactVersion()
    .then(() => process.exit(0))
    .catch((err: any) => {
      console.error('\n' + (err?.message || err));
      process.exit(1);
    });
}
