export const config = {
  port: Number(process.env.API_PORT ?? 3001),
  host: process.env.API_HOST ?? "0.0.0.0",
  webUrl: process.env.WEB_URL ?? "http://localhost:3010",
  databaseUrl: process.env.DATABASE_URL ?? "postgresql://rag:rag@localhost:5434/rag",
  pgbouncerUrl: process.env.PGBOUNCER_URL ?? "postgresql://rag_app:rag_app@localhost:6432/rag",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  jwtSecret: process.env.JWT_SECRET ?? "dev-secret-change-in-production",
  jwtIssuer: process.env.JWT_ISSUER ?? "rag-platform",
  jwtAudience: process.env.JWT_AUDIENCE ?? "rag-api",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "7d",
  s3: {
    endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9000",
    accessKey: process.env.S3_ACCESS_KEY ?? "minioadmin",
    secretKey: process.env.S3_SECRET_KEY ?? "minioadmin",
    bucket: process.env.S3_BUCKET ?? "rag-documents",
    region: process.env.S3_REGION ?? "us-east-1",
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
  },
  drive: {
    maxFolderDepth: Number(process.env.FOLDER_MAX_DEPTH ?? 15),
    trashRetentionDays: Number(process.env.TRASH_RETENTION_DAYS ?? 30),
  },
} as const;
