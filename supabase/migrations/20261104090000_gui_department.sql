-- GUI department. The GUI team (UI/UX and GUI development) makes the screens for the other
-- departments' projects, and has projects of its own (website, asset library, ...).
--
-- * departments.cross_project: the department's board also shows other departments' projects
--   that its people work on (are on the team of, or have tasks in). GUI tasks for a BMS project
--   stay on that BMS project, so the BMS board shows them too; nothing is entered twice.
-- * A department admin can manage their own people's tasks and put their own people on a
--   project's team, also on another department's project (before: only in their department).
-- * Meeting columns for GUI: UI/UX | Dev. Project types GUI and Internal (baseline check widened).

alter table public.departments add column if not exists cross_project boolean not null default false;
insert into public.departments (id, name, teams, project_types, sort, cross_project) values
  ('GUI', 'GUI', array['UI/UX', 'Dev'], array['GUI', 'Internal', 'Other'], 3, true)
on conflict (id) do nothing;

alter table public.tasks drop constraint if exists tasks_team_check;
alter table public.tasks add constraint tasks_team_check check (team is null or team in ('PLC', 'Dev', 'UI/UX'));

-- True when the signed-in user is an admin, or the department admin of this person's department.
create or replace function public.leads_person(p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin() or exists (select 1 from profiles p where p.id = p_user and public.is_dept_admin(p.department_id));
$$;
revoke all on function public.leads_person(uuid) from public, anon;
grant execute on function public.leads_person(uuid) to authenticated;

-- True when the signed-in user leads someone the task belongs to (its creator or an assignee).
create or replace function public.leads_task_owner(p_created_by uuid, p_assignees uuid[]) returns boolean
language sql stable security definer set search_path = public as $$
  select public.leads_person(p_created_by) or exists (select 1 from unnest(coalesce(p_assignees, '{}')) a where public.leads_person(a));
$$;
revoke all on function public.leads_task_owner(uuid, uuid[]) from public, anon;
grant execute on function public.leads_task_owner(uuid, uuid[]) to authenticated;

-- Tasks: as before (own tasks; admins of the project's department any), plus a department admin
-- for their own people's tasks on any project.
drop policy if exists tasks_insert on public.tasks;
create policy tasks_insert on public.tasks for insert to authenticated
  with check ((select public.is_active_member()) and (
    public.is_dept_admin(public.project_department(project_id))
    or (created_by = (select auth.uid()) and assignee_ids <@ array[(select auth.uid())])
    or (created_by <> (select auth.uid()) and public.leads_person(created_by)
        and not exists (select 1 from unnest(assignee_ids) a where not public.leads_person(a)))));

drop policy if exists tasks_update on public.tasks;
create policy tasks_update on public.tasks for update to authenticated
  using (public.is_dept_admin(public.project_department(project_id))
    or ((select public.is_active_member()) and (created_by = (select auth.uid()) or (select auth.uid()) = any (assignee_ids)))
    or public.leads_task_owner(created_by, assignee_ids))
  with check ((select public.is_active_member()));

drop policy if exists tasks_delete on public.tasks;
create policy tasks_delete on public.tasks for delete to authenticated
  using (public.is_dept_admin(public.project_department(project_id))
    or (created_by = (select auth.uid()) and (select public.is_active_member()))
    or public.leads_task_owner(created_by, assignee_ids));

create or replace function public.guard_task_update() returns trigger
language plpgsql set search_path = public as $$
declare v_me uuid := auth.uid();
begin
  if v_me is null or public.is_dept_admin(public.project_department(old.project_id)) then return new; end if;
  if public.leads_task_owner(old.created_by, old.assignee_ids) then
    -- A department admin on another department's project: only their own people can be added or removed.
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

-- Project teams: you join or leave yourself; the project's department admins manage everyone;
-- a department admin can also put their own people on (or take them off) any project.
drop policy if exists assignments_insert on public.assignments;
create policy assignments_insert on public.assignments for insert to authenticated
  with check (public.is_dept_admin(public.project_department(project_id)) or public.leads_person(user_id)
    or (user_id = (select auth.uid()) and (select public.is_active_member())));
drop policy if exists assignments_delete on public.assignments;
create policy assignments_delete on public.assignments for delete to authenticated
  using (public.is_dept_admin(public.project_department(project_id)) or public.leads_person(user_id) or user_id = (select auth.uid()));

-- Startup data: the department list now says which departments work across projects.
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
    'contacts', coalesce((select json_agg(c order by c.name) from contacts c), '[]'::json)
  );
$$;
revoke all on function public.app_bootstrap(text) from public, anon;
grant execute on function public.app_bootstrap(text) to authenticated;
