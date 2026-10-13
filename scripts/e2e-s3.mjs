// `npm run test:e2e:s3`: testul E2E de upload pe driverul S3 (MinIO), cu un singur server de test.
// Variabila se setează aici ca să meargă la fel pe Windows și Linux. Argumentele se transmit mai departe.
import { spawnSync } from "node:child_process";

const result = spawnSync(
  process.execPath,
  ["node_modules/@playwright/test/cli.js", "test", ...process.argv.slice(2)],
  { stdio: "inherit", env: { ...process.env, E2E_TARGET: "s3" } },
);
process.exit(result.status ?? 1);
