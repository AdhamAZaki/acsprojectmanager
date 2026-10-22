-- =====================================================================
-- ACS Project Tracker: import the real projects and team
-- (from the "Projects List" Google Sheet and the 14 Oct 2026 MoM)
--
-- 1. Change v_password below to a temporary password (8+ characters).
--    Everyone signs in with it once and then uses "Change password".
-- 2. Leave v_remove_dummy = true to delete the test data
--    (DUMMY projects, *.test users, their updates and tasks).
-- 3. Paste into Supabase → SQL Editor → Run. Safe to run again:
--    existing users/projects are kept, missing ones are added.
--
-- Usernames follow the company email format: ahmed_hamdy →
-- ahmed_hamdy@advcontrolsys.com. Edit the list if an address differs.
-- =====================================================================
do $$
declare
  v_password     text    := 'CHANGE-ME';   -- <-- temporary password for every new account
  v_remove_dummy boolean := true;

  -- username, full name, role
  v_people text[][] := array[
    ['adham_zaki',          'Adham Zaki',          'admin'],
    ['ahmed_hamdy',         'Ahmed Hamdy',         'member'],
    ['ahmed_yasser',        'Ahmed Yasser',        'member'],
    ['galal_ali',           'Galal Ali',           'member'],
    ['hady_alaa',           'Hady Alaa',           'member'],
    ['hazem_shabaan',       'Hazem Shabaan',       'member'],
    ['mahmoud_dahawy',      'Mahmoud Dahawy',      'member'],
    ['mohamed_adel',        'Mohamed Adel',        'member'],
    ['mohamed_ashraf',      'Mohamed Ashraf',      'member'],
    ['tarek_khaled',        'Tarek Khaled',        'member'],
    ['abdelrahman_hesham',  'Abdelrahman Hesham',  'member'],
    ['mohamed_elsoudy',     'Mohamed ElSoudy',     'member'],
    ['abdelrahman_ashraf',  'Abdelrahman Ashraf',  'member'],
    ['marina_talat',        'Marina Talat',        'member'],
    ['ahmed_shady_mokhtar', 'Ahmed Shady Mokhtar', 'member']
  ];

  -- project name, type, status, team (comma-separated full names)
  v_projects text[][] := array[
    ['SCCT SEW',    'PLC',         'In Progress', 'Mohamed Ashraf,Ahmed Hamdy'],
    ['Zed East',    'PLC',         'In Progress', 'Mohamed ElSoudy'],
    ['Silver Sand', 'PLC',         'Paused',      'Mohamed Ashraf,Galal Ali'],
    ['PS02',        'PLC',         'In Progress', 'Tarek Khaled,Ahmed Hamdy,Ahmed Shady Mokhtar'],
    ['PS04',        'PLC',         'In Progress', 'Tarek Khaled,Ahmed Hamdy,Ahmed Shady Mokhtar'],
    ['Golden Gate', 'AVEVA + PLC', 'In Progress', 'Hazem Shabaan,Abdelrahman Ashraf,Mohamed Ashraf,Tarek Khaled'],
    ['Sodic VYE',   'AVEVA + PLC', 'In Progress', 'Mohamed Adel,Galal Ali,Mohamed ElSoudy'],
    ['Safaga Port', 'AVEVA + PLC', 'In Progress', 'Hady Alaa,Mahmoud Dahawy,Abdelrahman Ashraf,Galal Ali,Mohamed ElSoudy'],
    ['Soul',        'AVEVA + PLC', 'In Progress', 'Mohamed ElSoudy'],
    ['SCCT PH1,2',  'AVEVA',       'In Progress', 'Mahmoud Dahawy,Ahmed Yasser,Mohamed Adel'],
    ['SCCT PH3',    'AVEVA + PLC', 'In Progress', 'Hazem Shabaan,Ahmed Yasser,Mohamed Adel,Mohamed Ashraf,Ahmed Hamdy'],
    ['Sumitomo',    'AVEVA',       'In Progress', 'Marina Talat,Ahmed Yasser'],
    ['Helio Square','AVEVA',       'In Progress', 'Mahmoud Dahawy'],
    ['MTTS',        'AVEVA',       'Paused',      'Hady Alaa,Ahmed Yasser'],
    ['Emaar Dev',   'AVEVA',       'Planning',    '']
  ];

  v_domain text := 'advcontrolsys.com';
  i int; v_email text; v_id uuid; v_pid text; v_name text; v_next int;
begin
  if to_regclass('public.tasks') is null
     or not exists (select 1 from pg_constraint where conname = 'projects_type_check'
                    and pg_get_constraintdef(oid) like '%AVEVA + PLC%') then
    raise exception 'Run the latest supabase/setup.sql first (step 1), then run this import again.';
  end if;
  if v_password = 'CHANGE-ME' or length(v_password) < 8 then
    raise exception 'Set v_password (8+ characters) at the top of this script before running it.';
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
      role = case when v_people[i][3] = 'admin' then 'admin' else role end
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
