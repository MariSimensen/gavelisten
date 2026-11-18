-- Gavelisten: "klar / ikke klar" per list (person card).
--
-- Runs after 0004_wish_order.sql. Safe to run more than once.
--
-- A list that is not ready is still being worked on: the card says so and
-- asks people to wait with buying. It is a warning only; buying is not
-- blocked (the owner's choice), so there is no server-side rule for it.
-- New lists and every list that existed when this ran start as not ready.
-- Anyone in the group can switch it, like every other change in the app.

alter table public.people add column if not exists ready boolean not null default false;

grant update (ready) on public.people to authenticated;
