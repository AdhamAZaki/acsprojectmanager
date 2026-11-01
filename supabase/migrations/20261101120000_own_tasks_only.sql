-- Own tasks only. Everyone still sees every task (the meeting board), but a member can only
-- add, change or delete their own tasks: ones they created or are assigned to. Admins, and
-- the department admins of the task's project, can change anyone's.
--
-- A member cannot add a task for someone else, put a colleague on a task, or take a colleague
-- off one: they can only add or remove themselves. 3rd parties (no account) can be added freely.

-- Add: your own task (only you on it), or anything as an admin of the project's department.
drop policy if exists tasks_insert on public.tasks;
create policy tasks_insert on public.tasks for insert to authenticated
  with check ((select public.is_active_member()) and (
    public.is_dept_admin(public.project_department(project_id))
    or (created_by = (select auth.uid()) and assignee_ids <@ array[(select auth.uid())])));

-- Change: your own tasks (created by you or assigned to you); admins of the department any task.
drop policy if exists tasks_update on public.tasks;
create policy tasks_update on public.tasks for update to authenticated
  using (public.is_dept_admin(public.project_department(project_id))
    or ((select public.is_active_member()) and (created_by = (select auth.uid()) or (select auth.uid()) = any (assignee_ids))))
  with check ((select public.is_active_member()));

-- Delete: tasks you created; admins of the department any task (unchanged).
drop policy if exists tasks_delete on public.tasks;
create policy tasks_delete on public.tasks for delete to authenticated
  using (public.is_dept_admin(public.project_department(project_id))
    or (created_by = (select auth.uid()) and (select public.is_active_member())));

-- What a member may change on their own task: not who created it, and on the assignees
-- only themselves (join or leave the task). Admins of the task's department are not limited.
create or replace function public.guard_task_update() returns trigger
language plpgsql set search_path = public as $$
declare v_me uuid := auth.uid();
begin
  if v_me is null or public.is_dept_admin(public.project_department(old.project_id)) then return new; end if;
  if new.created_by is distinct from old.created_by then
    raise exception 'The creator of a task cannot be changed' using errcode = '42501';
  end if;
  if exists (select 1 from unnest(new.assignee_ids) a where a <> v_me and not a = any (old.assignee_ids))
     or exists (select 1 from unnest(old.assignee_ids) a where a <> v_me and not a = any (new.assignee_ids)) then
    raise exception 'Only an admin can add or remove other people on a task' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public.guard_task_update() from public, anon, authenticated;
