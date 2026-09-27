-- Supabase SQL Editor에서 이 파일 전체를 한 번 실행하세요.
create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

create table if not exists public.rooms (
  id uuid primary key default extensions.gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9]{6}$'),
  title text not null check (char_length(title) between 1 and 60),
  pin_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.gift_entries (
  id uuid primary key default extensions.gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  amount bigint not null check (amount between 1 and 1000000000000),
  relation text not null check (relation in ('친구', '직장', '친척', '지인', '기타')),
  gifted_on date not null default current_date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists gift_entries_room_id_idx
  on public.gift_entries(room_id, created_at desc);

create table if not exists public.room_sessions (
  id uuid primary key default extensions.gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists room_sessions_room_id_idx
  on public.room_sessions(room_id, expires_at);

create table if not exists public.room_pin_attempts (
  room_id uuid not null references public.rooms(id) on delete cascade,
  attempt_key text not null,
  failed_count integer not null default 0,
  locked_until timestamptz,
  updated_at timestamptz not null default now(),
  primary key (room_id, attempt_key)
);

create table if not exists private.master_config (
  id boolean primary key default true check (id),
  pin_hash text not null,
  failed_count integer not null default 0,
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists private.master_sessions (
  token_hash text primary key,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.rooms enable row level security;
alter table public.gift_entries enable row level security;
alter table public.room_sessions enable row level security;
alter table public.room_pin_attempts enable row level security;
alter table private.master_config enable row level security;
alter table private.master_sessions enable row level security;

revoke all on public.rooms, public.gift_entries, public.room_sessions, public.room_pin_attempts from anon, authenticated;
revoke all on schema private from public, anon, authenticated;
revoke all on private.master_config, private.master_sessions from public, anon, authenticated;

create or replace function private.master_token_valid(p_master_token text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    exists (
      select 1 from private.master_sessions
      where token_hash = encode(extensions.digest(p_master_token, 'sha256'), 'hex')
        and expires_at > now()
    ), false
  );
$$;

create or replace function private.room_id_for_token(p_access_token text)
returns uuid
language sql
stable
security definer
set search_path = public, extensions, private
as $$
  select room_id
  from public.room_sessions
  where token_hash = encode(extensions.digest(p_access_token, 'sha256'), 'hex')
    and expires_at > now()
  limit 1;
$$;

create or replace function private.room_payload(p_room_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, private
as $$
declare
  v_room jsonb;
  v_entries jsonb;
begin
  select jsonb_build_object('id', id, 'code', code, 'title', title, 'createdAt', created_at)
    into v_room
  from public.rooms
  where id = p_room_id;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', id,
        'name', name,
        'amount', amount,
        'relation', relation,
        'giftedOn', gifted_on,
        'createdAt', created_at,
        'updatedAt', updated_at
      ) order by created_at desc
    ),
    '[]'::jsonb
  ) into v_entries
  from public.gift_entries
  where room_id = p_room_id;

  return jsonb_build_object('room', v_room, 'entries', v_entries);
end;
$$;

create or replace function public.create_room(p_title text, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, private
as $$
declare
  v_room_id uuid;
  v_code text;
  v_token text;
  v_expires_at timestamptz := now() + interval '30 days';
begin
  p_title := btrim(p_title);
  if p_title is null or p_pin is null
    or char_length(p_title) not between 1 and 60 or p_pin !~ '^\d{4}$' then
    return jsonb_build_object('ok', false, 'error', 'INVALID_INPUT');
  end if;

  loop
    v_code := upper(substr(encode(extensions.gen_random_bytes(6), 'hex'), 1, 6));
    exit when not exists (select 1 from public.rooms where code = v_code);
  end loop;

  insert into public.rooms (code, title, pin_hash)
  values (v_code, p_title, extensions.crypt(p_pin, extensions.gen_salt('bf', 10)))
  returning id into v_room_id;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.room_sessions (room_id, token_hash, expires_at)
  values (v_room_id, encode(extensions.digest(v_token, 'sha256'), 'hex'), v_expires_at);

  return jsonb_build_object('ok', true, 'accessToken', v_token, 'expiresAt', v_expires_at)
    || private.room_payload(v_room_id);
end;
$$;

create or replace function public.list_rooms()
returns jsonb
language sql
stable
security definer
set search_path = public, extensions, private
as $$
  select jsonb_build_object(
    'ok', true,
    'rooms', coalesce(
      jsonb_agg(
        jsonb_build_object('code', code, 'title', title, 'createdAt', created_at)
        order by created_at desc
      ),
      '[]'::jsonb
    )
  )
  from public.rooms;
$$;

create or replace function public.master_login(p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_config private.master_config%rowtype;
  v_token text;
  v_expires_at timestamptz := now() + interval '2 hours';
begin
  if p_pin is null or p_pin !~ '^[0-9]{4,12}$' then
    return jsonb_build_object('ok', false, 'error', 'INVALID_INPUT');
  end if;

  select * into v_config from private.master_config where id = true for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'MASTER_NOT_CONFIGURED');
  end if;
  if v_config.locked_until > now() then
    return jsonb_build_object('ok', false, 'error', 'MASTER_RATE_LIMITED');
  end if;
  if v_config.pin_hash <> extensions.crypt(p_pin, v_config.pin_hash) then
    update private.master_config
    set failed_count = case when updated_at < now() - interval '10 minutes' then 1 else failed_count + 1 end,
        locked_until = case
          when (case when updated_at < now() - interval '10 minutes' then 1 else failed_count + 1 end) >= 5
            then now() + interval '10 minutes'
          else null
        end,
        updated_at = now()
    where id = true;
    return jsonb_build_object('ok', false, 'error', 'INVALID_MASTER_PIN');
  end if;

  update private.master_config
  set failed_count = 0, locked_until = null, updated_at = now()
  where id = true;
  delete from private.master_sessions where expires_at <= now();
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into private.master_sessions (token_hash, expires_at)
  values (encode(extensions.digest(v_token, 'sha256'), 'hex'), v_expires_at);
  return jsonb_build_object('ok', true, 'masterToken', v_token, 'expiresAt', v_expires_at);
end;
$$;

create or replace function public.master_rename_room(p_master_token text, p_room_code text, p_title text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room public.rooms%rowtype;
begin
  if not private.master_token_valid(p_master_token) then
    return jsonb_build_object('ok', false, 'error', 'INVALID_MASTER_SESSION');
  end if;
  p_title := btrim(p_title);
  if p_room_code is null or p_title is null
    or p_room_code !~ '^[A-Z0-9]{6}$'
    or char_length(p_title) not between 1 and 60 then
    return jsonb_build_object('ok', false, 'error', 'INVALID_INPUT');
  end if;
  update public.rooms set title = p_title where code = p_room_code returning * into v_room;
  if not found then return jsonb_build_object('ok', false, 'error', 'ROOM_NOT_FOUND'); end if;
  return jsonb_build_object('ok', true, 'room', jsonb_build_object(
    'code', v_room.code, 'title', v_room.title, 'createdAt', v_room.created_at
  ));
end;
$$;

create or replace function public.master_change_room_pin(p_master_token text, p_room_code text, p_new_pin text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room_id uuid;
begin
  if not private.master_token_valid(p_master_token) then
    return jsonb_build_object('ok', false, 'error', 'INVALID_MASTER_SESSION');
  end if;
  if p_room_code is null or p_new_pin is null
    or p_room_code !~ '^[A-Z0-9]{6}$'
    or p_new_pin !~ '^[0-9]{4}$' then
    return jsonb_build_object('ok', false, 'error', 'INVALID_INPUT');
  end if;

  update public.rooms
  set pin_hash = extensions.crypt(p_new_pin, extensions.gen_salt('bf', 12))
  where code = p_room_code
  returning id into v_room_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'ROOM_NOT_FOUND'); end if;

  delete from public.room_sessions where room_id = v_room_id;
  delete from public.room_pin_attempts where room_id = v_room_id;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.master_delete_room(p_master_token text, p_room_code text, p_confirm_title text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.master_token_valid(p_master_token) then
    return jsonb_build_object('ok', false, 'error', 'INVALID_MASTER_SESSION');
  end if;
  if p_room_code is null or p_confirm_title is null or p_room_code !~ '^[A-Z0-9]{6}$' then
    return jsonb_build_object('ok', false, 'error', 'INVALID_INPUT');
  end if;
  if not exists (select 1 from public.rooms where code = p_room_code) then
    return jsonb_build_object('ok', false, 'error', 'ROOM_NOT_FOUND');
  end if;
  delete from public.rooms where code = p_room_code and title = p_confirm_title;
  if not found then return jsonb_build_object('ok', false, 'error', 'CONFIRMATION_MISMATCH'); end if;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.master_logout(p_master_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from private.master_sessions
  where token_hash = encode(extensions.digest(p_master_token, 'sha256'), 'hex');
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.join_room(p_room_code text, p_pin text, p_attempt_key text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, private
as $$
declare
  v_room public.rooms%rowtype;
  v_attempt public.room_pin_attempts%rowtype;
  v_token text;
  v_expires_at timestamptz := now() + interval '30 days';
  v_failed_count integer;
begin
  p_room_code := upper(btrim(p_room_code));
  if p_room_code is null or p_pin is null or p_attempt_key is null
    or p_room_code !~ '^[A-Z0-9]{6}$'
    or p_pin !~ '^\d{4}$'
    or char_length(p_attempt_key) not between 8 and 128 then
    return jsonb_build_object('ok', false, 'error', 'INVALID_INPUT');
  end if;

  select * into v_room from public.rooms where code = p_room_code;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'ROOM_NOT_FOUND');
  end if;

  select * into v_attempt
  from public.room_pin_attempts
  where room_id = v_room.id and attempt_key = p_attempt_key;

  if found and v_attempt.locked_until > now() then
    return jsonb_build_object('ok', false, 'error', 'RATE_LIMITED');
  end if;

  if v_room.pin_hash <> extensions.crypt(p_pin, v_room.pin_hash) then
    insert into public.room_pin_attempts as attempts (room_id, attempt_key, failed_count, locked_until, updated_at)
    values (v_room.id, p_attempt_key, 1, null, now())
    on conflict (room_id, attempt_key) do update set
      failed_count = case
        when attempts.updated_at < now() - interval '10 minutes' then 1
        else attempts.failed_count + 1
      end,
      locked_until = case
        when (case when attempts.updated_at < now() - interval '10 minutes' then 1 else attempts.failed_count + 1 end) >= 5
          then now() + interval '10 minutes'
        else null
      end,
      updated_at = now()
    returning failed_count into v_failed_count;

    if v_failed_count >= 5 then
      return jsonb_build_object('ok', false, 'error', 'RATE_LIMITED');
    end if;
    return jsonb_build_object('ok', false, 'error', 'INVALID_PIN');
  end if;

  delete from public.room_pin_attempts where room_id = v_room.id and attempt_key = p_attempt_key;
  delete from public.room_sessions where expires_at <= now();
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.room_sessions (room_id, token_hash, expires_at)
  values (v_room.id, encode(extensions.digest(v_token, 'sha256'), 'hex'), v_expires_at);

  return jsonb_build_object('ok', true, 'accessToken', v_token, 'expiresAt', v_expires_at)
    || private.room_payload(v_room.id);
end;
$$;

create or replace function public.get_room(p_access_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, private
as $$
declare
  v_room_id uuid := private.room_id_for_token(p_access_token);
begin
  if v_room_id is null then
    return jsonb_build_object('ok', false, 'error', 'INVALID_SESSION');
  end if;
  return jsonb_build_object('ok', true) || private.room_payload(v_room_id);
end;
$$;

create or replace function public.add_entry(p_access_token text, p_name text, p_amount bigint, p_relation text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, private
as $$
declare
  v_room_id uuid := private.room_id_for_token(p_access_token);
  v_entry public.gift_entries%rowtype;
begin
  p_name := btrim(p_name);
  if v_room_id is null then return jsonb_build_object('ok', false, 'error', 'INVALID_SESSION'); end if;
  if p_name is null or p_amount is null or p_relation is null
    or char_length(p_name) not between 1 and 40
    or p_amount not between 1 and 1000000000000
    or p_relation not in ('친구', '직장', '친척', '지인', '기타') then
    return jsonb_build_object('ok', false, 'error', 'INVALID_INPUT');
  end if;

  insert into public.gift_entries (room_id, name, amount, relation)
  values (v_room_id, p_name, p_amount, p_relation)
  returning * into v_entry;

  return jsonb_build_object('ok', true, 'entry', jsonb_build_object(
    'id', v_entry.id, 'name', v_entry.name, 'amount', v_entry.amount,
    'relation', v_entry.relation, 'giftedOn', v_entry.gifted_on,
    'createdAt', v_entry.created_at, 'updatedAt', v_entry.updated_at
  ));
end;
$$;

create or replace function public.update_entry(p_access_token text, p_entry_id uuid, p_name text, p_amount bigint, p_relation text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, private
as $$
declare
  v_room_id uuid := private.room_id_for_token(p_access_token);
  v_entry public.gift_entries%rowtype;
begin
  p_name := btrim(p_name);
  if v_room_id is null then return jsonb_build_object('ok', false, 'error', 'INVALID_SESSION'); end if;
  if p_name is null or p_amount is null or p_relation is null
    or char_length(p_name) not between 1 and 40
    or p_amount not between 1 and 1000000000000
    or p_relation not in ('친구', '직장', '친척', '지인', '기타') then
    return jsonb_build_object('ok', false, 'error', 'INVALID_INPUT');
  end if;

  update public.gift_entries
  set name = p_name, amount = p_amount, relation = p_relation, updated_at = now()
  where id = p_entry_id and room_id = v_room_id
  returning * into v_entry;

  if not found then return jsonb_build_object('ok', false, 'error', 'INVALID_INPUT'); end if;
  return jsonb_build_object('ok', true, 'entry', jsonb_build_object(
    'id', v_entry.id, 'name', v_entry.name, 'amount', v_entry.amount,
    'relation', v_entry.relation, 'giftedOn', v_entry.gifted_on,
    'createdAt', v_entry.created_at, 'updatedAt', v_entry.updated_at
  ));
end;
$$;

create or replace function public.delete_entry(p_access_token text, p_entry_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, private
as $$
declare
  v_room_id uuid := private.room_id_for_token(p_access_token);
begin
  if v_room_id is null then return jsonb_build_object('ok', false, 'error', 'INVALID_SESSION'); end if;
  delete from public.gift_entries where id = p_entry_id and room_id = v_room_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'INVALID_INPUT'); end if;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.leave_room(p_access_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, private
as $$
begin
  delete from public.room_sessions
  where token_hash = encode(extensions.digest(p_access_token, 'sha256'), 'hex');
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.create_room(text, text) from public;
revoke all on function public.list_rooms() from public;
revoke all on function private.master_token_valid(text) from public;
revoke all on function public.master_login(text) from public;
revoke all on function public.master_rename_room(text, text, text) from public;
revoke all on function public.master_change_room_pin(text, text, text) from public;
revoke all on function public.master_delete_room(text, text, text) from public;
revoke all on function public.master_logout(text) from public;
revoke all on function public.join_room(text, text, text) from public;
revoke all on function public.get_room(text) from public;
revoke all on function public.add_entry(text, text, bigint, text) from public;
revoke all on function public.update_entry(text, uuid, text, bigint, text) from public;
revoke all on function public.delete_entry(text, uuid) from public;
revoke all on function public.leave_room(text) from public;

grant execute on function public.create_room(text, text) to anon, authenticated;
grant execute on function public.list_rooms() to anon, authenticated;
grant execute on function public.master_login(text) to anon, authenticated;
grant execute on function public.master_rename_room(text, text, text) to anon, authenticated;
grant execute on function public.master_change_room_pin(text, text, text) to anon, authenticated;
grant execute on function public.master_delete_room(text, text, text) to anon, authenticated;
grant execute on function public.master_logout(text) to anon, authenticated;
grant execute on function public.join_room(text, text, text) to anon, authenticated;
grant execute on function public.get_room(text) to anon, authenticated;
grant execute on function public.add_entry(text, text, bigint, text) to anon, authenticated;
grant execute on function public.update_entry(text, uuid, text, bigint, text) to anon, authenticated;
grant execute on function public.delete_entry(text, uuid) to anon, authenticated;
grant execute on function public.leave_room(text) to anon, authenticated;
