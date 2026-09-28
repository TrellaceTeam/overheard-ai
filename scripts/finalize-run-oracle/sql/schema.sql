-- The Postgres schema the finalize_run oracle runs against. Column shapes follow
-- src/server/db/migrations/0001_initial.sql, narrowed to the columns finalize_run
-- touches. docs/architecture.md explains what each table is for.
--
-- One CHECK differs from Overheard AI's: run_tasks.status includes 'blocked', which
-- update_run_progress counts. Overheard AI has no blocked status; see
-- docs/architecture.md for the statuses it has.

create table projects (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

create table models (
  id          uuid primary key default gen_random_uuid(),
  provider    text not null,
  model_key   text not null,
  label       text not null,
  tier        text not null check (tier in ('extraction','mid','frontier')),
  is_active   boolean not null default true
);

create table prompts (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  text        text not null,
  category    text,
  iterations  integer not null default 1,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

create table brands (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  name        text not null,
  role        text not null check (role in ('target','competitor','discovered')),
  created_at  timestamptz not null default now()
);

create table runs (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references projects(id) on delete cascade,
  trigger         text not null default 'manual' check (trigger in ('manual','scheduled')),
  status          text not null default 'queued'
                    check (status in ('queued','running','completed','partial','failed','cancelled')),
  planned_calls   integer not null,
  completed_calls integer not null default 0,
  failed_calls    integer not null default 0,
  config_snapshot jsonb not null default '{}'::jsonb,
  error           text,
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz not null default now()
);

create table run_tasks (
  id                uuid primary key default gen_random_uuid(),
  run_id            uuid not null references runs(id) on delete cascade,
  project_id        uuid not null references projects(id) on delete cascade,
  prompt_id         uuid references prompts(id) on delete set null,
  model_id          uuid not null references models(id),
  iteration         integer not null,
  question_text     text,
  is_perception     boolean not null default false,
  status            text not null default 'queued'
                      check (status in ('queued','in_flight','answered','extracting','done','failed','blocked')),
  attempts          integer not null default 0,
  next_attempt_at   timestamptz not null default now(),
  locked_at         timestamptz,
  locked_by         text,
  answer_text       text,
  answer_tokens     integer,
  latency_ms        integer,
  provider_cost_usd numeric(10,6),
  error             text,
  created_at        timestamptz not null default now(),
  unique (run_id, prompt_id, model_id, iteration)
);

-- There is no answers table. The answer is run_tasks.answer_text.

create table extractions (
  id            uuid primary key default gen_random_uuid(),
  run_task_id   uuid not null unique references run_tasks(id) on delete cascade,
  project_id    uuid not null references projects(id) on delete cascade,
  answer_format text not null check (answer_format in ('ranked_list','unranked_list','prose','refusal')),
  total_items   integer,
  raw_json      jsonb not null,
  model_used    text not null,
  created_at    timestamptz not null default now()
);

-- There is no citations table. A citation is is_cited = true with the URL in linked_url.
create table brand_observations (
  id           uuid primary key default gen_random_uuid(),
  run_task_id  uuid not null references run_tasks(id) on delete cascade,
  run_id       uuid not null references runs(id) on delete cascade,
  project_id   uuid not null references projects(id) on delete cascade,
  brand_id     uuid references brands(id) on delete set null,
  raw_name     text not null,
  position     integer,
  total_items  integer,
  mention_type text not null check (mention_type in ('ranked','recommended','mentioned','negative')),
  linked_url   text,
  is_cited     boolean not null default false,
  evidence     text,
  created_at   timestamptz not null default now()
);

create table run_metrics (
  id                 uuid primary key default gen_random_uuid(),
  run_id             uuid not null references runs(id) on delete cascade,
  project_id         uuid not null references projects(id) on delete cascade,
  model_id           uuid references models(id),
  prompt_id          uuid references prompts(id) on delete set null,
  brand_id           uuid references brands(id) on delete cascade,
  answers            integer not null,
  mentions           integer not null,
  ranked             integer not null,
  citations          integer not null,
  mention_rate       numeric(5,4) not null,
  rank_rate          numeric(5,4) not null,
  citation_rate      numeric(5,4) not null,
  link_when_mentioned numeric(5,4),
  avg_rank           numeric(5,2),
  best_rank          integer,
  worst_rank         integer,
  rank_stddev        numeric(5,2),
  share_of_voice     numeric(5,4),
  top_pick_share     numeric(5,4),
  top3_rate          numeric(5,4),
  created_at         timestamptz not null default now()
);
