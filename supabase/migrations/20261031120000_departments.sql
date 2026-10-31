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
