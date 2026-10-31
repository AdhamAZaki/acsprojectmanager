-- =====================================================================
-- ACS Project Tracker: OPTIONAL test data (for trying the app out)
--
-- Creates 6 test logins: admin.test (admin), ahmed.test, mona.test, omar.test
-- (Automation), hany.test (BMS department admin) and laila.test (BMS), 6 dummy
-- projects (one of them BMS) and a few tasks for this week and next week.
--
-- 1. Run supabase/setup.sql first.
-- 2. Change v_password below. It is used for all 6 test logins. Never
--    commit the real value: this repository is public.
-- 3. Paste into Supabase → SQL Editor → Run.
--
-- Remove it all later with the import script (v_remove_dummy = true), or
-- delete the DUMMY projects and the *.test users by hand.
-- =====================================================================
do $$
declare
  v_password text := 'CHANGE-ME';   -- <-- pick a password (8+ characters) for the test logins
  v_domain   text := 'advcontrolsys.com';
  v_this     text := to_char(current_date, 'IYYY-"W"IW');
  v_next     text := to_char(current_date + 7, 'IYYY-"W"IW');
  v_admin uuid; v_ahmed uuid; v_mona uuid; v_omar uuid; v_hany uuid; v_laila uuid;
begin
  if to_regclass('public.tasks') is null then
    raise exception 'Run supabase/setup.sql first, then run this script again.';
  end if;
  if v_password = 'CHANGE-ME' or length(v_password) < 8 then
    raise exception 'Set v_password (8+ characters) at the top of this script before running it.';
  end if;
  if exists (select 1 from public.projects) then
    raise notice 'Test data skipped: projects already exist.';
    return;
  end if;

  select id into v_admin from auth.users where email = 'admin.test@' || v_domain;
  if v_admin is null then v_admin := public._create_login('admin.test@' || v_domain, v_password, 'Test Admin', 'admin'); end if;
  select id into v_ahmed from auth.users where email = 'ahmed.test@' || v_domain;
  if v_ahmed is null then v_ahmed := public._create_login('ahmed.test@' || v_domain, v_password, 'Ahmed (Test Engineer)', 'member'); end if;
  select id into v_mona from auth.users where email = 'mona.test@' || v_domain;
  if v_mona is null then v_mona := public._create_login('mona.test@' || v_domain, v_password, 'Mona (Test Engineer)', 'member'); end if;
  select id into v_omar from auth.users where email = 'omar.test@' || v_domain;
  if v_omar is null then v_omar := public._create_login('omar.test@' || v_domain, v_password, 'Omar (Test Engineer)', 'member'); end if;

  select id into v_hany from auth.users where email = 'hany.test@' || v_domain;
  if v_hany is null then v_hany := public._create_login('hany.test@' || v_domain, v_password, 'Hany (Test BMS Lead)', 'lead'); end if;
  select id into v_laila from auth.users where email = 'laila.test@' || v_domain;
  if v_laila is null then v_laila := public._create_login('laila.test@' || v_domain, v_password, 'Laila (Test BMS Engineer)', 'member'); end if;
  update public.profiles set department_id = 'BMS' where id in (v_hany, v_laila);

  update public.profiles set team = 'Dev' where id in (v_ahmed, v_mona) and team is null;
  update public.profiles set team = 'PLC' where id = v_omar and team is null;

  insert into public.projects (id, name, type, client, manager, status, start_date, end_date, notes) values
    ('PRJ-0001', 'Water Treatment Plant SCADA', 'AVEVA', 'Demo Client A', 'Test Admin', 'In Progress', '2026-09-01', '2027-03-31', 'DUMMY DATA - replace'),
    ('PRJ-0002', 'Packaging Line PLC Upgrade', 'PLC', 'Demo Client B', 'Test Admin', 'In Progress', '2026-08-15', '2026-12-20', 'DUMMY DATA - replace'),
    ('PRJ-0003', 'Pump Station Control Panels', 'PLC', 'Demo Client C', 'Test Admin', 'Planning', '2026-10-01', '2027-01-15', 'DUMMY DATA - replace'),
    ('PRJ-0004', 'AVEVA Historian Integration', 'AVEVA', 'Demo Client A', 'Test Admin', 'Paused', '2026-07-01', '2026-11-30', 'DUMMY DATA - replace'),
    ('PRJ-0005', 'Boiler Room Automation', 'PLC', 'Demo Client D', 'Test Admin', 'Done', '2026-03-01', '2026-09-30', 'DUMMY DATA - replace');
  insert into public.projects (id, name, type, client, manager, status, start_date, end_date, notes, department_id) values
    ('PRJ-0006', 'Hospital BMS Upgrade', 'BMS', 'Demo Client E', 'Hany (Test BMS Lead)', 'In Progress', '2026-09-15', '2027-02-28', 'DUMMY DATA - replace', 'BMS');

  insert into public.assignments (project_id, user_id) values
    ('PRJ-0001', v_ahmed), ('PRJ-0001', v_mona), ('PRJ-0002', v_ahmed), ('PRJ-0002', v_omar),
    ('PRJ-0003', v_omar), ('PRJ-0003', v_mona), ('PRJ-0004', v_ahmed),
    ('PRJ-0006', v_hany), ('PRJ-0006', v_laila);

  insert into public.tasks (project_id, week, title, status, block_note, assignee_ids, created_by) values
    ('PRJ-0001', v_this, 'Build main overview and filter screens in InTouch', 'Done', '', array[v_ahmed], v_ahmed),
    ('PRJ-0001', v_this, 'Configure alarms and trends for the filter area', 'Blocked', 'Waiting for final tag list from client', array[v_ahmed], v_ahmed),
    ('PRJ-0002', v_this, 'Migrate conveyor logic to the new CPU and test in simulation', 'In Progress', '', array[v_omar], v_omar),
    ('PRJ-0002', v_next, 'Prepare site FAT documents and checklist', 'To Do', '', array[v_omar], v_omar),
    ('PRJ-0003', v_this, 'Review IO list and electrical drawings', 'Done', '', array[v_mona], v_mona),
    ('PRJ-0003', v_next, 'Start PLC program for duty / standby pumps', 'To Do', '', array[v_mona], v_mona),
    ('PRJ-0006', v_this, 'Survey existing AHU controllers and network', 'In Progress', '', array[v_laila], v_laila),
    ('PRJ-0006', v_next, 'Prepare BMS points list for client approval', 'To Do', '', array[v_hany], v_hany);
end $$;

select 'Test data added' as result;
