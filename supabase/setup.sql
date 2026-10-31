-- =====================================================================
-- ACS Project Tracker: Supabase database setup
--
-- GENERATED from supabase/migrations by scripts/build-setup.js. Do not edit
-- this file: add a new migration and run `npm run build:setup`.
--
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- Safe to run again: it creates what is missing and never deletes data.
-- It adds no people or projects: use supabase/import-team.example.sql for the
-- real team, or supabase/seed-test-data.sql for test data.
-- =====================================================================

-- ##### 20261026120000_baseline.sql #####

-- Baseline: the whole database as of October 2026 (tables, security rules,
-- admin functions, tasks, saved minutes). Safe to run on a new database and on
-- one built by an older supabase/setup.sql.

-- ---------- Tables ----------

create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text not null unique,
  name       text not null default '',
  role       text not null default 'member' check (role in ('member', 'admin')),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.projects (
  id         text primary key,                 -- e.g. PRJ-0001
  name       text not null,
  type       text not null default 'PLC',
  client     text not null default '',
  manager    text not null default '',
  status     text not null default 'In Progress',
  priority   text not null default 'Medium',
  start_date date,
  end_date   date,
  notes      text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.assignments (
  project_id text not null references public.projects (id) on delete cascade on update cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  primary key (project_id, user_id)
);

-- Legacy (v1/v2 weekly updates): no longer used by the app. Kept so old data is not lost.
-- Once you have checked it is empty (or exported it), it can be dropped in a new migration.
create table if not exists public.weekly_updates (
  id         uuid primary key default gen_random_uuid(),
  week       text not null check (week ~ '^\d{4}-W\d{2}$'),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  project_id text not null references public.projects (id) on delete cascade on update cascade,
  done       text not null default '',
  next       text not null default '',
  blockers   text not null default '',
  status     text not null default 'On Track' check (status in ('On Track', 'At Risk', 'Delayed', 'Blocked', 'Done')),
  progress   int check (progress between 0 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (week, user_id, project_id)
);

create table if not exists public.meetings (
  id           uuid primary key default gen_random_uuid(),
  date         date not null,
  week         text check (week is null or week ~ '^\d{4}-W\d{2}$'),
  title        text not null default 'Weekly meeting',
  attendees    text not null default '',
  notes        text not null default '',
  decisions    text not null default '',
  action_items text not null default '',
  created_by   uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Upgrades for databases created by an earlier version of this script.
alter table public.projects add column if not exists priority text not null default 'Medium';
alter table public.projects drop constraint if exists projects_type_check;
alter table public.projects drop constraint if exists projects_status_check;
alter table public.projects drop constraint if exists projects_priority_check;
-- Project statuses follow the Notion "Projects" database.
update public.projects set status = case status
  when 'Active' then 'In Progress' when 'On Hold' then 'Paused'
  when 'Completed' then 'Done' when 'Closed' then 'Canceled' else status end
where status in ('Active', 'On Hold', 'Completed', 'Closed');
alter table public.projects alter column status set default 'In Progress';
-- Widened in place (Oct 2026) for the BMS department's service lines (GRMS, CRS, Service): this line runs on
-- every deploy before later migrations, so a narrower list here would reject those projects. Only ever widen it.
alter table public.projects add constraint projects_type_check
  check (type in ('PLC', 'AVEVA', 'AVEVA + PLC', 'BMS', 'GRMS', 'CRS', 'Service', 'Other'));
alter table public.projects add constraint projects_status_check
  check (status in ('Backlog', 'Planning', 'In Progress', 'Paused', 'Done', 'Canceled'));
alter table public.projects add constraint projects_priority_check check (priority in ('Low', 'Medium', 'High'));

create index if not exists weekly_updates_week_idx on public.weekly_updates (week);
create index if not exists weekly_updates_project_idx on public.weekly_updates (project_id);
create index if not exists meetings_created_by_idx on public.meetings (created_by);
create index if not exists weekly_updates_user_idx on public.weekly_updates (user_id);
create index if not exists assignments_user_idx on public.assignments (user_id);

-- ---------- Helpers ----------

create or replace function public.is_active_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and active);
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and active and role = 'admin');
$$;

create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists weekly_updates_touch on public.weekly_updates;
create trigger weekly_updates_touch before update on public.weekly_updates
  for each row execute function public.touch_updated_at();
drop trigger if exists meetings_touch on public.meetings;
create trigger meetings_touch before update on public.meetings
  for each row execute function public.touch_updated_at();

-- Every new login account gets a profile.
-- Accounts made by _create_login (the app's Team page, the import script) get the role
-- they were created with and are active. Any other new account starts INACTIVE (no access)
-- until an admin activates it, so e.g. public sign-up left on by mistake shows nothing;
-- the only exception is the very first account in an empty database, which becomes admin.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_role  text    := nullif(current_setting('acs.new_login_role', true), '');
  v_first boolean := not exists (select 1 from profiles where role = 'admin');
begin
  insert into profiles (id, email, name, role, active)
  values (
    new.id,
    lower(new.email),
    coalesce(nullif(new.raw_user_meta_data ->> 'name', ''), split_part(new.email, '@', 1)),
    coalesce(v_role, case when v_first then 'admin' else 'member' end),
    v_role is not null or v_first
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Security rules (Row Level Security) ----------
-- auth.uid() and the helper checks are wrapped in (select ...) so Postgres runs
-- them once per query instead of once per row.

alter table public.profiles       enable row level security;
alter table public.projects       enable row level security;
alter table public.assignments    enable row level security;
alter table public.weekly_updates enable row level security;
alter table public.meetings       enable row level security;

-- Remove policies from earlier versions of this script.
drop policy if exists projects_admin_write on public.projects;
drop policy if exists assignments_admin_write on public.assignments;
drop policy if exists meetings_admin_write on public.meetings;

-- profiles: everyone active can see the team list; you can always see your own row; only admins change it
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select public.is_active_member()));
drop policy if exists profiles_admin_write on public.profiles;
create policy profiles_admin_write on public.profiles for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- projects: every active member can see every project (so they can join one); admins manage them
drop policy if exists projects_read on public.projects;
create policy projects_read on public.projects for select to authenticated
  using ((select public.is_active_member()));
drop policy if exists projects_admin_insert on public.projects;
create policy projects_admin_insert on public.projects for insert to authenticated
  with check ((select public.is_admin()));
drop policy if exists projects_admin_update on public.projects;
create policy projects_admin_update on public.projects for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists projects_admin_delete on public.projects;
create policy projects_admin_delete on public.projects for delete to authenticated
  using ((select public.is_admin()));

-- assignments: everyone sees who is on which project; you can join/leave yourself; admins manage all
drop policy if exists assignments_read on public.assignments;
create policy assignments_read on public.assignments for select to authenticated
  using ((select public.is_active_member()));
drop policy if exists assignments_admin_insert on public.assignments;
drop policy if exists assignments_insert on public.assignments;
create policy assignments_insert on public.assignments for insert to authenticated
  with check ((select public.is_admin()) or (user_id = (select auth.uid()) and (select public.is_active_member())));
drop policy if exists assignments_admin_delete on public.assignments;
drop policy if exists assignments_delete on public.assignments;
create policy assignments_delete on public.assignments for delete to authenticated
  using ((select public.is_admin()) or user_id = (select auth.uid()));

-- weekly_updates: members read/write only their own, only on assigned projects; admins read all
drop policy if exists updates_read on public.weekly_updates;
create policy updates_read on public.weekly_updates for select to authenticated
  using ((select public.is_admin()) or (user_id = (select auth.uid()) and (select public.is_active_member())));
drop policy if exists updates_insert on public.weekly_updates;
create policy updates_insert on public.weekly_updates for insert to authenticated
  with check (user_id = (select auth.uid()) and (select public.is_active_member()) and ((select public.is_admin()) or exists (
    select 1 from public.assignments a where a.project_id = weekly_updates.project_id and a.user_id = (select auth.uid()))));
drop policy if exists updates_update on public.weekly_updates;
create policy updates_update on public.weekly_updates for update to authenticated
  using (user_id = (select auth.uid()) and (select public.is_active_member()))
  with check (user_id = (select auth.uid()) and (select public.is_active_member()) and ((select public.is_admin()) or exists (
    select 1 from public.assignments a where a.project_id = weekly_updates.project_id and a.user_id = (select auth.uid()))));
drop policy if exists updates_admin_delete on public.weekly_updates;
create policy updates_admin_delete on public.weekly_updates for delete to authenticated
  using ((select public.is_admin()));

-- meetings: every active member can read; admins write
drop policy if exists meetings_read on public.meetings;
create policy meetings_read on public.meetings for select to authenticated
  using ((select public.is_active_member()));
drop policy if exists meetings_admin_insert on public.meetings;
create policy meetings_admin_insert on public.meetings for insert to authenticated
  with check ((select public.is_admin()));
drop policy if exists meetings_admin_update on public.meetings;
create policy meetings_admin_update on public.meetings for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists meetings_admin_delete on public.meetings;
create policy meetings_admin_delete on public.meetings for delete to authenticated
  using ((select public.is_admin()));

-- Nothing is readable without signing in.
revoke all on public.profiles, public.projects, public.assignments, public.weekly_updates, public.meetings from anon;

-- ---------- Admin user management (used by the app's Team page) ----------

-- Internal: creates a confirmed email/password login. Not callable from the app directly.
create or replace function public._create_login(p_email text, p_password text, p_name text, p_role text)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare
  v_id uuid := gen_random_uuid();
  v_email text := lower(trim(p_email));
begin
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Invalid email: %', v_email; end if;
  if length(coalesce(p_password, '')) < 8 then raise exception 'Password must be at least 8 characters'; end if;
  if exists (select 1 from auth.users where email = v_email) then raise exception 'That user already exists'; end if;

  -- Tells handle_new_user which role to give this account (for this transaction only).
  perform set_config('acs.new_login_role', case when p_role in ('member', 'admin') then p_role else 'member' end, true);
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change)
  values ('00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', v_email,
    crypt(p_password, gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}', jsonb_build_object('name', coalesce(p_name, '')), now(), now(),
    '', '', '', '');

  insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), v_id, v_id::text,
    jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true), 'email', now(), now(), now());

  perform set_config('acs.new_login_role', '', true);
  update profiles set name = coalesce(nullif(trim(p_name), ''), name) where id = v_id;
  return v_id;
