-- Admins and team leaders (department admins) put anyone in the company on a project, or take
-- them off (before: a department admin only their own department's people). Employees still
-- only join or leave themselves.

drop policy if exists assignments_insert on public.assignments;
create policy assignments_insert on public.assignments for insert to authenticated
  with check ((select public.is_manager()) or (user_id = (select auth.uid()) and (select public.is_active_member())));
drop policy if exists assignments_delete on public.assignments;
create policy assignments_delete on public.assignments for delete to authenticated
  using ((select public.is_manager()) or user_id = (select auth.uid()));

-- Saves a project and changes its team in one transaction (admins and department admins).
create or replace function public.admin_save_project(p jsonb, p_add_ids uuid[], p_remove_ids uuid[])
returns json language plpgsql security invoker set search_path = public as $$
declare
  v_id   text := nullif(trim(p ->> 'id'), '');
  v_dept text := coalesce(nullif(p ->> 'department_id', ''), public.project_department(v_id), public.my_department());
  v_row  projects;
begin
  if not public.is_manager() then raise exception 'Admin access required'; end if;
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
