-- Checks for supabase/migrations/0005_ready.sql. Run after all migrations,
-- the same way as tests/rls.sql. Rolled back at the end.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'alice@example.test'),
  ('00000000-0000-0000-0000-0000000000b2', 'bob@example.test');

create function pg_temp.check(ok boolean, msg text) returns void language plpgsql as $$
begin
  if ok is not true then raise exception 'FAILED: %', msg; end if;
end $$;
grant execute on function pg_temp.check(boolean, text) to authenticated;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', false);
set role authenticated;
insert into public.profiles (id, display_name) values (auth.uid(), 'Alice');
select public.create_group('Familien');
insert into public.people (group_id, name) select id, 'Mormor' from public.groups where name = 'Familien';
select pg_temp.check((select ready from public.people where name = 'Mormor') = false, 'new lists start as not ready');
update public.people set ready = true where name = 'Mormor';
select pg_temp.check((select ready from public.people where name = 'Mormor'), 'a member can mark a list ready');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', false);
set role authenticated;
insert into public.profiles (id, display_name) values (auth.uid(), 'Bob');
update public.people set ready = false;
reset role;
select pg_temp.check((select ready from public.people where name = 'Mormor'), 'outsiders cannot change it');

select 'ALL READY CHECKS PASSED' as result;
rollback;
