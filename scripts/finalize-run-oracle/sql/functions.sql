-- The reference definitions of finalize_run, update_run_progress and the
-- reject_perception_observation trigger. oracle.mjs loads them into PGlite and records what
-- they produce as the fixtures src/server/logic/finalize-run.ts is tested against.

create or replace function public.update_run_progress(p_run uuid)
returns void
language plpgsql
as $function$
begin
  update public.runs r
     set completed_calls = case
           when s.measured = 0 then s.p_done * 2 + s.p_mid
           else s.done * 2 + s.mid end,
         failed_calls = case
           when s.measured = 0 then s.p_failed * 2
           else (s.failed + s.blocked) * 2 end,
         status = case
           when r.status in ('cancelled') then r.status
           when s.pending > 0 then 'running'
           when s.measured = 0 then
             case when s.p_done = 0 then 'failed'
                  when s.p_failed > 0 then 'partial'
                  else 'completed' end
           when s.done = 0 then 'failed'
           when s.failed > 0 or s.blocked > 0 then 'partial'
           else 'completed' end,
         started_at = coalesce(r.started_at, now()),
         finished_at = case when s.pending = 0 then now() else null end
    from (
      select count(*) filter (where status = 'done' and not is_perception) as done,
             count(*) filter (where status in ('answered', 'extracting') and not is_perception) as mid,
             count(*) filter (where status = 'failed' and not is_perception) as failed,
             count(*) filter (where status = 'blocked' and not is_perception) as blocked,
             count(*) filter (where status not in ('done', 'failed', 'blocked')) as pending,
             count(*) filter (where not is_perception) as measured,
             count(*) filter (where is_perception and status = 'done') as p_done,
             count(*) filter (where is_perception and status in ('answered', 'extracting')) as p_mid,
             count(*) filter (where is_perception and status = 'failed') as p_failed
        from public.run_tasks where run_id = p_run
    ) s
   where r.id = p_run;
end $function$;

create or replace function public.finalize_run(p_run uuid)
returns void
language plpgsql
as $function$
declare v_project uuid;
begin
  select project_id into v_project from public.runs where id = p_run;
  perform public.update_run_progress(p_run);
  delete from public.run_metrics where run_id = p_run;

  insert into public.run_metrics (
    run_id, project_id, model_id, prompt_id, brand_id,
    answers, mentions, ranked, citations,
    mention_rate, rank_rate, citation_rate, link_when_mentioned,
    avg_rank, best_rank, worst_rank, rank_stddev, share_of_voice, top_pick_share,
    top3_rate)
  with tasks as (
    select id, model_id, prompt_id from public.run_tasks
     where run_id = p_run and status = 'done' and not is_perception
  ),
  per_task as (
    select t.id as task_id, t.model_id, t.prompt_id, o.brand_id,
           min(o.position) as pos,
           max(case when o.position is not null then 1 else 0 end) as is_ranked,
           max(case when o.is_cited then 1 else 0 end) as is_cited,
           max(case when o.position = 1 then 1 else 0 end) as is_top,
           max(case when o.position <= 3 then 1 else 0 end) as is_top3
      from tasks t
      join public.brand_observations o on o.run_task_id = t.id
     where o.brand_id is not null
     group by t.id, t.model_id, t.prompt_id, o.brand_id
  ),
  scopes as (
    select 0 as lvl, model_id, prompt_id, count(*)::int as answers from tasks group by 2,3
    union all
    select 1, null::uuid, null::uuid, count(*)::int from tasks
  ),
  agg as (
    select 0 as lvl, model_id, prompt_id, brand_id,
           count(*)::int as mentions, sum(is_ranked)::int as ranked,
           sum(is_cited)::int as citations, sum(is_top)::int as tops,
           sum(is_top3)::int as top3,
           avg(pos) as avg_rank, min(pos) as best, max(pos) as worst,
           stddev_pop(pos) as sd
      from per_task group by 2,3,4
    union all
    select 1, null::uuid, null::uuid, brand_id,
           count(*)::int, sum(is_ranked)::int, sum(is_cited)::int, sum(is_top)::int,
           sum(is_top3)::int,
           avg(pos), min(pos), max(pos), stddev_pop(pos)
      from per_task group by 4
  ),
  totals as (
    select lvl, model_id, prompt_id, sum(mentions) as all_mentions
      from agg group by 1,2,3
  )
  select p_run, v_project, a.model_id, a.prompt_id, a.brand_id,
         s.answers, a.mentions, a.ranked, a.citations,
         round(a.mentions::numeric / nullif(s.answers,0), 4),
         round(a.ranked::numeric / nullif(s.answers,0), 4),
         round(a.citations::numeric / nullif(s.answers,0), 4),
         round(a.citations::numeric / nullif(a.mentions,0), 4),
         round(a.avg_rank, 2), a.best, a.worst, round(coalesce(a.sd,0), 2),
         round(a.mentions::numeric / nullif(t.all_mentions,0), 4),
         round(a.tops::numeric / nullif(s.answers,0), 4),
         round(a.top3::numeric / nullif(s.answers,0), 4)
    from agg a
    join scopes s on s.lvl = a.lvl
      and s.model_id is not distinct from a.model_id
      and s.prompt_id is not distinct from a.prompt_id
    join totals t on t.lvl = a.lvl
      and t.model_id is not distinct from a.model_id
      and t.prompt_id is not distinct from a.prompt_id;
end $function$;

create or replace function public.reject_perception_observation()
returns trigger
language plpgsql
as $function$
begin
  if new.run_task_id is not null and exists (
    select 1 from public.run_tasks t
     where t.id = new.run_task_id and t.is_perception
  ) then
    raise exception
      'PERCEPTION_HAS_NO_OBSERVATIONS: a perception answer is read into sections, not mined for brands. Task %', new.run_task_id;
  end if;
  return new;
end $function$;


drop trigger if exists reject_perception_observation on public.brand_observations;
create trigger reject_perception_observation
  before insert on public.brand_observations
  for each row execute function public.reject_perception_observation();
