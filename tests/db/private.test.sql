-- Checks for supabase/private-setup.sql (the private tracker's own project).
\set ON_ERROR_STOP 1
create function pg_temp.ok(c boolean, label text) returns void language plpgsql as $$
begin if c is distinct from true then raise exception 'FAIL: %', label; end if; raise notice 'PASS: %', label; end $$;

insert into auth.users (id, email) values ('11111111-1111-4111-8111-111111111111', 'owner@example.com');
do $$ begin
  insert into auth.users (id, email) values ('22222222-2222-4222-8222-222222222222', 'intruder@example.com');
  raise exception 'FAIL: a second account was created';
exception when others then
  if sqlerrm !~ 'one owner only' then raise; end if;
  raise notice 'PASS: private tracker: a second account is refused (one owner only)';
end $$;

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
set role authenticated;
insert into public.private_tasks (week, project, title) values ('2026-W46', 'Board', 'private plan');
select pg_temp.ok((select count(*) from public.private_tasks) = 1, 'private tracker: the owner adds and reads a private task');
reset role;

-- Someone signed in with a different (forged) id sees and changes nothing
select set_config('request.jwt.claim.sub', '33333333-3333-4333-8333-333333333333', false);
set role authenticated;
select pg_temp.ok((select count(*) from public.private_tasks) = 0, 'private tracker: anyone else sees nothing');
update public.private_tasks set title = 'hacked';
delete from public.private_tasks;
reset role;
select pg_temp.ok((select title from public.private_tasks) = 'private plan', 'private tracker: anyone else cannot change or delete it');
set role anon;
select pg_temp.ok((select public.ping()) = 'ok', 'private tracker: keep-alive ping works signed out');
do $$ begin
  perform * from public.private_tasks;
  raise exception 'FAIL: signed-out read worked';
exception when insufficient_privilege then raise notice 'PASS: private tracker: signed-out visitors cannot read it'; end $$;
reset role;
