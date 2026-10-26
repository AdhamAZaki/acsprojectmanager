-- =====================================================================
-- ACS Project Tracker: import the real projects and team
--
-- This repository is PUBLIC, so this file only holds example rows.
-- Keep the real list out of git:
--   1. Copy this file to supabase/import-team.local.sql (git ignores
--      *.local.sql files) or straight into the Supabase SQL Editor.
--   2. Replace the example people and projects with the real ones.
--   3. Change v_password below to a temporary password (8+ characters).
--      Everyone signs in with it once and then uses "Change password".
--   4. Leave v_remove_dummy = true to delete the test data
--      (DUMMY projects, *.test users, their tasks).
--   5. Run it in Supabase → SQL Editor. Safe to run again:
--      existing users/projects are kept, missing ones are added.
--
-- Usernames follow the company email format: sara_ali →
-- sara_ali@advcontrolsys.com. Edit the list if an address differs.
-- =====================================================================
do $$
declare
  v_password     text    := 'CHANGE-ME';   -- <-- temporary password for every new account
  v_remove_dummy boolean := true;

  -- username, full name, role, team (PLC or Dev: decides the meeting column)
  v_people text[][] := array[
    ['sara_ali',     'Sara Ali',     'admin',  'Dev'],
    ['omar_hassan',  'Omar Hassan',  'member', 'PLC'],
    ['nour_khalil',  'Nour Khalil',  'member', 'Dev']
  ];

  -- project name, type, status, team (comma-separated full names)
  v_projects text[][] := array[
    ['Example Plant SCADA', 'AVEVA + PLC', 'In Progress', 'Sara Ali,Omar Hassan'],
    ['Example Pump Station', 'PLC',        'Planning',    'Omar Hassan'],
    ['Example Historian',   'AVEVA',       'In Progress', 'Nour Khalil']
  ];

  v_domain text := 'advcontrolsys.com';
  i int; v_email text; v_id uuid; v_pid text; v_name text; v_next int;
begin
  if to_regclass('public.tasks') is null
     or not exists (select 1 from pg_constraint where conname = 'projects_type_check'
                    and pg_get_constraintdef(oid) like '%AVEVA + PLC%') then
    raise exception 'Run the latest supabase/setup.sql first, then run this import again.';
  end if;
  if v_password = 'CHANGE-ME' or length(v_password) < 8 then
    raise exception 'Set v_password (8+ characters) at the top of this script before running it.';
  end if;

  if exists (select 1 from unnest(v_people[:][1:1]) u where u = 'sara_ali') then
    raise exception 'Replace the example people and projects with the real ones before running this script.';
  end if;

  if v_remove_dummy then
    delete from public.projects where notes = 'DUMMY DATA - replace';
    delete from auth.users where email like '%.test@' || v_domain;
    delete from public.meetings where title like '%(DUMMY)%';
  end if;

  -- Accounts
  for i in 1 .. array_length(v_people, 1) loop
    v_email := v_people[i][1] || '@' || v_domain;
    select id into v_id from auth.users where email = v_email;
    if v_id is null then
      v_id := public._create_login(v_email, v_password, v_people[i][2], v_people[i][3]);
    end if;
    update public.profiles set name = v_people[i][2], active = true,
      role = case when v_people[i][3] = 'admin' then 'admin' else role end,
      team = coalesce(team, nullif(v_people[i][4], ''))
    where id = v_id;
  end loop;

  -- Projects and assignments
  select coalesce(max((substring(id from '^PRJ-(\d+)$'))::int), 0) into v_next from public.projects;
  for i in 1 .. array_length(v_projects, 1) loop
    select id into v_pid from public.projects where lower(name) = lower(v_projects[i][1]);
    if v_pid is null then
      v_next := v_next + 1;
      v_pid := 'PRJ-' || lpad(v_next::text, 4, '0');
      insert into public.projects (id, name, type, status, priority, manager)
      values (v_pid, v_projects[i][1], v_projects[i][2], v_projects[i][3], 'Medium', '');
    end if;
    foreach v_name in array coalesce(string_to_array(nullif(v_projects[i][4], ''), ','), '{}'::text[]) loop
      insert into public.assignments (project_id, user_id)
      select v_pid, p.id from public.profiles p where lower(p.name) = lower(trim(v_name))
      on conflict do nothing;
    end loop;
  end loop;

  raise notice 'Imported % people and % projects.', array_length(v_people, 1), array_length(v_projects, 1);
end $$;

select p.name as project, p.type, p.status, string_agg(pr.name, ', ' order by pr.name) as team
from public.projects p
left join public.assignments a on a.project_id = p.id
left join public.profiles pr on pr.id = a.user_id
group by p.id, p.name, p.type, p.status order by p.id;
