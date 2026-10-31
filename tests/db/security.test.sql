-- Security and behaviour checks for the database. Run by tests/db/run.sh after
-- supabase/setup.sql and supabase/seed-test-data.sql. Any failed check stops
-- the run with "FAIL: ...". Passing checks print "PASS: ...".
\set ON_ERROR_STOP 1
set client_min_messages = notice;

-- ---------- Test helpers (in their own schema) ----------
create schema test;
grant usage on schema test to anon, authenticated;

-- "Signs in" as the user with this email (no role change; tests do SET ROLE).
create function test.login(p_email text) returns void language plpgsql security definer as $$
declare v uuid := (select id from public.profiles where email = p_email);
begin
  if v is null then raise exception 'FAIL: no test user %', p_email; end if;
  perform set_config('request.jwt.claim.sub', v::text, false);
end $$;
create function test.uid(p_email text) returns uuid language sql security definer stable as
  $$ select id from public.profiles where email = p_email $$;
create function test.ok(p_cond boolean, p_label text) returns void language plpgsql as $$
begin
  if p_cond is distinct from true then raise exception 'FAIL: %', p_label; end if;
  raise notice 'PASS: %', p_label;
end $$;
create function test.fails(p_sql text, p_pattern text, p_label text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm !~* p_pattern then raise exception 'FAIL: % (wrong error: %)', p_label, sqlerrm; end if;
    raise notice 'PASS: %', p_label;
    return;
  end;
  raise exception 'FAIL: % (no error)', p_label;
end $$;
create function test.n(p_sql text) returns bigint language plpgsql as $$
declare v bigint;
begin execute 'select count(*) from (' || p_sql || ') x' into v; return v; end $$;
grant execute on all functions in schema test to anon, authenticated;

-- Seeded data (supabase/seed-test-data.sql):
--   admin.test (admin) · ahmed.test on PRJ-0001, 0002, 0004 · mona.test on 0001, 0003 · omar.test on 0002, 0003
--   BMS department: hany.test (department admin) and laila.test on PRJ-0006; everything else is Automation

-- ---------- Signed-out visitors ----------
set role anon;
select test.fails('select * from public.projects', 'permission denied', 'signed-out: cannot read projects');
select test.fails('select * from public.tasks', 'permission denied', 'signed-out: cannot read tasks');
select test.fails('select * from public.profiles', 'permission denied', 'signed-out: cannot read the team');
select test.ok((select public.ping()) = 'ok', 'signed-out: keep-alive ping works');
reset role;

-- ---------- Old test accounts (handled by running setup.sql a second time) ----------
select test.ok(not active, 'legacy.test account with a published password was deactivated')
  from public.profiles where email = 'legacy.test@advcontrolsys.com';
select test.ok(encrypted_password <> extensions.crypt('Test@2026', encrypted_password), 'legacy.test password was changed')
  from auth.users where email = 'legacy.test@advcontrolsys.com';

-- ---------- New accounts start inactive ----------
insert into auth.users (id, email, raw_user_meta_data) values (gen_random_uuid(), 'stranger@example.com', '{}');
select test.ok(not active and role = 'member', 'account not made by an admin starts inactive')
  from public.profiles where email = 'stranger@example.com';
select test.login('stranger@example.com');
set role authenticated;
select test.ok(test.n('select * from public.projects') = 0, 'inactive account sees no projects');
select test.ok(test.n('select * from public.tasks') = 0, 'inactive account sees no tasks');
reset role;

-- ---------- Members ----------
select test.login('ahmed.test@advcontrolsys.com');
set role authenticated;
select test.ok(test.n('select * from public.projects') = 6, 'member sees every project, in every department (to join one)');
select test.ok(test.n($$select * from public.tasks where project_id = 'PRJ-0001'$$) > 0, 'member sees tasks of their project');
insert into public.tasks (project_id, week, title) values ('PRJ-0003', '2026-W44', 'helping on another project');
select test.ok(test.n($$select * from public.tasks where project_id = 'PRJ-0003' and created_by = auth.uid()$$) = 1, 'member can add a task to a project they are not on');
select test.fails($$insert into public.tasks (project_id, week, title, created_by) values ('PRJ-0003', '2026-W44', 'in mona''s name', test.uid('mona.test@advcontrolsys.com'))$$,
  'row-level security', 'member cannot add a task in someone else''s name (any project)');
select test.fails($$update public.tasks set created_by = test.uid('mona.test@advcontrolsys.com') where title like 'Build main%'$$,
  'creator of a task cannot be changed', 'member cannot change who created a task');
update public.tasks set title = 'helping on another project (edited)' where title = 'helping on another project';
select test.ok(test.n($$select * from public.tasks where title = 'helping on another project (edited)'$$) = 1, 'member can edit their own task on a project they are not on');
select test.ok(test.n($$select * from public.tasks where title like 'Start PLC%'$$) = 1, 'member sees tasks of every project (the meeting board)');
update public.tasks set notes = 'not mine' where title like 'Start PLC%';
select test.ok(test.n($$select * from public.tasks where title like 'Start PLC%' and notes = 'not mine'$$) = 0, 'member cannot edit someone else''s task on a project they are not on');
update public.tasks set project_id = 'PRJ-0002' where title like 'Build main%';
select test.ok(test.n($$select * from public.tasks where title like 'Build main%' and project_id = 'PRJ-0002'$$) = 1,
  'member can move a task between their own projects');
update public.projects set name = 'hacked' where id = 'PRJ-0001';
update public.profiles set role = 'admin' where id = auth.uid();
reset role;
select test.ok((select name from public.projects where id = 'PRJ-0001') <> 'hacked', 'member cannot rename a project');
select test.ok((select role from public.profiles where email = 'ahmed.test@advcontrolsys.com') = 'member', 'member cannot make themselves admin');
select test.login('ahmed.test@advcontrolsys.com');
set role authenticated;
select test.fails($$select public.admin_create_user('x@advcontrolsys.com', 'Password1', 'X')$$, 'admin access required', 'member cannot create accounts');
select test.fails($$select public.admin_set_password(auth.uid(), 'Password1')$$, 'admin access required', 'member cannot reset passwords');
select test.fails($$select public._create_login('x@advcontrolsys.com', 'Password1', 'X', 'admin')$$, 'permission denied', 'member cannot call the internal login function');
select test.fails($$select public.admin_save_minutes('2026-W44', '{}')$$, 'admin access required', 'member cannot save minutes');
select test.fails($$insert into public.assignments (project_id, user_id) values ('PRJ-0003', test.uid('omar.test@advcontrolsys.com'))$$,
  'row-level security', 'member cannot add someone else to a project');
insert into public.assignments (project_id, user_id) values ('PRJ-0003', auth.uid());
select test.ok(test.n($$select * from public.tasks where project_id = 'PRJ-0003'$$) > 0, 'member can join a project and sees its tasks');
delete from public.assignments where project_id = 'PRJ-0003' and user_id = auth.uid();

-- An assignee who is not on the project can edit the task and move it
reset role;
select test.login('mona.test@advcontrolsys.com');
set role authenticated;
update public.tasks set assignee_ids = assignee_ids || test.uid('ahmed.test@advcontrolsys.com') where title like 'Review IO%';
reset role;
select test.login('ahmed.test@advcontrolsys.com');
set role authenticated;
update public.tasks set notes = 'checked' where title like 'Review IO%';
select test.ok(test.n($$select * from public.tasks where title like 'Review IO%' and notes = 'checked'$$) = 1, 'assignee can edit a task on a project they are not on');
update public.tasks set project_id = 'PRJ-0005' where title like 'Review IO%';
select test.ok(test.n($$select * from public.tasks where title like 'Review IO%' and project_id = 'PRJ-0005'$$) = 1, 'assignee can move a task to any project');

-- Two people saving the same task: the second save, based on the old version, changes nothing
reset role;
select test.login('mona.test@advcontrolsys.com');
set role authenticated;
select updated_at as v0 from public.tasks where title like 'Start PLC%' \gset
update public.tasks set notes = 'first' where title like 'Start PLC%' and updated_at = :'v0';
update public.tasks set notes = 'second' where title like 'Start PLC%' and updated_at = :'v0';
select test.ok((select notes from public.tasks where title like 'Start PLC%') = 'first', 'save based on an old version is refused (no lost edits)');

-- Startup data keeps unfinished tasks of any age
reset role;
insert into public.tasks (project_id, week, title, status, created_by, assignee_ids) values
  ('PRJ-0001', to_char(current_date - 280, 'IYYY-"W"IW'), 'very old open task', 'To Do', test.uid('ahmed.test@advcontrolsys.com'), '{}'),
  ('PRJ-0001', to_char(current_date - 280, 'IYYY-"W"IW'), 'very old done task', 'Done', test.uid('ahmed.test@advcontrolsys.com'), '{}');
select test.login('ahmed.test@advcontrolsys.com');
set role authenticated;
select test.ok(
  (select count(*) from json_array_elements(public.app_bootstrap(to_char(current_date - 182, 'IYYY-"W"IW')) -> 'tasks') t
   where t ->> 'title' = 'very old open task') = 1
  and (select count(*) from json_array_elements(public.app_bootstrap(to_char(current_date - 182, 'IYYY-"W"IW')) -> 'tasks') t
   where t ->> 'title' = 'very old done task') = 0,
  'startup data keeps old unfinished tasks and drops old finished ones');
reset role;

-- ---------- Admins ----------
select test.login('admin.test@advcontrolsys.com');
set role authenticated;
select public.admin_create_user('new.person@advcontrolsys.com', 'Password1', 'New Person') as new_id \gset
select test.ok((select active and role = 'member' from public.profiles where id = :'new_id'), 'account created by an admin is an active member');
update public.tasks set created_by = test.uid('mona.test@advcontrolsys.com') where title like 'Build main%';
select test.ok(test.n($$select * from public.tasks where title like 'Build main%' and created_by = test.uid('mona.test@advcontrolsys.com')$$) = 1,
  'admin can change who created a task');
select test.fails($$update public.profiles set role = 'member' where id = auth.uid()$$, 'at least one active admin', 'the last admin cannot demote themselves');

-- Project save only changes the people the admin changed
reset role;
select test.login('omar.test@advcontrolsys.com');
set role authenticated;
insert into public.assignments (project_id, user_id) values ('PRJ-0001', auth.uid());   -- Omar joins while the admin edits
reset role;
select test.login('admin.test@advcontrolsys.com');
set role authenticated;
select public.admin_save_project(jsonb_build_object('id', 'PRJ-0001', 'name', 'Water Treatment Plant SCADA', 'type', 'AVEVA', 'status', 'In Progress'),
  array[test.uid('ahmed.test@advcontrolsys.com')], array[test.uid('mona.test@advcontrolsys.com')]);
select test.ok(
  (select array_agg(p.email order by p.email) from public.assignments a join public.profiles p on p.id = a.user_id where a.project_id = 'PRJ-0001')
  = array['ahmed.test@advcontrolsys.com', 'omar.test@advcontrolsys.com'],
  'project save removes only the unticked person and keeps someone who joined meanwhile');
select test.ok(public.admin_save_project(jsonb_build_object('name', 'Brand new'), '{}', '{}') ->> 'id' = 'PRJ-0007', 'new project gets the next id');

-- Admins can add a task for someone else; members cannot
insert into public.tasks (project_id, week, title, created_by, assignee_ids)
  values ('PRJ-0001', '2026-W47', 'admin planned task', test.uid('mona.test@advcontrolsys.com'), array[test.uid('mona.test@advcontrolsys.com')]);
select test.ok(test.n($$select * from public.tasks where title = 'admin planned task' and created_by = test.uid('mona.test@advcontrolsys.com')$$) = 1,
  'admin can add a task for someone else in any week');
reset role;
select test.login('ahmed.test@advcontrolsys.com');
set role authenticated;
select test.fails($$insert into public.tasks (project_id, week, title, created_by) values ('PRJ-0001', '2026-W45', 'for mona', test.uid('mona.test@advcontrolsys.com'))$$,
  'row-level security', 'member cannot add a task in someone else''s name');
reset role;
select test.login('admin.test@advcontrolsys.com');
set role authenticated;

-- Saved minutes: one per week, replaced on a second save, readable by members
select public.admin_save_minutes('2026-W44', '{"v": 1, "n": 1}');
select public.admin_save_minutes('2026-W44', '{"v": 1, "n": 2}');
select test.ok((select count(*) = 1 and max(snapshot ->> 'n') = '2' from public.meetings where week = '2026-W44'), 'saving minutes twice keeps one copy, the newest');
select test.fails($$select public.admin_save_minutes('W44', '{}')$$, 'invalid week', 'minutes need a valid week');
reset role;
select test.login('mona.test@advcontrolsys.com');
set role authenticated;
select test.ok(test.n($$select * from public.meetings where week = '2026-W44' and snapshot is not null$$) = 1, 'members can read saved minutes');
reset role;

-- ---------- Departments ----------
select test.ok((select array_agg(id order by sort) from public.departments) = array['AUTO', 'BMS'], 'Automation and BMS departments exist');
select test.ok((select department_id from public.projects where id = 'PRJ-0001') = 'AUTO', 'existing projects belong to Automation');
select test.ok((select department_id from public.profiles where email = 'hany.test@advcontrolsys.com') = 'BMS', 'BMS people belong to BMS');

-- Department admin (BMS): manages BMS only
select test.login('hany.test@advcontrolsys.com');
set role authenticated;
select test.ok(test.n('select * from public.projects') = 7, 'department admin sees every department''s projects');
select test.ok(public.admin_save_project(jsonb_build_object('name', 'BMS lead project', 'type', 'BMS'), '{}', '{}') ->> 'department_id' = 'BMS',
  'department admin creates a project in their own department');
select test.fails($$select public.admin_save_project(jsonb_build_object('name', 'Sneaky', 'department_id', 'AUTO'), '{}', '{}')$$,
  'admin access required', 'department admin cannot create a project in another department');
select test.fails($$select public.admin_save_project(jsonb_build_object('id', 'PRJ-0002', 'name', 'Taken over', 'department_id', 'BMS'), '{}', '{}')$$,
  'admin access required', 'department admin cannot take over another department''s project');
update public.projects set name = 'hacked' where id = 'PRJ-0002';
select test.fails($$update public.projects set department_id = 'AUTO' where id = 'PRJ-0006'$$,
  'row-level security', 'department admin cannot move a project out of their department');
reset role;
select test.ok((select name from public.projects where id = 'PRJ-0002') <> 'hacked', 'department admin cannot edit another department''s project');
select test.login('hany.test@advcontrolsys.com');
set role authenticated;
insert into public.assignments (project_id, user_id) values ('PRJ-0006', test.uid('ahmed.test@advcontrolsys.com'));
select test.ok(test.n($$select * from public.assignments where project_id = 'PRJ-0006' and user_id = test.uid('ahmed.test@advcontrolsys.com')$$) = 1,
  'department admin can put anyone on their department''s project');
select test.fails($$insert into public.assignments (project_id, user_id) values ('PRJ-0002', test.uid('laila.test@advcontrolsys.com'))$$,
  'row-level security', 'department admin cannot staff another department''s project');
insert into public.tasks (project_id, week, title, created_by, assignee_ids)
  values ('PRJ-0006', '2026-W45', 'lead planned task', test.uid('laila.test@advcontrolsys.com'), array[test.uid('laila.test@advcontrolsys.com')]);
select test.ok(test.n($$select * from public.tasks where title = 'lead planned task'$$) = 1, 'department admin can add a task for someone in their department');
select test.fails($$insert into public.tasks (project_id, week, title, created_by) values ('PRJ-0002', '2026-W45', 'for omar', test.uid('omar.test@advcontrolsys.com'))$$,
  'row-level security', 'department admin cannot add a task for someone on another department''s project');
delete from public.tasks where title like 'Migrate conveyor%';
select test.ok(test.n($$select * from public.tasks where title like 'Migrate conveyor%'$$) = 1, 'department admin cannot delete another department''s tasks');
-- People
select public.admin_create_user('bms.new@advcontrolsys.com', 'Password1', 'BMS New') as bms_new \gset
select test.ok((select department_id = 'BMS' and role = 'member' and active from public.profiles where id = :'bms_new'),
  'department admin creates accounts in their own department');
select test.fails($$select public.admin_create_user('x2@advcontrolsys.com', 'Password1', 'X', 'member', 'AUTO')$$,
  'admin access required', 'department admin cannot create accounts in another department');
select test.fails($$select public.admin_create_user('x3@advcontrolsys.com', 'Password1', 'X', 'admin')$$,
  'only an admin', 'department admin cannot create an admin');
update public.profiles set name = 'Laila Renamed' where email = 'laila.test@advcontrolsys.com';
select test.ok(test.n($$select * from public.profiles where name = 'Laila Renamed'$$) = 1, 'department admin can edit people in their department');
select public.admin_set_password(test.uid('laila.test@advcontrolsys.com'), 'Password2');
select test.ok(true, 'department admin can reset a password in their department');
select test.fails($$select public.admin_set_password(test.uid('ahmed.test@advcontrolsys.com'), 'Password2')$$,
  'admin access required', 'department admin cannot reset a password in another department');
update public.profiles set name = 'hacked' where email = 'ahmed.test@advcontrolsys.com';
select test.fails($$update public.profiles set department_id = 'AUTO' where email = 'laila.test@advcontrolsys.com'$$,
  'row-level security', 'department admin cannot move someone to another department');
select test.fails($$update public.profiles set role = 'admin' where id = auth.uid()$$,
  'row-level security', 'department admin cannot make themselves admin');
reset role;
select test.ok((select name from public.profiles where email = 'ahmed.test@advcontrolsys.com') <> 'hacked', 'department admin cannot edit people in another department');
-- Saved minutes: one copy per department per week
select test.login('hany.test@advcontrolsys.com');
set role authenticated;
select public.admin_save_minutes('2026-W44', '{"v": 1, "dept": "BMS"}');
select test.ok((select count(*) = 2 from public.meetings where week = '2026-W44' and snapshot is not null), 'each department keeps its own minutes for the same week');
select test.ok((select snapshot ->> 'n' from public.meetings where week = '2026-W44' and department_id = 'AUTO') = '2', 'saving BMS minutes leaves Automation''s alone');
select test.fails($$select public.admin_save_minutes('2026-W44', '{}', 'AUTO')$$, 'admin access required', 'department admin cannot save another department''s minutes');
select test.ok((select public.app_bootstrap() -> 'me' ->> 'department_id') = 'BMS'
  and json_array_length(public.app_bootstrap() -> 'departments') = 2, 'startup data includes your department and the department list');
reset role;

-- A member cannot change departments
select test.login('laila.test@advcontrolsys.com');
set role authenticated;
update public.departments set name = 'hacked';
update public.profiles set department_id = 'AUTO' where id = auth.uid();
select test.fails($$select public.admin_save_minutes('2026-W45', '{}')$$, 'admin access required', 'BMS member cannot save minutes');
reset role;
select test.ok((select count(*) from public.departments where name = 'hacked') = 0, 'members cannot rename a department');
select test.ok((select department_id from public.profiles where email = 'laila.test@advcontrolsys.com') = 'BMS', 'members cannot change their own department');

-- Admins manage every department
select test.login('admin.test@advcontrolsys.com');
set role authenticated;
select test.ok(public.admin_save_project(jsonb_build_object('id', 'PRJ-0006', 'name', 'Hospital BMS Upgrade', 'type', 'BMS', 'department_id', 'BMS'), '{}', '{}') ->> 'name' = 'Hospital BMS Upgrade',
  'admin can edit a BMS project');
select public.admin_create_user('bms.lead2@advcontrolsys.com', 'Password1', 'BMS Lead 2', 'lead', 'BMS') as lead2 \gset
select test.ok((select role = 'lead' and department_id = 'BMS' from public.profiles where id = :'lead2'), 'admin can create a department admin');
reset role;

-- ---------- People details (title, org-chart team) ----------
select test.login('admin.test@advcontrolsys.com');
set role authenticated;
update public.profiles set title = 'BMS Engineer', unit = 'B.A Execution Team B' where email = 'laila.test@advcontrolsys.com';
select test.ok((select count(*) from json_array_elements(public.app_bootstrap() -> 'team') t
  where t ->> 'title' = 'BMS Engineer' and t ->> 'unit' = 'B.A Execution Team B') = 1, 'admins set a title and org-chart team; startup data includes them');
reset role;
select test.login('laila.test@advcontrolsys.com');
set role authenticated;
update public.profiles set title = 'CEO' where id = auth.uid();
reset role;
select test.ok((select title from public.profiles where email = 'laila.test@advcontrolsys.com') = 'BMS Engineer', 'members cannot change their own title');

select 'All database checks passed' as result;
