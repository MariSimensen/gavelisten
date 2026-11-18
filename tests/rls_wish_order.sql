-- Checks for supabase/migrations/0004_wish_order.sql. Run after all
-- migrations, the same way as tests/rls.sql. Rolled back at the end.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'alice@example.test'),
  ('00000000-0000-0000-0000-0000000000b2', 'bob@example.test');

create temporary table ids (k text primary key, v text);
grant all on ids to authenticated;

create function pg_temp.check(ok boolean, msg text) returns void language plpgsql as $$
begin
  if ok is not true then raise exception 'FAILED: %', msg; end if;
end $$;
grant execute on function pg_temp.check(boolean, text) to authenticated;

create function pg_temp.expect_error(stmt text, state text, msg text) returns void language plpgsql as $$
begin
  execute stmt;
  raise exception 'FAILED (no error): %', msg;
exception when others then
  if sqlerrm like 'FAILED (no error)%' then raise; end if;
  if sqlstate <> state then raise exception 'FAILED (got % "%" instead of %): %', sqlstate, sqlerrm, state, msg; end if;
end $$;
grant execute on function pg_temp.expect_error(text, text, text) to authenticated;

create function pg_temp.id(key text) returns uuid language sql as $$ select v::uuid from ids where k = key $$;
grant execute on function pg_temp.id(text) to authenticated;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', false);
set role authenticated;
insert into public.profiles (id, display_name) values (auth.uid(), 'Alice');
insert into ids select 'g1', public.create_group('Familien')::text;
insert into public.people (group_id, name) values (pg_temp.id('g1'), 'Mormor');
insert into ids select 'p1', id::text from public.people where name = 'Mormor';
insert into public.wishes (group_id, person_id, title, sort_order) values (pg_temp.id('g1'), pg_temp.id('p1'), 'Sokker', 1), (pg_temp.id('g1'), pg_temp.id('p1'), 'Lue', 2);
update public.wishes set sort_order = 3 where title = 'Sokker';
select pg_temp.check((select sort_order from public.wishes where title = 'Sokker') = 3, 'a member can reorder');
select pg_temp.expect_error($$ update public.wishes set sort_order = 0 where title = 'Lue' $$, '23514', 'sort_order below 1 rejected');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', false);
set role authenticated;
insert into public.profiles (id, display_name) values (auth.uid(), 'Bob');
update public.wishes set sort_order = 9;
reset role;
select pg_temp.check((select count(*) from public.wishes where sort_order = 9) = 0, 'outsiders cannot reorder');

set role anon;
select pg_temp.expect_error($$ update public.wishes set sort_order = 9 $$, '42501', 'anon cannot reorder');
reset role;

select 'ALL WISH ORDER CHECKS PASSED' as result;
rollback;
