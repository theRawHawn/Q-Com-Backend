/**
 * Single authoritative source of truth for the QCOM integration and CI Redis version.
 *
 * Local integration testing, Docker Compose definitions, and GitHub Actions CI
 * all pin to this exact Redis server version to guarantee behavioral parity across
 * Lua sliding-window rate limiting, TTL expiration semantics, and Pub/Sub handling.
 */
export const REQUIRED_REDIS_VERSION = '7.0.15';
export const REQUIRED_REDIS_DOCKER_IMAGE = 'redis:7.0.15-alpine';

export function extractRedisServerVersion(infoServerOutput: string): string {
  const match = infoServerOutput.match(/^redis_version:([^\r\n]+)/m);
  return match ? match[1].trim() : 'unknown';
}

export function formatRedisVersionMismatchError(
  actualVersion: string,
  expectedVersion: string = REQUIRED_REDIS_VERSION
): string {
  return [
    `[FATAL] Redis version mismatch detected.`,
    `  Expected Redis version: ${expectedVersion}`,
    `  Actual Redis version:   ${actualVersion}`,
    `  Integration testing and CI strictly require exact Redis ${expectedVersion} (${REQUIRED_REDIS_DOCKER_IMAGE}).`,
    `  In-memory fallback and unpinned Redis versions are prohibited.`,
    ``,
    `  How to provision Redis ${expectedVersion} without modifying system packages automatically:`,
    `    - Docker standalone:  docker run -d --name qcom-redis -p 6379:6379 ${REQUIRED_REDIS_DOCKER_IMAGE}`,
    `    - Docker Compose:     docker compose -f QCOM/backend/docker-compose.integration.yml up -d`,
    `    - Debian 12 native:   apt-get install redis-server (provides 7.0.15) && redis-server --daemonize yes`,
  ].join('\n');
}

export function assertExactRedisVersion(
  infoServerOutput: string,
  expectedVersion: string = REQUIRED_REDIS_VERSION
): string {
  const actualVersion = extractRedisServerVersion(infoServerOutput);
  if (actualVersion !== expectedVersion) {
    throw new Error(formatRedisVersionMismatchError(actualVersion, expectedVersion));
  }
  return actualVersion;
}
