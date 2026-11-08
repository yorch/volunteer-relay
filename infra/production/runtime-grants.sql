\getenv runtime_user RELAY_RUNTIME_USER
\getenv runtime_password RELAY_RUNTIME_PASSWORD
\getenv db_name PGDATABASE
\getenv admin_user PGUSER
-- The dedicated cluster is owned by the migrator/bootstrap identity.
-- Quote values server-side; never echo or print the generated password SQL.
SELECT (:'runtime_user' = :'admin_user' OR :'runtime_user' = '' OR :'runtime_password' = ''
  OR EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = :'runtime_user' AND (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls))
  OR EXISTS (SELECT 1 FROM pg_roles r JOIN pg_auth_members m ON m.member = r.oid WHERE r.rolname = :'runtime_user')
  OR EXISTS (SELECT 1 FROM pg_roles r JOIN pg_class c ON c.relowner = r.oid WHERE r.rolname = :'runtime_user')
  OR EXISTS (SELECT 1 FROM pg_roles r JOIN pg_namespace n ON n.nspowner = r.oid WHERE r.rolname = :'runtime_user')) AS invalid \gset
\if :invalid
  \echo 'Runtime identity must be distinct, nonempty, without role memberships or owned objects'
  SELECT 1 / 0;
\endif
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT', :'runtime_user')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'runtime_user') \gexec
SELECT format('ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD %L', :'runtime_user', :'runtime_password') \gexec
-- Revoke PUBLIC access throughout this dedicated cluster so runtime cannot
-- connect to another database via a default PUBLIC grant.
SELECT format('REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC', datname)
FROM pg_database WHERE datallowconn \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM %I', datname, :'runtime_user') FROM pg_database WHERE datallowconn \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'db_name', :'runtime_user') \gexec
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SELECT format('REVOKE ALL ON SCHEMA public FROM %I', :'runtime_user') \gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'runtime_user') \gexec
SELECT format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', :'runtime_user') \gexec
SELECT format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', :'runtime_user') \gexec
SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', :'runtime_user') \gexec
SELECT format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO %I', :'runtime_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', :'admin_user', :'runtime_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO %I', :'admin_user', :'runtime_user') \gexec
