-- People details from the company org chart: job title and org-chart team (unit), e.g.
-- "BMS Team Leader Engineer" in "B.A Execution Team B". Shown on the Team page, the By person
-- view and name tags, and used to group people in the "assign someone" lists.
-- (profiles.team stays the PLC / Dev meeting column.) Only admins can change them (profiles rules).
alter table public.profiles add column if not exists title text not null default '';
alter table public.profiles add column if not exists unit  text not null default '';

create or replace function public.app_bootstrap(p_since text default null)
returns json language sql stable security invoker set search_path = public as $$
  select json_build_object(
    'me', (select row_to_json(p) from (select id, email, name, role, active, team, department_id, title, unit from profiles where id = (select auth.uid())) p),
    'team', coalesce((select json_agg(t order by t.name) from (select id, email, name, role, active, team, department_id, title, unit from profiles) t), '[]'::json),
    'departments', coalesce((select json_agg(d order by d.sort, d.name) from (select id, name, teams, project_types, sort from departments) d), '[]'::json),
    'projects', coalesce((select json_agg(pr order by pr.id) from projects pr), '[]'::json),
    'assignments', coalesce((select json_agg(json_build_object('project_id', a.project_id, 'user_id', a.user_id)) from assignments a), '[]'::json),
    -- Recent tasks, plus unfinished ones of any age (they keep rolling over until done).
    'tasks', coalesce((select json_agg(k order by k.created_at) from tasks k
        where p_since is null or k.week >= p_since or k.status <> 'Done'), '[]'::json),
    'contacts', coalesce((select json_agg(c order by c.name) from contacts c), '[]'::json)
  );
$$;
revoke all on function public.app_bootstrap(text) from public, anon;
grant execute on function public.app_bootstrap(text) to authenticated;
