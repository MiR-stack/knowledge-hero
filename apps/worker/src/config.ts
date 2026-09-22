export const config = {
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  databaseUrl: process.env.DATABASE_URL ?? "postgresql://rag:rag@localhost:5434/rag",
  s3: {
    endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9000",
    accessKey: process.env.S3_ACCESS_KEY ?? "minioadmin",
    secretKey: process.env.S3_SECRET_KEY ?? "minioadmin",
    bucket: process.env.S3_BUCKET ?? "rag-documents",
    region: process.env.S3_REGION ?? "us-east-1",
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
  },
  drive: {
    trashRetentionDays: Number(process.env.TRASH_RETENTION_DAYS ?? 30),
  },
  purgeIntervalMs: Number(process.env.PURGE_INTERVAL_MS ?? 60 * 60 * 1000),
} as const;
