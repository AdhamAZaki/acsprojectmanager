-- Tasks without a project, and comments on tasks.
--
-- * A task no longer needs a project (project_id may be empty). Nothing else changes for such a
--   task: who may see or change a task has not depended on its project since "shared projects"
--   (your own tasks; a department admin their own people's; an admin any).
-- * Comments: a thread on a task. Whoever can see the task can read its comments and add one,
--   as themselves. A comment is never edited; its author or an admin can delete it.
--   Comments are deleted with their task.

-- ---------- Tasks: the project is optional ----------
alter table public.tasks alter column project_id drop not null;

-- ---------- Comments ----------
create table if not exists public.task_comments (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid not null references public.tasks (id) on delete cascade,
  author     uuid default auth.uid() references public.profiles (id) on delete set null,
  body       text not null check (length(trim(body)) > 0 and length(body) <= 2000),
  created_at timestamptz not null default now()
);
create index if not exists task_comments_task_idx on public.task_comments (task_id, created_at);
create index if not exists task_comments_author_idx on public.task_comments (author);

alter table public.task_comments enable row level security;
revoke all on public.task_comments from anon;

-- The task is looked up through the rules on tasks, so "can see the comments" is exactly
-- "can see the task" (employees: their own tasks; admins and department admins: every task).
drop policy if exists task_comments_read on public.task_comments;
create policy task_comments_read on public.task_comments for select to authenticated
  using (exists (select 1 from public.tasks t where t.id = task_comments.task_id));

drop policy if exists task_comments_insert on public.task_comments;
create policy task_comments_insert on public.task_comments for insert to authenticated
  with check ((select public.is_active_member()) and author = (select auth.uid())
    and exists (select 1 from public.tasks t where t.id = task_comments.task_id));

drop policy if exists task_comments_delete on public.task_comments;
create policy task_comments_delete on public.task_comments for delete to authenticated
  using ((select public.is_active_member()) and (author = (select auth.uid()) or (select public.is_admin())));
-- No update rule: a comment cannot be changed.

-- Live updates for comments too.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'task_comments') then
    alter publication supabase_realtime add table public.task_comments;
  end if;
end $$;

-- Startup data: also the comments of the tasks being loaded.
create or replace function public.app_bootstrap(p_since text default null)
returns json language sql stable security invoker set search_path = public as $$
  select json_build_object(
    'me', (select row_to_json(p) from (select id, email, name, role, active, team, department_id, title, unit from profiles where id = (select auth.uid())) p),
    'team', coalesce((select json_agg(t order by t.name) from (select id, email, name, role, active, team, department_id, title, unit from profiles) t), '[]'::json),
    'departments', coalesce((select json_agg(d order by d.sort, d.name) from (select id, name, teams, project_types, sort, cross_project from departments) d), '[]'::json),
    'projects', coalesce((select json_agg(pr order by pr.id) from projects pr), '[]'::json),
    'assignments', coalesce((select json_agg(json_build_object('project_id', a.project_id, 'user_id', a.user_id)) from assignments a), '[]'::json),
    'tasks', coalesce((select json_agg(k order by k.created_at) from tasks k
        where p_since is null or k.week >= p_since or k.status <> 'Done'), '[]'::json),
    'comments', coalesce((select json_agg(c order by c.created_at) from task_comments c join tasks k on k.id = c.task_id
        where p_since is null or k.week >= p_since or k.status <> 'Done'), '[]'::json),
    'contacts', coalesce((select json_agg(c order by c.name) from contacts c), '[]'::json)
  );
$$;
revoke all on function public.app_bootstrap(text) from public, anon;
grant execute on function public.app_bootstrap(text) to authenticated;
