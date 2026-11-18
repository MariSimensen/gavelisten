# Gavelisten

A shared wish list for families and groups of friends. Each group has cards
per person with wishes (title, optional link, price, quantity and photo).
Anyone in the group can tick a wish as bought ("Kjøpt av X, i dag 14:05"),
or for a wish with a quantity (8 glasses) register how many they bought
themselves. Each viewer can hide what has been bought, so the person the
gifts are for can use the list too. Only one person can edit a wish at a
time. The interface is in Norwegian.

It is a static site (plain HTML, CSS and JavaScript, no build step) meant for
GitHub Pages, with [Supabase](https://supabase.com) for the database, sign-in
(e-mail magic link) and live updates.

## Files

| File | What it is |
|------|------------|
| `index.html` | Page markup and styles |
| `app.js` | All app logic |
| `theme.js` | Applies the saved light or dark theme before the page paints |
| `config.js` | Supabase project URL and publishable (anon) key |
| `supabase/migrations/0001_init.sql` | Database schema, row level security, RPCs, realtime |
| `supabase/migrations/0002_v3.sql` | Quantities, purchases per person, images (Storage bucket), edit locks |
| `tests/rls.sql` | Checks for the 0001 security rules, run against a local Supabase |
| `tests/rls_v3.sql` | Checks for the 0002 rules (purchases, locks, images, moving wishes) |

## Setup

### 1. Create the database

1. Create a Supabase project.
2. Run the migrations in order, `supabase/migrations/0001_init.sql` and then
   `supabase/migrations/0002_v3.sql`, either in the dashboard (SQL Editor,
   paste and run) or with the CLI: `supabase init` (once, it adds
   `supabase/config.toml`), `supabase link --project-ref <ref>` and then
   `supabase db push`. Never edit a migration that has already been
   applied; add a new numbered file instead.

   `0002_v3.sql` also creates the private Storage bucket `wish-images`
   (5 MB per file, JPEG, PNG or WebP) and its access policies, so there is
   nothing to set up by hand under Storage. It is safe to run twice.

### 2. Configure sign-in

In the Supabase dashboard, under Authentication:

1. **Sign In / Providers**: keep Email enabled. Magic links need no password.
2. **URL Configuration**:
   - **Site URL**: the GitHub Pages address, for example
     `https://<user>.github.io/gavelisten/`.
   - **Redirect URLs**: add the same address. The app asks Supabase to send
     people back to the page they signed in from (without query or hash), so
     that exact URL must be allowed. Add `http://localhost:8000/` too if you
     want to test locally.
3. Optional: the built-in e-mail sender is heavily rate limited. For real use,
   set up your own SMTP server under Authentication > Emails, and consider
   translating the magic link e-mail template to Norwegian.

### 3. Fill in `config.js`

Copy the values from Project Settings > API:

```js
window.GAVELISTEN_CONFIG = {
  supabaseUrl: "https://<ref>.supabase.co",
  supabaseAnonKey: "<anon public key>",
};
```

The anon key is meant to be public. Everything it can do is limited by the
row level security policies in the migration. Never put the `service_role`
key in this repository.

### 4. Publish on GitHub Pages

Push the repository and enable Pages (Settings > Pages, deploy from the
`main` branch, root folder). There is nothing to build.

To try it locally, serve the folder with any static server, for example
`python3 -m http.server 8000`, and open `http://localhost:8000/`.

## Layout

Once signed in, the page shows only the list: the name pills and the cards.
A button-styled "+ Legg til person" chip sits first in the pill row (first, so it
stays visible when the row scrolls sideways on phones).
Everything else (theme, group name and switching, starting a new group,
adding a person, hiding what is
bought, inviting, members, sharing the app, theme, signing out) sits in the
☰ menu at the top right, so the list stays the focus. When "Skjul hva som er
kjøpt" is on, a small "Kjøpt er skjult · Vis" label stays above the list so
nobody forgets it is on. On narrow screens the name pills are one row that
scrolls sideways (the next pill peeks past the edge) instead of wrapping into
several rows; this keeps the counts visible and dragging to reorder working,
which a dropdown would lose.

## How groups work

- The first time someone signs in they choose a display name, which the
  other members see.
- Someone who is in no group can create one. The creator becomes its owner.
- Every group has a secret invite link (`<page>?bli-med=<group-name>-<token>`)
  shown under "Inviter og medlemmer" in the menu. Opening it, before or after signing in,
  adds you to the group. The group name is only there so people can see which
  group a link is for; the random token is what grants access, so a link with
  just the name would let anyone join. Older links without the name still work.
- "Del Gavelisten-appen" in the menu opens a box with the plain page address and a copy button. Someone who signs in from it is in no group and makes their own.
- People can be in several groups and switch between them in the menu. The last chosen group is remembered on that device.
- All members can add, change and delete people and wishes in the group.
- The owner can rename the group, make a new invite link (the old one stops
  working) and remove members. Removing someone does not change the link, so
  make a new link as well if they should not be able to come back.
- Anyone can leave. If the owner leaves, the member who has been in the group
  longest becomes owner. When the last member leaves, the group and all its
  lists are deleted.

## Security model

- Row level security is enabled on every table. Members can only see and
  change the groups they belong to; profiles are visible to yourself and to
  people you share a group with.
- Groups and memberships are only created through the `create_group` and
  `join_group` functions. Invite tokens are 144 random bits and only readable
  by members.
- Who bought a wish and when is set by a database trigger from the signed-in
  user, not by the browser, so it cannot be faked.
- A wish's person must belong to the same group (composite foreign key).
- Table privileges are per column, so clients cannot change ids, group
  membership of rows, owners or buyers directly.
- Who bought how many of a wish with a quantity is stored per person in
  `wish_purchases`. Everyone in the group can read it, but you can only add,
  change or remove your own row, and the time is set by the server. A
  trigger refuses buying more than the wish's quantity (a wish ticked with
  the single "Kjøpt" checkbox counts as one). Lowering the quantity keeps
  what was already bought; the wish then just shows as all bought.