end $$;
revoke all on function public._create_login(text, text, text, text) from public, anon, authenticated;

create or replace function public.admin_create_user(p_email text, p_password text, p_name text, p_role text default 'member')
returns uuid language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admin access required'; end if;
  return public._create_login(p_email, p_password, p_name, p_role);
end $$;
revoke all on function public.admin_create_user(text, text, text, text) from public, anon;
grant execute on function public.admin_create_user(text, text, text, text) to authenticated;

create or replace function public.admin_set_password(p_user_id uuid, p_password text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if not public.is_admin() then raise exception 'Admin access required'; end if;
  if length(coalesce(p_password, '')) < 8 then raise exception 'Password must be at least 8 characters'; end if;
  update auth.users set encrypted_password = crypt(p_password, gen_salt('bf')), updated_at = now()
  where id = p_user_id;
end $$;
revoke all on function public.admin_set_password(uuid, text) from public, anon;
grant execute on function public.admin_set_password(uuid, text) to authenticated;

-- Admins must not lock themselves out.
create or replace function public.protect_last_admin() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.role = 'admin' and old.active and (new.role <> 'admin' or not new.active)
     and not exists (select 1 from profiles where role = 'admin' and active and id <> old.id) then
    raise exception 'There must be at least one active admin';
  end if;
  return new;
end $$;
drop trigger if exists profiles_protect_last_admin on public.profiles;
create trigger profiles_protect_last_admin before update on public.profiles
  for each row execute function public.protect_last_admin();

-- ---------- Tasks, sub-tasks and 3rd parties ----------
-- A task belongs to a project and a week. Everyone on the project team (and admins)
-- can see and update it; the creator or an admin can delete it. Assignees can be
-- team members (assignee_ids) and/or 3rd parties without an account (contact_ids).

create table if not exists public.contacts (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(trim(name)) > 0),
  org        text not null default '',
  created_by uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create unique index if not exists contacts_name_key on public.contacts (lower(trim(name)));

create table if not exists public.tasks (
  id           uuid primary key default gen_random_uuid(),
  project_id   text not null references public.projects (id) on delete cascade on update cascade,
  week         text not null check (week ~ '^\d{4}-W\d{2}$'),
  title        text not null check (length(trim(title)) > 0),
  notes        text not null default '',
  status       text not null default 'To Do' check (status in ('To Do', 'In Progress', 'Blocked', 'Done')),
  team         text check (team is null or team in ('PLC', 'Dev')),
  assignee_ids uuid[] not null default '{}',
  contact_ids  uuid[] not null default '{}',
  subtasks     jsonb not null default '[]'::jsonb,   -- [{ "t": "text", "done": false }]
  created_by   uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists tasks_week_idx on public.tasks (week);
create index if not exists tasks_project_idx on public.tasks (project_id);
create index if not exists tasks_created_by_idx on public.tasks (created_by);
create index if not exists contacts_created_by_idx on public.contacts (created_by);

drop trigger if exists tasks_touch on public.tasks;
create trigger tasks_touch before update on public.tasks
  for each row execute function public.touch_updated_at();

-- True when the signed-in user is on the project's team (or is an admin).
create or replace function public.on_project(p_project_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin() or (public.is_active_member() and exists (
    select 1 from assignments where project_id = p_project_id and user_id = auth.uid()));
$$;
revoke all on function public.on_project(text) from public, anon;
grant execute on function public.on_project(text) to authenticated;

alter table public.contacts enable row level security;
alter table public.tasks    enable row level security;

drop policy if exists contacts_read on public.contacts;
create policy contacts_read on public.contacts for select to authenticated using ((select public.is_active_member()));
drop policy if exists contacts_insert on public.contacts;
create policy contacts_insert on public.contacts for insert to authenticated
  with check ((select public.is_active_member()) and created_by = (select auth.uid()));
drop policy if exists contacts_update on public.contacts;
create policy contacts_update on public.contacts for update to authenticated
  using ((select public.is_admin()) or created_by = (select auth.uid()))
  with check ((select public.is_active_member()));
drop policy if exists contacts_delete on public.contacts;
create policy contacts_delete on public.contacts for delete to authenticated using ((select public.is_admin()));

drop policy if exists tasks_read on public.tasks;
create policy tasks_read on public.tasks for select to authenticated
  using (public.on_project(project_id) or ((select public.is_active_member()) and
         (created_by = (select auth.uid()) or (select auth.uid()) = any (assignee_ids))));
drop policy if exists tasks_insert on public.tasks;
create policy tasks_insert on public.tasks for insert to authenticated
  with check (created_by = (select auth.uid()) and public.on_project(project_id));
drop policy if exists tasks_update on public.tasks;
create policy tasks_update on public.tasks for update to authenticated
  using (public.on_project(project_id) or ((select public.is_active_member()) and (select auth.uid()) = any (assignee_ids)))
  with check (public.on_project(project_id) or ((select public.is_active_member()) and (select auth.uid()) = any (assignee_ids)));
drop policy if exists tasks_delete on public.tasks;
create policy tasks_delete on public.tasks for delete to authenticated
  using ((select public.is_admin()) or (created_by = (select auth.uid()) and (select public.is_active_member())));

revoke all on public.contacts, public.tasks from anon;

-- The rules above let anyone assigned to a task edit it. This stops two misuses:
-- changing who created a task, and moving a task into a project you are not on.
-- Admins, and changes made from the SQL Editor (no signed-in user), are not limited.
create or replace function public.guard_task_update() returns trigger
language plpgsql set search_path = public as $$
begin
  if auth.uid() is null or public.is_admin() then return new; end if;
  if new.created_by is distinct from old.created_by then
    raise exception 'The creator of a task cannot be changed' using errcode = '42501';
  end if;
  if new.project_id is distinct from old.project_id and not public.on_project(new.project_id) then
    raise exception 'You can only move a task to a project you are on' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public.guard_task_update() from public, anon, authenticated;
drop trigger if exists tasks_guard on public.tasks;
create trigger tasks_guard before update on public.tasks
  for each row execute function public.guard_task_update();

-- ---------- Simple weekly tasks (v3): teams, blocked reason, self-join, live updates ----------

-- Each person belongs to the PLC or Dev team; the weekly meeting groups tasks by it.
alter table public.profiles add column if not exists team text;
alter table public.profiles drop constraint if exists profiles_team_check;
alter table public.profiles add constraint profiles_team_check check (team is null or team in ('PLC', 'Dev'));

-- Why a task is blocked (shown in the meeting).
alter table public.tasks add column if not exists block_note text not null default '';

-- Live updates: the app listens for changes to these tables (still filtered by the rules above).
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['tasks', 'assignments', 'contacts', 'projects'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

-- ---------- Fast loading (one request instead of several) ----------
-- SECURITY INVOKER: these run as the signed-in user, so every rule above still applies.
-- Members get only their own data; admins also get every project and assignment.

create or replace function public.app_bootstrap(p_since text default null)
returns json language sql stable security invoker set search_path = public as $$
  select json_build_object(
    'me', (select row_to_json(p) from (select id, email, name, role, active, team from profiles where id = (select auth.uid())) p),
    'team', coalesce((select json_agg(t order by t.name) from (select id, email, name, role, active, team from profiles) t), '[]'::json),
    'projects', coalesce((select json_agg(pr order by pr.id) from projects pr), '[]'::json),
    'assignments', coalesce((select json_agg(json_build_object('project_id', a.project_id, 'user_id', a.user_id)) from assignments a), '[]'::json),
    -- Recent tasks, plus unfinished ones of any age (they keep rolling over until done).
    'tasks', coalesce((select json_agg(k order by k.created_at) from tasks k
        where p_since is null or k.week >= p_since or k.status <> 'Done'), '[]'::json),
    'contacts', coalesce((select json_agg(c order by c.name) from contacts c), '[]'::json)
  );
$$;
revoke all on function public.app_bootstrap(text) from public, anon;
grant execute on function public.app_bootstrap(text) to authenticated;

-- Saves a project and changes its team in one transaction (admins only, via the rules above).
-- Only the people the admin ticked (p_add_ids) or unticked (p_remove_ids) change, so anyone
-- who joined the project while the admin had the form open stays on it.
drop function if exists public.admin_save_project(jsonb, uuid[]);
create or replace function public.admin_save_project(p jsonb, p_add_ids uuid[], p_remove_ids uuid[])
returns json language plpgsql security invoker set search_path = public as $$
declare v_id text := nullif(trim(p ->> 'id'), ''); v_row projects;
begin
  if not public.is_admin() then raise exception 'Admin access required'; end if;
  if v_id is null then
    select 'PRJ-' || lpad((coalesce(max((substring(id from '^PRJ-(\d+)$'))::int), 0) + 1)::text, 4, '0')
      into v_id from projects;
  end if;
  insert into projects (id, name, type, status, priority, client, manager, notes, start_date, end_date)
  values (v_id, trim(p ->> 'name'), coalesce(p ->> 'type', 'Other'), coalesce(p ->> 'status', 'In Progress'),
          coalesce(p ->> 'priority', 'Medium'), coalesce(p ->> 'client', ''), coalesce(p ->> 'manager', ''),
          coalesce(p ->> 'notes', ''), nullif(p ->> 'start_date', '')::date, nullif(p ->> 'end_date', '')::date)
  on conflict (id) do update set name = excluded.name, type = excluded.type, status = excluded.status,
    priority = excluded.priority, client = excluded.client, manager = excluded.manager, notes = excluded.notes,
    start_date = excluded.start_date, end_date = excluded.end_date
  returning * into v_row;
  delete from assignments where project_id = v_id and user_id = any (coalesce(p_remove_ids, '{}'));
  insert into assignments (project_id, user_id) select v_id, unnest(coalesce(p_add_ids, '{}')) on conflict do nothing;
  return row_to_json(v_row);
end $$;
revoke all on function public.admin_save_project(jsonb, uuid[], uuid[]) from public, anon;
grant execute on function public.admin_save_project(jsonb, uuid[], uuid[]) to authenticated;

-- ---------- Saved minutes ----------
-- The Meeting tab is rebuilt from the tasks, so it changes as tasks change. An admin can
-- save the week's minutes; the saved copy (snapshot) then never changes. One per week.
-- Every active member can read saved minutes (the meetings rules above).
alter table public.meetings add column if not exists snapshot jsonb;
create unique index if not exists meetings_week_minutes_key on public.meetings (week) where snapshot is not null;

create or replace function public.admin_save_minutes(p_week text, p_snapshot jsonb)
returns json language plpgsql security invoker set search_path = public as $$
declare v_row meetings;
begin
  if not public.is_admin() then raise exception 'Admin access required'; end if;
  if p_week !~ '^\d{4}-W\d{2}$' then raise exception 'Invalid week: %', p_week; end if;
  update meetings set snapshot = p_snapshot, date = current_date, created_by = auth.uid()
  where week = p_week and snapshot is not null returning * into v_row;
  if v_row.id is null then
    insert into meetings (date, week, title, snapshot, created_by)
    values (current_date, p_week, 'Weekly meeting - ' || p_week, p_snapshot, auth.uid()) returning * into v_row;
  end if;
  return json_build_object('id', v_row.id, 'week', v_row.week, 'updated_at', v_row.updated_at,
                           'created_by', v_row.created_by, 'snapshot', v_row.snapshot);
end $$;
revoke all on function public.admin_save_minutes(text, jsonb) from public, anon;
grant execute on function public.admin_save_minutes(text, jsonb) to authenticated;

-- Internal helpers and triggers: not callable from outside.
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.protect_last_admin() from public, anon, authenticated;
revoke all on function public.touch_updated_at() from public, anon, authenticated;
revoke all on function public.is_admin() from public, anon;
revoke all on function public.is_active_member() from public, anon;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.is_active_member() to authenticated;

-- Tiny public function the daily GitHub Action calls so the free project never pauses.
create or replace function public.ping() returns text
language sql stable set search_path = '' as $$ select 'ok'::text $$;
grant execute on function public.ping() to anon, authenticated;

-- ---------- Lock old test accounts ----------
-- Earlier versions of this script created *.test accounts whose passwords were
-- published in this (public) repository. Any that still use those passwords get
-- a random password, are signed out everywhere, and are deactivated, so nobody
-- can sign in with them. Test data now lives in supabase/seed-test-data.sql.
do $$
declare r record; n int := 0;
begin
  for r in
    select u.id, u.email from auth.users u
    where u.email like '%.test@%'
      and (u.encrypted_password = extensions.crypt('Admin@2026', u.encrypted_password)
        or u.encrypted_password = extensions.crypt('Test@2026', u.encrypted_password))
  loop
    n := n + 1;
    update auth.users set encrypted_password = extensions.crypt(gen_random_uuid()::text, extensions.gen_salt('bf')),
      updated_at = now() where id = r.id;
    begin
      delete from auth.sessions where user_id = r.id;   -- sign it out everywhere
    exception when others then null;                    -- not fatal: deactivating below also blocks access
    end;
    begin
      update public.profiles set active = false where id = r.id;
    exception when others then
      raise notice '% is the only active admin, so it was left active (but its password was changed). See docs/SETUP.md, "Locked out?".', r.email;
    end;
  end loop;
  if n > 0 then raise notice 'Locked % test account(s) that still used a published password.', n; end if;
end $$;

-- ##### 20261027090000_admin_assign_tasks.sql #####

-- Admins can add a task for someone else (any week); everyone else only for themselves.
drop policy if exists tasks_insert on public.tasks;
create policy tasks_insert on public.tasks for insert to authenticated
  with check ((created_by = (select auth.uid()) or (select public.is_admin())) and public.on_project(project_id));

-- ##### 20261027100000_tasks_any_project.sql #####

-- Projects page is the weekly meeting board: everyone sees every project's tasks and
-- can add a task to any project, joined or not. Admins can add a task for anyone.

drop policy if exists tasks_read on public.tasks;
create policy tasks_read on public.tasks for select to authenticated
  using ((select public.is_active_member()));

drop policy if exists tasks_insert on public.tasks;
create policy tasks_insert on public.tasks for insert to authenticated
  with check ((select public.is_active_member()) and (created_by = (select auth.uid()) or (select public.is_admin())));

-- Edit: anyone on the project, the creator, or anyone assigned to the task.
drop policy if exists tasks_update on public.tasks;
create policy tasks_update on public.tasks for update to authenticated
  using (public.on_project(project_id) or ((select public.is_active_member()) and
         (created_by = (select auth.uid()) or (select auth.uid()) = any (assignee_ids))))
  with check ((select public.is_active_member()));

-- Only one misuse left to stop: changing who created a task (admins excepted).
create or replace function public.guard_task_update() returns trigger
language plpgsql set search_path = public as $$
begin
  if auth.uid() is null or public.is_admin() then return new; end if;
  if new.created_by is distinct from old.created_by then
    raise exception 'The creator of a task cannot be changed' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public.guard_task_update() from public, anon, authenticated;

-- ##### 20261031120000_departments.sql #####

-- Departments: the app serves more than one team from the same database.
--   AUTO = Automation (PLC / AVEVA), the original team
--   BMS  = Building Management Systems
-- Every person and every project belongs to one department. Everything that existed
-- before this migration belongs to Automation.
--
-- Each department has its own weekly board, saved minutes and email. Its sub-teams
-- (teams) are the columns of the meeting email: Automation has PLC | Dev, BMS has one.
-- Everyone can see every department's board (they open on their own); writing follows
-- the same rules as before.
--
-- Roles: 'admin' manages every department. 'lead' (shown as "Dept admin") manages
-- only their own department: its projects, people, saved minutes and tasks.

-- ---------- Departments ----------

create table if not exists public.departments (
  id            text primary key check (id ~ '^[A-Z][A-Z0-9]{1,9}$'),
  name          text not null check (length(trim(name)) > 0),
  teams         text[] not null default '{}',        -- sub-teams = meeting email columns, in order (see note below)
  project_types text[] not null default '{Other}',   -- choices offered for this department's projects (see note below)
  sort          int not null default 0,
  created_at    timestamptz not null default now()
);
insert into public.departments (id, name, teams, project_types, sort) values
  ('AUTO', 'Automation', array['PLC', 'Dev'], array['PLC', 'AVEVA', 'AVEVA + PLC', 'Other'], 1),
  ('BMS', 'BMS', array['BMS'], array['BMS', 'GRMS', 'CRS', 'Service', 'Other'], 2)
on conflict (id) do nothing;

-- ---------- Department of people, projects and saved minutes ----------

do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'projects' and column_name = 'department_id') then
    alter table public.projects add column department_id text not null default 'AUTO'
      references public.departments (id) on update cascade;
    -- First run only: projects already typed "BMS" move to the BMS department.
    update public.projects set department_id = 'BMS' where type = 'BMS';
  end if;
end $$;
alter table public.profiles add column if not exists department_id text not null default 'AUTO'
  references public.departments (id) on update cascade;
alter table public.meetings add column if not exists department_id text not null default 'AUTO'
  references public.departments (id) on update cascade;
create index if not exists projects_department_idx on public.projects (department_id);
create index if not exists profiles_department_idx on public.profiles (department_id);

-- One saved copy of the minutes per department per week (was: per week).
drop index if exists public.meetings_week_minutes_key;
create unique index if not exists meetings_dept_week_minutes_key on public.meetings (department_id, week) where snapshot is not null;

-- Note: profiles.team / tasks.team stay limited to PLC / Dev, and projects.type to the
-- baseline list (the baseline re-adds those checks on every deploy; BMS service lines
-- GRMS, CRS and Service were added there). A department with
-- one column (like BMS) needs no team: its people keep team empty. Giving a department
-- new sub-teams or project types needs a migration that widens those checks.

-- New role: department admin.
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('member', 'lead', 'admin'));

-- ---------- Helpers ----------

-- The signed-in user's department.
create or replace function public.my_department() returns text
language sql stable security definer set search_path = public as $$
  select department_id from profiles where id = auth.uid() and active;
$$;

-- True for admins, and for the department admin of this department.
create or replace function public.is_dept_admin(p_dept text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and active
    and (role = 'admin' or (role = 'lead' and department_id = p_dept)));
$$;

-- True for admins and any department admin.
create or replace function public.is_manager() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and active and role in ('admin', 'lead'));
$$;

create or replace function public.project_department(p_project_id text) returns text
language sql stable security definer set search_path = public as $$
  select department_id from projects where id = p_project_id;
$$;

-- On the project's team, or an admin of its department.
create or replace function public.on_project(p_project_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_dept_admin(public.project_department(p_project_id)) or (public.is_active_member() and exists (
    select 1 from assignments where project_id = p_project_id and user_id = auth.uid()));
$$;

revoke all on function public.my_department() from public, anon;
revoke all on function public.is_dept_admin(text) from public, anon;
revoke all on function public.is_manager() from public, anon;
revoke all on function public.project_department(text) from public, anon;
grant execute on function public.my_department() to authenticated;
grant execute on function public.is_dept_admin(text) to authenticated;
grant execute on function public.is_manager() to authenticated;
grant execute on function public.project_department(text) to authenticated;

-- ---------- Security rules ----------

alter table public.departments enable row level security;
drop policy if exists departments_read on public.departments;
create policy departments_read on public.departments for select to authenticated
  using ((select public.is_active_member()));
drop policy if exists departments_admin_insert on public.departments;
create policy departments_admin_insert on public.departments for insert to authenticated
  with check ((select public.is_admin()));
drop policy if exists departments_admin_update on public.departments;
create policy departments_admin_update on public.departments for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
-- No delete: a department with people or projects must not vanish (remove it from the SQL Editor if really needed).
revoke all on public.departments from anon;

-- profiles: admins change anyone; a department admin changes the non-admins of their own
-- department, and cannot move them to another department or make anyone admin.
drop policy if exists profiles_admin_write on public.profiles;
create policy profiles_admin_write on public.profiles for update to authenticated
  using ((select public.is_admin()) or (role <> 'admin' and public.is_dept_admin(department_id)))
  with check ((select public.is_admin()) or (role <> 'admin' and public.is_dept_admin(department_id)));

-- projects: managed by the admins of their department.
drop policy if exists projects_admin_insert on public.projects;
create policy projects_admin_insert on public.projects for insert to authenticated
  with check (public.is_dept_admin(department_id));
drop policy if exists projects_admin_update on public.projects;
create policy projects_admin_update on public.projects for update to authenticated
  using (public.is_dept_admin(department_id)) with check (public.is_dept_admin(department_id));
drop policy if exists projects_admin_delete on public.projects;
create policy projects_admin_delete on public.projects for delete to authenticated
  using (public.is_dept_admin(department_id));

-- assignments: you can join/leave yourself; the project's department admins manage all.
drop policy if exists assignments_insert on public.assignments;
create policy assignments_insert on public.assignments for insert to authenticated
  with check (public.is_dept_admin(public.project_department(project_id))
    or (user_id = (select auth.uid()) and (select public.is_active_member())));
drop policy if exists assignments_delete on public.assignments;
create policy assignments_delete on public.assignments for delete to authenticated
  using (public.is_dept_admin(public.project_department(project_id)) or user_id = (select auth.uid()));

-- tasks: department admins can add a task for anyone, and delete any task, in their department.
drop policy if exists tasks_insert on public.tasks;
create policy tasks_insert on public.tasks for insert to authenticated
  with check ((select public.is_active_member()) and
    (created_by = (select auth.uid()) or public.is_dept_admin(public.project_department(project_id))));
drop policy if exists tasks_delete on public.tasks;
create policy tasks_delete on public.tasks for delete to authenticated
  using (public.is_dept_admin(public.project_department(project_id))
    or (created_by = (select auth.uid()) and (select public.is_active_member())));

create or replace function public.guard_task_update() returns trigger
language plpgsql set search_path = public as $$
begin
  if auth.uid() is null or public.is_dept_admin(public.project_department(old.project_id)) then return new; end if;
  if new.created_by is distinct from old.created_by then
    raise exception 'The creator of a task cannot be changed' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public.guard_task_update() from public, anon, authenticated;

-- 3rd parties are shared by every department; any admin or department admin can tidy them up.
drop policy if exists contacts_update on public.contacts;
create policy contacts_update on public.contacts for update to authenticated
  using ((select public.is_manager()) or created_by = (select auth.uid()))
  with check ((select public.is_active_member()));
drop policy if exists contacts_delete on public.contacts;
create policy contacts_delete on public.contacts for delete to authenticated using ((select public.is_manager()));

-- saved minutes: written by the admins of their department.
drop policy if exists meetings_admin_insert on public.meetings;
create policy meetings_admin_insert on public.meetings for insert to authenticated
  with check (public.is_dept_admin(department_id));
drop policy if exists meetings_admin_update on public.meetings;
create policy meetings_admin_update on public.meetings for update to authenticated
  using (public.is_dept_admin(department_id)) with check (public.is_dept_admin(department_id));
drop policy if exists meetings_admin_delete on public.meetings;
create policy meetings_admin_delete on public.meetings for delete to authenticated
  using (public.is_dept_admin(department_id));

-- ---------- Functions ----------

create or replace function public._create_login(p_email text, p_password text, p_name text, p_role text)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare
  v_id uuid := gen_random_uuid();
  v_email text := lower(trim(p_email));
begin
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Invalid email: %', v_email; end if;
  if length(coalesce(p_password, '')) < 8 then raise exception 'Password must be at least 8 characters'; end if;
  if exists (select 1 from auth.users where email = v_email) then raise exception 'That user already exists'; end if;

  -- Tells handle_new_user which role to give this account (for this transaction only).
  perform set_config('acs.new_login_role', case when p_role in ('member', 'lead', 'admin') then p_role else 'member' end, true);
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change)
  values ('00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', v_email,
    crypt(p_password, gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}', jsonb_build_object('name', coalesce(p_name, '')), now(), now(),
    '', '', '', '');

  insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), v_id, v_id::text,
    jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true), 'email', now(), now(), now());

  perform set_config('acs.new_login_role', '', true);
  update profiles set name = coalesce(nullif(trim(p_name), ''), name) where id = v_id;
  return v_id;
