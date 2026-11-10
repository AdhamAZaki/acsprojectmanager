-- Private tracker: setup for its OWN Supabase project (not the shared ACS one).
-- Paste into that project's SQL Editor once (safe to run again).
--
-- * One table of private tasks. Every row belongs to its owner; nobody else can read or change it.
-- * One owner only: the first account created in this project. Any other account is refused,
--   even if sign-ups are left switched on by mistake.
-- * Nothing here knows about the ACS tracker. Done tasks are copied in from ACS by the private
--   page (signed in as you), and a private task goes to ACS only when you press "Send to ACS".

create table if not exists public.private_tasks (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  week        text not null check (week ~ '^\d{4}-W\d{2}$'),
  project     text not null default '',
  title       text not null check (length(trim(title)) > 0),
  notes       text not null default '',
  status      text not null default 'To Do' check (status in ('To Do', 'In Progress', 'Blocked', 'Done')),
  source      text not null default 'private' check (source in ('private', 'acs')),   -- acs = copied from ACS
  acs_task_id uuid unique,                                                             -- the ACS task it came from / was sent as
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
-- Details (added later; safe to run again): what blocks a task, and its sub-steps.
alter table public.private_tasks add column if not exists block_note text not null default '';
alter table public.private_tasks add column if not exists subtasks jsonb not null default '[]'::jsonb;   -- [{ "t": "text", "done": false }]
create index if not exists private_tasks_week_idx on public.private_tasks (owner, week);

create or replace function public.private_touch() returns trigger language plpgsql set search_path = public as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists private_tasks_touch on public.private_tasks;
create trigger private_tasks_touch before update on public.private_tasks for each row execute function public.private_touch();

alter table public.private_tasks enable row level security;
revoke all on public.private_tasks from anon;
drop policy if exists private_read on public.private_tasks;
create policy private_read on public.private_tasks for select to authenticated using (owner = (select auth.uid()));
drop policy if exists private_insert on public.private_tasks;
create policy private_insert on public.private_tasks for insert to authenticated with check (owner = (select auth.uid()));
drop policy if exists private_update on public.private_tasks;
create policy private_update on public.private_tasks for update to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));
drop policy if exists private_delete on public.private_tasks;
create policy private_delete on public.private_tasks for delete to authenticated using (owner = (select auth.uid()));

-- One owner only: once an account exists, no other account can be created.
create or replace function public.private_one_owner() returns trigger
language plpgsql security definer set search_path = public, auth as $$
begin
  if exists (select 1 from auth.users where id <> new.id) then
    raise exception 'This private tracker has one owner only';
  end if;
  return new;
end $$;
revoke all on function public.private_one_owner() from public, anon, authenticated;
drop trigger if exists private_one_owner on auth.users;
create trigger private_one_owner before insert on auth.users for each row execute function public.private_one_owner();

-- Keep-alive: the daily GitHub job calls this so the free project is not paused.
create or replace function public.ping() returns text language sql stable as $$ select 'ok'::text $$;
revoke all on function public.ping() from public;
grant execute on function public.ping() to anon, authenticated;
