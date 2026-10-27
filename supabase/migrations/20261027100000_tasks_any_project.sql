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
