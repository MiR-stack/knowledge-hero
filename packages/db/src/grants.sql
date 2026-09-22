-- Application role subject to RLS (not a superuser, no BYPASSRLS).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rag_app') THEN
    CREATE ROLE rag_app WITH LOGIN PASSWORD 'rag_app' NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO rag_app;--> statement-breakpoint
GRANT ALL ON ALL TABLES IN SCHEMA public TO rag_app;--> statement-breakpoint
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO rag_app;--> statement-breakpoint
GRANT USAGE ON ALL TYPES IN SCHEMA public TO rag_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO rag_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO rag_app;