end $$;
revoke all on function public._create_login(text, text, text, text) from public, anon, authenticated;

-- Creates an account in a department (default: your own). Department admins can create
-- members and department admins in their own department; only admins can create admins.
drop function if exists public.admin_create_user(text, text, text, text);
create or replace function public.admin_create_user(p_email text, p_password text, p_name text,
  p_role text default 'member', p_department text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_dept text := coalesce(nullif(p_department, ''), public.my_department());
  v_id uuid;
begin
  if not public.is_dept_admin(v_dept) then raise exception 'Admin access required'; end if;
  if p_role = 'admin' and not public.is_admin() then raise exception 'Only an admin can create an admin'; end if;
  if not exists (select 1 from departments where id = v_dept) then raise exception 'Unknown department: %', v_dept; end if;
  v_id := public._create_login(p_email, p_password, p_name, p_role);
  update profiles set department_id = v_dept where id = v_id;
  return v_id;
end $$;
revoke all on function public.admin_create_user(text, text, text, text, text) from public, anon;
grant execute on function public.admin_create_user(text, text, text, text, text) to authenticated;

create or replace function public.admin_set_password(p_user_id uuid, p_password text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if not (public.is_admin() or exists (select 1 from profiles
          where id = p_user_id and role <> 'admin' and public.is_dept_admin(department_id))) then
    raise exception 'Admin access required';
  end if;
  if length(coalesce(p_password, '')) < 8 then raise exception 'Password must be at least 8 characters'; end if;
  update auth.users set encrypted_password = crypt(p_password, gen_salt('bf')), updated_at = now()
  where id = p_user_id;
end $$;
revoke all on function public.admin_set_password(uuid, text) from public, anon;
grant execute on function public.admin_set_password(uuid, text) to authenticated;

create or replace function public.app_bootstrap(p_since text default null)
returns json language sql stable security invoker set search_path = public as $$
  select json_build_object(
    'me', (select row_to_json(p) from (select id, email, name, role, active, team, department_id from profiles where id = (select auth.uid())) p),
    'team', coalesce((select json_agg(t order by t.name) from (select id, email, name, role, active, team, department_id from profiles) t), '[]'::json),
    'departments', coalesce((select json_agg(d order by d.sort, d.name) from (select id, name, teams, project_types, sort from departments) d), '[]'::json),
    'projects', coalesce((select json_agg(pr order by pr.id) from projects pr), '[]'::json),
    'assignments', coalesce((select json_agg(json_build_object('project_id', a.project_id, 'user_id', a.user_id)) from assignments a), '[]'::json),
    -- Recent tasks, plus unfinished ones of any age (they keep rolling over until done).
    'tasks', coalesce((select json_agg(k order by k.created_at) from tasks k
        where p_since is null or k.week >= p_since or k.status <> 'Done'), '[]'::json),
    'contacts', coalesce((select json_agg(c order by c.name) from contacts c), '[]'::json)
  );
$$;
revoke all on function public.app_bootstrap(text) from public, anon;
grant execute on function public.app_bootstrap(text) to authenticated;

-- Saves a project (with its department) and changes its team in one transaction.
create or replace function public.admin_save_project(p jsonb, p_add_ids uuid[], p_remove_ids uuid[])
returns json language plpgsql security invoker set search_path = public as $$
declare
  v_id   text := nullif(trim(p ->> 'id'), '');
  v_dept text := coalesce(nullif(p ->> 'department_id', ''), public.project_department(v_id), public.my_department());
  v_row  projects;
begin
  if not public.is_dept_admin(v_dept) then raise exception 'Admin access required'; end if;
  if v_id is not null and exists (select 1 from projects where id = v_id)
     and not public.is_dept_admin(public.project_department(v_id)) then
    raise exception 'Admin access required';
  end if;
  if v_id is null then
    select 'PRJ-' || lpad((coalesce(max((substring(id from '^PRJ-(\d+)$'))::int), 0) + 1)::text, 4, '0')
      into v_id from projects;
  end if;
  insert into projects (id, name, type, status, priority, client, manager, notes, start_date, end_date, department_id)
  values (v_id, trim(p ->> 'name'), coalesce(nullif(p ->> 'type', ''), 'Other'), coalesce(p ->> 'status', 'In Progress'),
          coalesce(p ->> 'priority', 'Medium'), coalesce(p ->> 'client', ''), coalesce(p ->> 'manager', ''),
          coalesce(p ->> 'notes', ''), nullif(p ->> 'start_date', '')::date, nullif(p ->> 'end_date', '')::date, v_dept)
  on conflict (id) do update set name = excluded.name, type = excluded.type, status = excluded.status,
    priority = excluded.priority, client = excluded.client, manager = excluded.manager, notes = excluded.notes,
    start_date = excluded.start_date, end_date = excluded.end_date, department_id = excluded.department_id
  returning * into v_row;
  delete from assignments where project_id = v_id and user_id = any (coalesce(p_remove_ids, '{}'));
  insert into assignments (project_id, user_id) select v_id, unnest(coalesce(p_add_ids, '{}')) on conflict do nothing;
  return row_to_json(v_row);
end $$;
revoke all on function public.admin_save_project(jsonb, uuid[], uuid[]) from public, anon;
grant execute on function public.admin_save_project(jsonb, uuid[], uuid[]) to authenticated;

-- Saves (or replaces) a department's minutes for a week. Default: your own department.
drop function if exists public.admin_save_minutes(text, jsonb);
create or replace function public.admin_save_minutes(p_week text, p_snapshot jsonb, p_department text default null)
returns json language plpgsql security invoker set search_path = public as $$
declare
  v_dept text := coalesce(nullif(p_department, ''), public.my_department());
  v_row  meetings;
begin
  if not public.is_dept_admin(v_dept) then raise exception 'Admin access required'; end if;
  if p_week !~ '^\d{4}-W\d{2}$' then raise exception 'Invalid week: %', p_week; end if;
  update meetings set snapshot = p_snapshot, date = current_date, created_by = auth.uid()
  where week = p_week and department_id = v_dept and snapshot is not null returning * into v_row;
  if v_row.id is null then
    insert into meetings (date, week, title, snapshot, created_by, department_id)
    values (current_date, p_week, 'Weekly meeting - ' || p_week, p_snapshot, auth.uid(), v_dept) returning * into v_row;
  end if;
  return json_build_object('id', v_row.id, 'week', v_row.week, 'department_id', v_row.department_id,
                           'updated_at', v_row.updated_at, 'created_by', v_row.created_by, 'snapshot', v_row.snapshot);
end $$;
revoke all on function public.admin_save_minutes(text, jsonb, text) from public, anon;
grant execute on function public.admin_save_minutes(text, jsonb, text) to authenticated;

-- ##### 20261101090000_people_details.sql #####

-- People details from the company org chart: job title and org-chart team (unit), e.g.
-- "BMS Team Leader Engineer" in "B.A Execution Team B". Shown on the Team page, the By person
-- view and name tags, and used to group people in the "assign someone" lists.
-- (profiles.team stays the PLC / Dev meeting column.) Only admins can change them (profiles rules).
alter table public.profiles add column if not exists title text not null default '';
alter table public.profiles add column if not exists unit  text not null default '';

create or replace function public.app_bootstrap(p_since text default null)
returns json language sql stable security invoker set search_path = public as $$
  select json_build_object(
    'me', (select row_to_json(p) from (select id, email, name, role, active, team, department_id, title, unit from profiles where id = (select auth.uid())) p),
    'team', coalesce((select json_agg(t order by t.name) from (select id, email, name, role, active, team, department_id, title, unit from profiles) t), '[]'::json),
    'departments', coalesce((select json_agg(d order by d.sort, d.name) from (select id, name, teams, project_types, sort from departments) d), '[]'::json),
    'projects', coalesce((select json_agg(pr order by pr.id) from projects pr), '[]'::json),
    'assignments', coalesce((select json_agg(json_build_object('project_id', a.project_id, 'user_id', a.user_id)) from assignments a), '[]'::json),
    -- Recent tasks, plus unfinished ones of any age (they keep rolling over until done).
    'tasks', coalesce((select json_agg(k order by k.created_at) from tasks k
        where p_since is null or k.week >= p_since or k.status <> 'Done'), '[]'::json),
    'contacts', coalesce((select json_agg(c order by c.name) from contacts c), '[]'::json)
  );
$$;
revoke all on function public.app_bootstrap(text) from public, anon;
grant execute on function public.app_bootstrap(text) to authenticated;

select 'ACS Project Tracker setup complete' as result;