- Images live in the private Storage bucket `wish-images` as
  `<group id>/<random id>.jpg`. Storage policies only let members of that
  group read, upload or delete them, and the page shows them through signed
  URLs that expire after an hour. The browser scales photos to at most
  1600 px and uploads them as JPEG. Old images are deleted by the page when
  they are replaced or removed, or when the wish or person card is deleted.
  When a whole group is deleted (the last member leaves), its images are
  not deleted automatically; remove the group's folder in the dashboard if
  that matters.
- Edit locks (`wish_locks`) can only be taken through the
  `acquire_wish_lock` function, which takes a lock only when it is free,
  expired or already yours. Locks are a courtesy to avoid two people
  editing the same wish; the database does not refuse a change from
  someone without the lock.
- Members only ever see each other's display names, never e-mail
  addresses. Avatars show initials from the display name.
- The page has a Content Security Policy that only allows scripts from the
  site itself and the pinned supabase-js build on jsDelivr (with a
  Subresource Integrity hash), network calls only to `*.supabase.co`, and
  images only from the site, `blob:` (previews) and `*.supabase.co` (signed
  URLs). If you use a custom Supabase domain, update `connect-src` and
  `img-src` in `index.html`.
- User text is always inserted with `textContent`, never as HTML, and links
  are limited to `http://` and `https://`.

Sign-in uses the implicit magic link flow, so the link works even when it is
opened in a different browser than the one it was requested from (common
when the e-mail is read on a phone).

## Editing and locks

Clicking a wish (or ✏️) opens it for editing and takes a lock, so the others
see "Bjørn Hansen redigerer" with an avatar and cannot open or delete it until
it is free. Ticking it as bought still works. The lock is renewed while you
type (at most every 20 seconds) and lasts 8 minutes from the last renewal.
After 7 minutes without activity the page saves and closes the editor itself,
with a red countdown in the last minute. The lock is released on Lagre,
Avbryt, Esc, a click outside, and when the tab is closed (a `keepalive`
request to the `release_wish_lock` endpoint). If a tab dies without
releasing, the lock simply expires.

## Live updates

The page subscribes to Supabase Realtime changes on `people`, `wishes`,
`group_members`, `wish_purchases` and `wish_locks` filtered on the current
group, and refetches the group's data when anything changes. Forms that are
open keep what has been typed. Postgres cannot filter delete events by column, so
every open page gets notified of every delete (only the row id, no content)
and refetches. That is fine at family scale.

## Testing the database rules

`tests/rls.sql` and `tests/rls_v3.sql` check the policies, RPCs, triggers and
Storage policies as different users, each inside a transaction that is rolled
back. With the Supabase CLI and Docker:

```sh
supabase init             # once, if supabase/config.toml does not exist yet
supabase start
supabase db reset          # applies both migrations
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f tests/rls.sql
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f tests/rls_v3.sql
```

They end with `ALL RLS CHECKS PASSED` and `ALL V3 RLS CHECKS PASSED`, or stop
at the first failed check.
