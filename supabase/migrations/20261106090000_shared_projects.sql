-- Shared projects and private tasks.
--
-- * A project is shared by every team (PLC, AVEVA, BMS, GUI, ...). projects.department_id stays
--   (where the project was first entered) but no longer limits who works on it or manages it.
--   Admins and department admins add and edit projects; only admins delete them.
-- * Employees see only their own tasks (created by them or assigned to them). Admins and
--   department admins see every task, so the weekly meeting can show the whole project.
--   Saved minutes hold everyone's tasks, so only admins and department admins can read them.
-- * Who may change a task no longer depends on the project's department: your own tasks; a
--   department admin their own people's tasks; an admin any task.
-- * Project teams: you join or leave yourself; a department admin adds or removes their own
--   people; an admin anyone.

-- ---------- Tasks: read ----------
drop policy if exists tasks_read on public.tasks;
create policy tasks_read on public.tasks for select to authenticated
  using ((select public.is_manager())
    or ((select public.is_active_member()) and (created_by = (select auth.uid()) or (select auth.uid()) = any (assignee_ids))));

-- ---------- Tasks: add / change / delete ----------
drop policy if exists tasks_insert on public.tasks;
create policy tasks_insert on public.tasks for insert to authenticated
  with check ((select public.is_active_member()) and (
    (select public.is_admin())
    or (created_by = (select auth.uid()) and assignee_ids <@ array[(select auth.uid())])
    or (public.leads_person(created_by)
        and not exists (select 1 from unnest(assignee_ids) a where not public.leads_person(a)))));

drop policy if exists tasks_update on public.tasks;
create policy tasks_update on public.tasks for update to authenticated
  using ((select public.is_admin())
    or ((select public.is_active_member()) and (created_by = (select auth.uid()) or (select auth.uid()) = any (assignee_ids)))
    or public.leads_task_owner(created_by, assignee_ids))
  with check ((select public.is_active_member()));

drop policy if exists tasks_delete on public.tasks;
create policy tasks_delete on public.tasks for delete to authenticated
  using ((select public.is_admin())
    or (created_by = (select auth.uid()) and (select public.is_active_member()))
    or public.leads_task_owner(created_by, assignee_ids));

create or replace function public.guard_task_update() returns trigger
language plpgsql set search_path = public as $$
declare v_me uuid := auth.uid();
begin
  if v_me is null or public.is_admin() then return new; end if;
  if public.leads_task_owner(old.created_by, old.assignee_ids) then
    -- A department admin: only their own people can be put on or taken off the task.
    if exists (select 1 from unnest(new.assignee_ids) a where not a = any (old.assignee_ids) and not public.leads_person(a))
       or exists (select 1 from unnest(old.assignee_ids) a where not a = any (new.assignee_ids) and not public.leads_person(a)) then
      raise exception 'You can only add or remove your own team on this task' using errcode = '42501';
    end if;
    return new;
  end if;
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

-- ---------- Projects: shared ----------
drop policy if exists projects_admin_insert on public.projects;
create policy projects_admin_insert on public.projects for insert to authenticated
  with check ((select public.is_manager()));
drop policy if exists projects_admin_update on public.projects;
create policy projects_admin_update on public.projects for update to authenticated
  using ((select public.is_manager())) with check ((select public.is_manager()));
drop policy if exists projects_admin_delete on public.projects;
create policy projects_admin_delete on public.projects for delete to authenticated
  using ((select public.is_admin()));

-- Saves a project and changes its team in one transaction. Any admin or department admin may
-- save a project; a department admin adds or removes only their own people on its team.
create or replace function public.admin_save_project(p jsonb, p_add_ids uuid[], p_remove_ids uuid[])
returns json language plpgsql security invoker set search_path = public as $$
declare
  v_id   text := nullif(trim(p ->> 'id'), '');
  v_dept text := coalesce(nullif(p ->> 'department_id', ''), public.project_department(v_id), public.my_department());
  v_row  projects;
begin
  if not public.is_manager() then raise exception 'Admin access required'; end if;
  if exists (select 1 from unnest(coalesce(p_add_ids, '{}') || coalesce(p_remove_ids, '{}')) u where not public.leads_person(u)) then
    raise exception 'You can only add or remove your own team on a project' using errcode = '42501';
  end if;
  if v_id is null then
    select 'PRJ-' || lpad((coalesce(max((substring(id from '^PRJ-(\d+)$'))::int), 0) + 1)::text, 4, '0')
      into v_id from projects;
  end if;
  insert into projects (id, name, type, status, priority, client, manager, notes, start_date, end_date, department_id)
  values (v_id, trim(p ->> 'name'), coalesce(nullif(p ->> 'type', ''), 'Other'), coalesce(p ->> 'status', 'In Progress'),
          coalesce(p ->> 'priority', 'Medium'), coalesce(p ->> 'client', ''), coalesce(p ->> 'manager', ''),
          coalesce(p ->> 'notes', ''), nullif(p ->> 'start_date', '')::date, nullif(p ->> 'end_date', '')::date, v_dept)
  on conflict (id) do update set name = excluded.name, type = excluded.type, status = excluded.status,
    priority = excluded.priority, client = excluded.client, manager = excluded.manager, notes = excluded.notes,
    start_date = excluded.start_date, end_date = excluded.end_date
  returning * into v_row;
  delete from assignments where project_id = v_id and user_id = any (coalesce(p_remove_ids, '{}'));
  insert into assignments (project_id, user_id) select v_id, unnest(coalesce(p_add_ids, '{}')) on conflict do nothing;
  return row_to_json(v_row);
end $$;
revoke all on function public.admin_save_project(jsonb, uuid[], uuid[]) from public, anon;
grant execute on function public.admin_save_project(jsonb, uuid[], uuid[]) to authenticated;

-- ---------- Project teams ----------
drop policy if exists assignments_insert on public.assignments;
create policy assignments_insert on public.assignments for insert to authenticated
  with check (public.leads_person(user_id) or (user_id = (select auth.uid()) and (select public.is_active_member())));
drop policy if exists assignments_delete on public.assignments;
create policy assignments_delete on public.assignments for delete to authenticated
  using (public.leads_person(user_id) or user_id = (select auth.uid()));

-- ---------- Minutes: managers only ----------
drop policy if exists meetings_read on public.meetings;
create policy meetings_read on public.meetings for select to authenticated
  using ((select public.is_manager()));
