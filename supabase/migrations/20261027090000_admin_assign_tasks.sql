-- Admins can add a task for someone else (any week); everyone else only for themselves.
drop policy if exists tasks_insert on public.tasks;
create policy tasks_insert on public.tasks for insert to authenticated
  with check ((created_by = (select auth.uid()) or (select public.is_admin())) and public.on_project(project_id));
