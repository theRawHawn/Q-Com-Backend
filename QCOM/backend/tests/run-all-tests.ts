import { testMigrations } from './migrations.test.js';
import { testSeeds } from './seeds.test.js';
import { testConstraints } from './constraints.test.js';
import { testMiddleware } from './middleware.test.js';
import { testRedisCache } from './redis-cache.test.js';
import { testAppHealth } from './app-health.test.js';
import { testJwtSecurity } from './jwt-security.test.js';
import { testAuthAndRbac } from './auth-rbac.test.js';
import { testIdorAndResourceOwnership } from './idor-resource.test.js';
import { testPricingAndTaxEngine } from './pricing-tax.test.js';
import { testBusinessModelRequirements } from './business-model.test.js';
import { runSprint4MigrationTests } from './sprint4-migration.test.js';
import { runSprint5DispatchTests } from './sprint5-dispatch.test.js';
import { runSprint6PaymentsTests } from './sprint6-payments.test.js';
import { runSprint7SettlementsTests } from './sprint7-settlements.test.js';
import { runSprint8RealtimeNotificationsTests } from './sprint8-realtime-notifications.test.js';
import { runSprint9ReturnsCancellationsTests } from './sprint9-returns-cancellations.test.js';
import { runSprint91ResilienceTests } from './sprint9-1-bloom-resilience.test.js';
import { runSprint91RemediationTests } from './sprint9-1-remediation.test.js';
import { runSprint92SubscriberCacheResilienceTests } from './sprint9-2-subscriber-cache-resilience.test.js';
import { testAuthRemediation } from './auth-remediation.test.js';

async function runAllTests() {
  console.log('===========================================================');
  console.log('  QCOM Unified Backend Engine — Automated Test Suite (Sprint 1–9.1 + Auth Remediation)');
  console.log('===========================================================');
  const start = Date.now();
  try {
    // Sprint 1 Test Suites
    await testMigrations();
    await testSeeds();
    await testConstraints();
    await testMiddleware();
    await testRedisCache();
    await testAppHealth();

    // Sprint 2 Test Suites
    await testJwtSecurity();
    await testAuthAndRbac();
    await testIdorAndResourceOwnership();
    await testAuthRemediation();

    // Sprint 3 Test Suites
    await testPricingAndTaxEngine();

    // Final Business Model Verification (Section 40 Requirements)
    await testBusinessModelRequirements();

    // Sprint 4 Consolidated Domain Migration Tests
    await runSprint4MigrationTests();

    // Sprint 5 Dispatch & Rider Assignment Tests
    await runSprint5DispatchTests();

    // Sprint 6 Payments & Payment Webhooks Tests
    await runSprint6PaymentsTests();

    // Sprint 7 Marketplace Settlement, Seller Payouts & Rider Earnings Tests
    await runSprint7SettlementsTests();

    // Sprint 8 Realtime WebSockets, Transactional Outbox & Rich Push Notifications Tests
    await runSprint8RealtimeNotificationsTests();

    // Sprint 9 Returns, Cancellations, Refunds & Reverse Logistics Tests
    await runSprint9ReturnsCancellationsTests();

    // Sprint 9.1 Database Overload Protection, Bloom Filter & Resilience Tests
    await runSprint91ResilienceTests();

    // Sprint 9.1 Remediation, Multi-Instance Synchronization & Critical Invariant Tests
    await runSprint91RemediationTests();

    // Sprint 9.2 Redis Subscriber, Stampede Protection & Cache Resilience Tests
    await runSprint92SubscriberCacheResilienceTests();

    const duration = ((Date.now() - start) / 1000).toFixed(2);
    console.log('\n===========================================================');
    console.log(`✓ ALL SPRINT 1 TO 9.2 TESTS PASSED SUCCESSFULLY in ${duration}s!`);
    console.log('===========================================================\n');
    process.exit(0);
  } catch (err: any) {
    console.error('\n❌ TEST SUITE FAILED:');
    console.error(err.stack || err.message);
    process.exit(1);
  }
}

runAllTests();
