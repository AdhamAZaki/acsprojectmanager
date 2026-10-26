-- A minimal stand-in for what Supabase provides around our schema, so the
-- migrations and security rules can be tested on plain Postgres:
-- the anon/authenticated roles, the auth schema (users, identities, sessions,
-- auth.uid()), pgcrypto in the extensions schema, and the realtime publication.
-- auth.uid() reads request.jwt.claim.sub, which tests set to "sign in" as someone.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
create schema extensions;
create extension pgcrypto schema extensions;
create schema auth;
grant usage on schema auth, extensions to authenticated, anon;
create table auth.users (
  instance_id uuid, id uuid primary key, aud text, role text, email text unique, encrypted_password text,
  email_confirmed_at timestamptz, raw_app_meta_data jsonb, raw_user_meta_data jsonb,
  created_at timestamptz, updated_at timestamptz,
  confirmation_token text, recovery_token text, email_change_token_new text, email_change text);
create table auth.identities (
  id uuid primary key, user_id uuid references auth.users on delete cascade, provider_id text, identity_data jsonb,
  provider text, last_sign_in_at timestamptz, created_at timestamptz, updated_at timestamptz);
create table auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid references auth.users on delete cascade);
create function auth.uid() returns uuid language sql stable as
  $f$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
grant execute on function auth.uid() to authenticated, anon;
set client_min_messages = error;   -- "wal_level is insufficient" warning is irrelevant here
create publication supabase_realtime;
reset client_min_messages;
-- Supabase gives these roles table/function rights by default; Row Level Security does the rest.
grant usage on schema public to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on functions to anon, authenticated;
