// Portable integration entrypoint: runs the full server suite against REAL
// PostgreSQL + S3-compatible storage, then the real-services vertical flow.
// Services must already be up (see docs/SAAS_ARCHITECTURE.md):
//   postgres   127.0.0.1:5433  (SAAS_TEST_DSN)
//   s3 endpoint 127.0.0.1:5001  (SAAS_TEST_S3_ENDPOINT, MinIO or moto_server)
import { spawnSync } from "node:child_process";

const env = {
  ...process.env,
  SAAS_TEST_BACKEND: "postgres",
  SAAS_TEST_DSN: process.env["SAAS_TEST_DSN"] || "postgres://postgres@127.0.0.1:5433/postgres",
  SAAS_TEST_S3: "1",
  SAAS_TEST_S3_ENDPOINT: process.env["SAAS_TEST_S3_ENDPOINT"] || "http://127.0.0.1:5001",
  SAAS_TEST_S3_KEY: process.env["SAAS_TEST_S3_KEY"] || "test",
  SAAS_TEST_S3_SECRET: process.env["SAAS_TEST_S3_SECRET"] || "test",
  SAAS_REAL_SERVICES: "1",
};

const result = spawnSync(
  process.execPath,
  ["node_modules/vitest/vitest.mjs", "run", "server/src", "--testTimeout=120000", "--hookTimeout=60000", "--fileParallelism=false"],
  {
    env,
    stdio: "inherit",
    cwd: process.cwd(),
  }
);
process.exit(result.status ?? 1);
