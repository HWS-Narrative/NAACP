-- NAACP Volunteer Committees (LOCKED DESIGN)
-- Build order: Migration → RPC → Frontend → Edge Function → QA

-- 0) Extensions (for gen_random_uuid)
create extension if not exists pgcrypto;

-- 1) Committees source-of-truth table
create table if not exists public.committees (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  is_active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

-- 2) Join table: one row per selection (no denormalized fields)
create table if not exists public.volunteer_submission_committees (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null,
  committee_id uuid not null,
  created_at timestamptz not null default now(),
  constraint vsc_submission_fk foreign key (submission_id)
    references public.volunteer_interest_submissions(id) on delete cascade,
  constraint vsc_committee_fk foreign key (committee_id)
    references public.committees(id) on delete restrict,
  constraint vsc_unique unique (submission_id, committee_id)
);

create index if not exists vsc_submission_id_idx on public.volunteer_submission_committees(submission_id);
create index if not exists vsc_committee_id_created_at_idx on public.volunteer_submission_committees(committee_id, created_at);

-- 3) RLS
alter table public.committees enable row level security;
alter table public.volunteer_submission_committees enable row level security;

-- Public: SELECT active committees only (LOCKED)
-- NOTE: If you already have policies, review for duplicates before running.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'committees'
      and policyname = 'Public read active committees'
  ) then
    create policy "Public read active committees"
      on public.committees
      for select
      to anon
      using (is_active = true);
  end if;
end$$;

-- No public INSERT/UPDATE/DELETE policies are created for volunteer_submission_committees.
-- RPC will write with definer privileges (LOCKED).

-- 4) RPC (Option 3 transaction) — single write entry point
-- IMPORTANT: This assumes volunteer_interest_submissions has columns matching these names:
-- full_name, email, phone, city_county, interests, interest_other_text, experience, time_available,
-- volunteer_format, motivation.
-- If any column names differ, adjust the INSERT column list accordingly.

create or replace function public.submit_volunteer_with_committees(
  full_name text,
  email text,
  phone text,
  city_county text,
  interests text[],
  interest_other_text text,
  experience text,
  time_available text,
  volunteer_format text,
  motivation text,
  committee_ids uuid[]
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_submission_id uuid;
  cid uuid;
begin
  -- Insert parent record (webhook fires here)
  insert into public.volunteer_interest_submissions (
    full_name,
    email,
    phone,
    city_county,
    interests,
    interest_other_text,
    experience,
    time_available,
    volunteer_format,
    motivation
  ) values (
    submit_volunteer_with_committees.full_name,
    lower(trim(submit_volunteer_with_committees.email)),
    nullif(trim(submit_volunteer_with_committees.phone), ''),
    nullif(trim(submit_volunteer_with_committees.city_county), ''),
    coalesce(submit_volunteer_with_committees.interests, '{}'::text[]),
    nullif(trim(submit_volunteer_with_committees.interest_other_text), ''),
    nullif(trim(submit_volunteer_with_committees.experience), ''),
    nullif(trim(submit_volunteer_with_committees.time_available), ''),
    nullif(trim(submit_volunteer_with_committees.volunteer_format), ''),
    nullif(trim(submit_volunteer_with_committees.motivation), '')
  )
  returning id into new_submission_id;

  -- Insert committee selections (if any) — validate active committees
  if submit_volunteer_with_committees.committee_ids is not null then
    foreach cid in array submit_volunteer_with_committees.committee_ids
    loop
      -- Only insert if the committee exists and is active (prevents spoofed ids)
      insert into public.volunteer_submission_committees (submission_id, committee_id)
      select new_submission_id, c.id
      from public.committees c
      where c.id = cid and c.is_active = true
      on conflict (submission_id, committee_id) do nothing;
    end loop;
  end if;

  return new_submission_id;
end;
$$;

-- Allow public to EXECUTE the RPC
grant execute on function public.submit_volunteer_with_committees(
  text, text, text, text, text[], text, text, text, text, text, uuid[]
) to anon;

-- Recommended: explicitly revoke table write privileges from anon/authenticated
-- (RLS should already block, but this removes accidental privilege leakage.)
revoke insert, update, delete on public.volunteer_submission_committees from anon, authenticated;
revoke insert, update, delete on public.committees from anon, authenticated;

