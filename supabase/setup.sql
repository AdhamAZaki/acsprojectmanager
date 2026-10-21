-- =====================================================================
-- ACS Project Tracker: Supabase database setup
--
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- Safe to run again: it creates what is missing and never deletes data.
-- =====================================================================

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
  type       text not null default 'PLC' check (type in ('PLC', 'AVEVA', 'Other')),
  client     text not null default '',
  manager    text not null default '',
  status     text not null default 'Active' check (status in ('Active', 'On Hold', 'Completed', 'Closed')),
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

create index if not exists weekly_updates_week_idx on public.weekly_updates (week);
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
language plpgsql as $$
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

-- Every new login account gets a profile. The very first one becomes admin.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, email, name, role)
  values (
    new.id,
    lower(new.email),
    coalesce(nullif(new.raw_user_meta_data ->> 'name', ''), split_part(new.email, '@', 1)),
    case when exists (select 1 from profiles where role = 'admin') then 'member' else 'admin' end
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Security rules (Row Level Security) ----------

alter table public.profiles       enable row level security;
alter table public.projects       enable row level security;
alter table public.assignments    enable row level security;
alter table public.weekly_updates enable row level security;
alter table public.meetings       enable row level security;

-- profiles: everyone active can see the team list; you can always see your own row; only admins change it
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_active_member());
drop policy if exists profiles_admin_write on public.profiles;
create policy profiles_admin_write on public.profiles for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- projects: members see the projects assigned to them; admins see and manage all
drop policy if exists projects_read on public.projects;
create policy projects_read on public.projects for select to authenticated
  using (public.is_admin() or (public.is_active_member() and exists (
    select 1 from public.assignments a where a.project_id = projects.id and a.user_id = auth.uid())));
drop policy if exists projects_admin_write on public.projects;
create policy projects_admin_write on public.projects for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- assignments: members see their own; admins manage all
drop policy if exists assignments_read on public.assignments;
create policy assignments_read on public.assignments for select to authenticated
  using (public.is_admin() or (user_id = auth.uid() and public.is_active_member()));
drop policy if exists assignments_admin_write on public.assignments;
create policy assignments_admin_write on public.assignments for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- weekly_updates: members read/write only their own, only on assigned projects; admins read all
drop policy if exists updates_read on public.weekly_updates;
create policy updates_read on public.weekly_updates for select to authenticated
  using (public.is_admin() or (user_id = auth.uid() and public.is_active_member()));
drop policy if exists updates_insert on public.weekly_updates;
create policy updates_insert on public.weekly_updates for insert to authenticated
  with check (user_id = auth.uid() and public.is_active_member() and (public.is_admin() or exists (
    select 1 from public.assignments a where a.project_id = weekly_updates.project_id and a.user_id = auth.uid())));
drop policy if exists updates_update on public.weekly_updates;
create policy updates_update on public.weekly_updates for update to authenticated
  using (user_id = auth.uid() and public.is_active_member())
  with check (user_id = auth.uid() and public.is_active_member() and (public.is_admin() or exists (
    select 1 from public.assignments a where a.project_id = weekly_updates.project_id and a.user_id = auth.uid())));
drop policy if exists updates_admin_delete on public.weekly_updates;
create policy updates_admin_delete on public.weekly_updates for delete to authenticated
  using (public.is_admin());

-- meetings: every active member can read; admins write
drop policy if exists meetings_read on public.meetings;
create policy meetings_read on public.meetings for select to authenticated
  using (public.is_active_member());
drop policy if exists meetings_admin_write on public.meetings;
create policy meetings_admin_write on public.meetings for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

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

  update profiles set
    name = coalesce(nullif(trim(p_name), ''), name),
    role = case when p_role in ('member', 'admin') then p_role else role end
  where id = v_id;
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

-- Tiny public function the daily GitHub Action calls so the free project never pauses.
create or replace function public.ping() returns text
language sql stable as $$ select 'ok'::text $$;
grant execute on function public.ping() to anon, authenticated;

-- =====================================================================
-- TEST DATA: dummy users, projects and updates. Delete this section
-- (or the rows) before real use. Test logins: see docs/SUPABASE.md.
-- =====================================================================
do $$
declare
  v_admin uuid; v_ahmed uuid; v_mona uuid; v_omar uuid;
begin
  if exists (select 1 from public.projects) then
    raise notice 'Test data skipped: projects already exist.';
    return;
  end if;

  select id into v_admin from auth.users where email = 'admin.test@advcontrolsys.com';
  if v_admin is null then v_admin := public._create_login('admin.test@advcontrolsys.com', 'Admin@2026', 'Adham Zaki (Admin)', 'admin'); end if;
  select id into v_ahmed from auth.users where email = 'ahmed.test@advcontrolsys.com';
  if v_ahmed is null then v_ahmed := public._create_login('ahmed.test@advcontrolsys.com', 'Test@2026', 'Ahmed (Test Engineer)', 'member'); end if;
  select id into v_mona from auth.users where email = 'mona.test@advcontrolsys.com';
  if v_mona is null then v_mona := public._create_login('mona.test@advcontrolsys.com', 'Test@2026', 'Mona (Test Engineer)', 'member'); end if;
  select id into v_omar from auth.users where email = 'omar.test@advcontrolsys.com';
  if v_omar is null then v_omar := public._create_login('omar.test@advcontrolsys.com', 'Test@2026', 'Omar (Test Engineer)', 'member'); end if;

  insert into public.projects (id, name, type, client, manager, status, start_date, end_date, notes) values
    ('PRJ-0001', 'Water Treatment Plant SCADA', 'AVEVA', 'Demo Client A', 'Adham Zaki', 'Active', '2026-09-01', '2027-03-31', 'DUMMY DATA - replace'),
    ('PRJ-0002', 'Packaging Line PLC Upgrade', 'PLC', 'Demo Client B', 'Adham Zaki', 'Active', '2026-08-15', '2026-12-20', 'DUMMY DATA - replace'),
    ('PRJ-0003', 'Pump Station Control Panels', 'PLC', 'Demo Client C', 'Adham Zaki', 'Active', '2026-10-01', '2027-01-15', 'DUMMY DATA - replace'),
    ('PRJ-0004', 'AVEVA Historian Integration', 'AVEVA', 'Demo Client A', 'Adham Zaki', 'On Hold', '2026-07-01', '2026-11-30', 'DUMMY DATA - replace'),
    ('PRJ-0005', 'Boiler Room Automation', 'PLC', 'Demo Client D', 'Adham Zaki', 'Completed', '2026-03-01', '2026-09-30', 'DUMMY DATA - replace');

  insert into public.assignments (project_id, user_id) values
    ('PRJ-0001', v_ahmed), ('PRJ-0001', v_mona), ('PRJ-0002', v_ahmed), ('PRJ-0002', v_omar),
    ('PRJ-0003', v_omar), ('PRJ-0003', v_mona), ('PRJ-0004', v_ahmed);

  insert into public.weekly_updates (week, user_id, project_id, done, next, blockers, status, progress) values
    ('2026-W42', v_ahmed, 'PRJ-0001', 'Built main overview and filter screens in InTouch', 'Alarm configuration and trends', 'Waiting for final tag list from client', 'At Risk', 35),
    ('2026-W42', v_omar, 'PRJ-0002', 'Migrated conveyor logic to new CPU, tested in simulation', 'Site FAT preparation', '', 'On Track', 60),
    ('2026-W42', v_mona, 'PRJ-0003', 'Reviewed IO list and electrical drawings', 'Start PLC program for duty/standby pumps', '', 'On Track', 15);

  insert into public.meetings (date, week, title, attendees, notes, decisions, action_items, created_by) values
    ('2026-10-15', '2026-W42', 'Weekly meeting - Week 42 (DUMMY)', 'Adham, Ahmed, Mona, Omar', 'Dummy meeting record for testing',
     'Follow up with client on SCADA tag list', 'Ahmed - get tag list from client - 2026-10-20', v_admin);
end $$;

select 'ACS Project Tracker setup complete' as result;
