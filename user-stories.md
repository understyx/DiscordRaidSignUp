# User Stories

This document describes all the ways users can interact with the Discord Raid Sign-Up application.  
The application has four types of users:

- **Player** – any Discord server member
- **Officer** – holds the configured Officer role or has the `Manage Server` Discord permission
- **Server Manager** – guild owner or has the `Manage Server` Discord permission (superset of Officer)
- **Developer** – the account whose Discord user ID matches `DEV_USER_ID`

---

## Table of Contents

1. [Authentication (Web)](#1-authentication-web)
2. [Character Management (Discord Bot)](#2-character-management-discord-bot)
3. [Character Management (Web App)](#3-character-management-web-app)
4. [Raid Save / Lockout Tracking (Discord Bot)](#4-raid-save--lockout-tracking-discord-bot)
5. [Raid Save / Lockout Tracking (Web App)](#5-raid-save--lockout-tracking-web-app)
6. [Signing Up for Raids (Discord Bot)](#6-signing-up-for-raids-discord-bot)
7. [Signing Up for Raids (Web App)](#7-signing-up-for-raids-web-app)
8. [Raid Management (Discord Bot – Officer)](#8-raid-management-discord-bot--officer)
9. [Raid Management (Web App – Officer/Admin)](#9-raid-management-web-app--officeradmin)
10. [Guild Settings (Web App – Server Manager)](#10-guild-settings-web-app--server-manager)
11. [Admin Role Management (Discord Bot – Server Manager)](#11-admin-role-management-discord-bot--server-manager)
12. [Recruitment System (Web App)](#12-recruitment-system-web-app)
13. [Developer Tools](#13-developer-tools)

---

## 1. Authentication (Web)

### US-1.1 Login with Discord
**As a** player,  
**I want to** log in to the web app using my Discord account,  
**so that** my characters and raid sign-ups are linked to my Discord identity.

**Flow:** Click "Login with Discord" → authorize on discord.com → redirected back to the web app.  
After login the app automatically detects which bot-enabled guilds the user belongs to.

---

### US-1.2 Select Active Guild
**As a** player who belongs to more than one Discord server that has the bot installed,  
**I want to** choose which guild's raids to view,  
**so that** I see only the relevant raids and my admin status is evaluated correctly.

**Flow:** After login, if multiple matching guilds exist, the app shows a guild picker page.  
The chosen guild is stored in the session for the rest of the visit.

---

### US-1.3 Log Out
**As a** player,  
**I want to** log out of the web app,  
**so that** my session is cleared and the next person at this browser cannot access my account.

**Flow:** Click "Logout" → session is destroyed → redirected to the login page.

---

## 2. Character Management (Discord Bot)

### US-2.1 Register a Character
**As a** player,  
**I want to** register my WoW character with its class, spec(s), and gearscore(s),  
**so that** I can sign up for raids using that character.

**Command:** `/addcharacter name:<name> char_class:<class> spec1:<spec> gs1:<gearscore>`

- Up to 6 spec/gearscore pairs can be provided in a single command.
- Gearscore accepts a plain number (`6200`), a shorthand (`6.2k`), or `BiS` for Best-in-Slot.
- If the character+realm+spec already exists the gearscore is updated (upsert behaviour).
- After registering, a dropdown appears to set the character's primary role (Tank / Healer / DPS).

---

### US-2.2 Remove a Character
**As a** player,  
**I want to** remove one of my registered characters,  
**so that** it no longer appears in my sign-up options.

**Command:** `/remove_character name:<name>` (removes all specs) or `/remove_character name:<name> spec:<spec>` (removes a single spec entry).

---

### US-2.3 List My Characters
**As a** player,  
**I want to** see all my registered characters with their class, specs, and gearscores,
**so that** I know what is on record before signing up for a raid.

**Command:** `/my_characters` – reply is ephemeral (visible only to the caller). Characters are
grouped by name and paginated 25 at a time; each card shows only name, class, specs, and gearscores.

---

### US-2.4 Guided Character Setup
**As a** new player,
**I want to** choose a guided Discord or website flow,
**so that** I can register characters without learning command syntax first.

**Flow:** An officer posts the reusable `/helpnoobs` launcher → any server member chooses
**Discord**, **Website**, or **Show useful bot commands** → the response is private and scoped
to that server.

- Discord first offers a guided one-at-a-time wizard or a bulk text list for multiple
  characters and specs.
- Website signs the member in, activates the originating guild, and opens the guided form.
- After saving, the member can add another character or finish.

---

### US-2.5 Edit a Character in Discord
**As a** player,
**I want to** choose one of my characters and edit it in a pre-filled Discord form,
**so that** I can correct or refresh its details without remembering command parameters.

**Flow:** Run `/my_characters` or open the Discord character guide → choose a character →
edit its name, class, and `specialization / gearscore` lines → save.

- Name and class changes apply to every specialization for that character.
- Specialization and gearscore lines can add, update, or remove specialization entries.
- Realm remains unchanged by this editor.
- The editor is private, guild-scoped, and verifies that the selected character belongs to the user.

---

## 3. Character Management (Web App)

### US-3.1 View My Characters
**As a** player,  
**I want to** view all my registered characters on the web,  
**so that** I can see their specs, gearscores, and raid-save states in one place.

**Page:** `/characters` – shows characters grouped by name with all spec rows and a save-state grid.

---

### US-3.2 Register a Character (Web)
**As a** player,  
**I want to** add a new character through the website,  
**so that** I have an alternative to the Discord slash command.

**Flow:** Fill in the form on `/characters` (name, realm, class, spec, gearscore) → submit → character appears in the list.  
If the same name+realm+spec already exists the gearscore is refreshed.

---

### US-3.3 Update a Character's Gearscore
**As a** player,  
**I want to** update the gearscore of an existing character,  
**so that** the raid comp always reflects my current gear.

**Flow:** Edit the GS field inline on `/characters` and submit the update form.

---

### US-3.4 Update a Character's Spec
**As a** player,  
**I want to** change the spec recorded for one of my character entries,  
**so that** officers see the correct specialisation in the raid composition.

**Flow:** Edit the spec field inline on `/characters` and submit the update form.

---

### US-3.5 Delete / Hide a Character
**As a** player,  
**I want to** remove a character I no longer play,  
**so that** it does not clutter my sign-up options.

**Flow:** Click the delete button next to a character on `/characters` → the character is soft-deleted (hidden from sign-up views, still in the database).

---

## 4. Raid Save / Lockout Tracking (Discord Bot)

### US-4.1 View Raid Saves
**As a** player,  
**I want to** see which raid instances my characters are currently saved to,  
**so that** I know which lockouts are active this week.

**Command:** `/saves view` – ephemeral embed with a per-character save grid.

---

### US-4.2 Set a Character's Save State
**As a** player,  
**I want to** explicitly mark a character as saved or not saved for a specific raid instance,  
**so that** the save state matches reality after running a raid.

**Command:** `/saves set character:<name> instance:<instance> saved:<yes|no>`  
Supported instances include ICC10, ICC25, TOC10, TOC25, RS10, RS25, ULD10, ULD25, and others.  
Heroic variants (ICC10 HC, TOGC25, RS25 HC, etc.) share a lockout with their canonical counterpart.

---

### US-4.3 Toggle a Character's Save State
**As a** player,  
**I want to** quickly flip a character's save state without specifying yes/no,  
**so that** I can update saves with fewer keystrokes.

**Commands:**  
- `/saves toggle character:<name> instance:<instance>`  
- `/savecharacter character:<name> instance:<instance>` (top-level shortcut)

---

### US-4.4 Clear All Saves (Weekly Reset)
**As an** officer,  
**I want to** clear every character's raid save at the start of the week,  
**so that** the save states reset in sync with the Warmane weekly server reset.

**Command:** `/saves clear_all` (Officer only) – deletes all `is_saved = 1` rows.

---

## 5. Raid Save / Lockout Tracking (Web App)

### US-5.1 Toggle Save State (Web)
**As a** player,  
**I want to** toggle a character's raid-save state directly on the characters page,  
**so that** I can manage lockouts without leaving the browser.

**Flow:** Click the save-state cell in the grid on `/characters` → the cell updates instantly via a JSON API call (no page reload required).

---

## 6. Signing Up for Raids (Discord Bot)

### US-6.1 Sign Up via Button
**As a** player,  
**I want to** sign up for a raid by clicking the ✅ **Sign Up** button on the raid embed,  
**so that** I can register my intent to attend without leaving Discord.

**Flow:**  
1. Click ✅ **Sign Up** (or ❓ **Tentative**) on the raid embed.  
2. A character-selection dropdown appears; choose one or more characters.  
3. Optionally mark characters as preferred (⭐).  
4. Confirm → sign-up is saved and posted to the raid's sign-up log thread.

---

### US-6.2 Sign Up via Text Message
**As a** player,  
**I want to** post my character info as a message in the raid channel,  
**so that** I can register the character and sign up in a single step.

**Format (one character per line):**
```
CharName / Class / Spec / GS
```
Multiple specs: `Thralladin / Paladin / Holy / 5800 / Ret / 5600`

**Optional markers:**
- Add `tentative` or `maybe` on the first line to sign up as tentative.
- Add ⭐ after a spec name to mark that spec as priority; add ⭐ after the last GS to mark all specs as priority.
- Add ❌ anywhere in a line to indicate the character is already saved this lockout.

The bot deletes the original message and posts a summary in the sign-up log thread.

---

### US-6.3 Register a Character via Bot DM
**As a** player,  
**I want to** DM the bot with my character info,  
**so that** I can register a character without posting publicly in a channel.

**Format:** Same `CharName / Class / Spec / GS` format as text sign-up.  
**Note:** DM registration only saves the character — it does **not** sign you up for any specific raid. Use the ✅ **Sign Up** button afterwards.

---

### US-6.4 Open the Sign-Up Website from Discord
**As a** player,  
**I want to** click the 🌐 **Sign Up on Website** button on the raid embed,  
**so that** I can open the raid's web page and sign up through the browser interface.

---

## 7. Signing Up for Raids (Web App)

### US-7.1 Browse the Raids List
**As a** player,  
**I want to** see all upcoming and past raids on the website,  
**so that** I can find the raid I want to sign up for.

**Page:** `/raids` – lists raids for the active guild.

---

### US-7.2 View a Raid's Details
**As a** player,  
**I want to** see full details about a specific raid (date, instance, description, current sign-ups),  
**so that** I can decide whether to attend and check who else has signed up.

**Page:** `/raids/<raid-number>` – shows the raid embed, current sign-up list, and sign-up form.

---

### US-7.3 Sign Up for a Raid (Web)
**As a** player,  
**I want to** sign up for a raid through the website,  
**so that** I have an alternative to the Discord button.

**Flow:** On the raid detail page, select a character and signup type (fill / priority role / priority character) → submit → sign-up is recorded and posted to the Discord log thread.

---

### US-7.4 Sign Up as Tentative (Web)
**As a** player,  
**I want to** indicate I might attend but am not certain,  
**so that** officers can plan around my availability.

**Flow:** Select "Tentative" status when signing up on the raid detail page.

---

## 8. Raid Management (Discord Bot – Officer)

### US-8.1 Create a Raid
**As an** officer,  
**I want to** create a new raid from Discord,  
**so that** players can see it and sign up.

**Command:** `/create_raid` – opens a modal with fields for raid name, instance, date (UTC), description, and max size.  
After submission:
- The raid embed is posted to the channel with ✅ **Sign Up**, ❓ **Tentative**, and 🌐 **Sign Up on Website** buttons.
- A **📖 How to Sign Up** thread is created on the embed message with sign-up instructions.
- A **📋 Sign-Up Log** thread is created in the channel for recording sign-ups.

### US-8.2 Edit a Posted Raid

**As an** officer,
**I want to** edit a raid that has already been posted,
**so that** its name, instance, date, description, and raid size stay accurate.

**Command:** `/edit_raid raid_id:<id>` – opens a pre-filled officer-only modal and refreshes the original Discord raid post after saving.

---

## 9. Raid Management (Web App – Officer/Admin)

### US-9.1 View a Raid's Manage Page
**As an** officer,  
**I want to** open the manage view for a raid,  
**so that** I can see all sign-ups and build the raid composition.

**Page:** `/raids/<raid-number>/manage`

---

### US-9.2 Build the Raid Composition
**As an** officer,  
**I want to** drag signed-up characters into comp slots (Tank / Healer / DPS),  
**so that** I can plan the raid roster.

**Flow:** On the manage page, assign characters to slots across one or more comp tabs (Raid 1, Raid 2, etc.).  
Each comp tab can have a custom label.

---

### US-9.3 Add Placeholder Slots
**As an** officer,  
**I want to** add placeholder slots to the composition with a descriptive label,  
**so that** I can reserve a slot for a specific role or class without a confirmed player.

---

### US-9.4 Notify Raid Members
**As an** officer,  
**I want to** post the finalised raid composition to Discord,  
**so that** all assigned players receive a mention and can see the lineup.

**Flow:** Click "Post Comp to Discord" on the manage page → the bot posts an embed to the raid's Discord channel, mentioning all assigned players.

---

### US-9.5 Lock / Unlock a Raid
**As an** officer,  
**I want to** lock a raid when sign-ups are closed,  
**so that** players know the roster is finalised.

**Flow:** Use the state-aware **Lock** / **Unlock** quick action on the raid list or manage page. The signup page stays focused on player responses. The original Discord post is refreshed and its sign-up controls are removed or restored to match the new state.

### US-9.5a Edit a Raid

**As an** officer,
**I want to** edit an existing raid from the website,
**so that** I can correct its schedule and details without reposting it.

**Page:** `/raids/<raid-number>/edit` – a pre-filled officer-only form that updates the database and original Discord raid post.

---

### US-9.6 Remove a Sign-Up
**As an** officer,  
**I want to** remove a specific sign-up from a raid,  
**so that** I can correct mistakes or remove players who can no longer attend.

---

### US-9.7 View the Raid Composition Page
**As a** player or officer,  
**I want to** see the published raid composition,  
**so that** I know whether I am assigned and who else is in the group.

**Page:** `/raids/<raid-number>/comp`

---

### US-9.8 Create a Raid (Web)
**As an** officer,  
**I want to** create a new raid from the website,  
**so that** I can schedule raids without being in Discord.

**Page:** `/raids/create` – form with raid name, instance, date, description, and max size.

---

## 10. Guild Settings (Web App – Server Manager)

### US-10.1 Configure Admin Roles
**As a** server manager,  
**I want to** add Discord roles to the list of raid-admin roles,  
**so that** officers with those roles have admin access to the web app.

**Page:** `/guild-settings` → Admin Roles section → add or remove roles from the list.

---

### US-10.2 Set the Signup Restriction
**As a** server manager,  
**I want to** control who can sign up for raids on the website,  
**so that** sign-ups are limited to the intended audience.

**Options:**
- **All** – any logged-in user can sign up.
- **Guild Member** – only Discord server members can sign up.
- **Role** – only members holding a specific Discord role can sign up.

**Page:** `/guild-settings` → Signup Restriction section.

---

### US-10.3 Set a Guild Subdomain
**As a** server manager,  
**I want to** assign a custom subdomain to my guild (e.g. `myguild.example.com`),  
**so that** players can access our raid page directly without navigating through a guild picker.

**Page:** `/guild-settings` → Subdomain section.  
Subdomain must be 1–63 lowercase letters, digits, or hyphens. Reserved names (e.g. `www`, `api`) are not permitted.

---

## 11. Admin Role Management (Discord Bot – Server Manager)

### US-11.1 Grant Raid-Admin Access
**As a** server manager,  
**I want to** grant raid-admin access to a Discord role via a bot command,  
**so that** members with that role can manage raids on the website.

**Command:** `/raidadmin add @role`

---

### US-11.2 Revoke Raid-Admin Access
**As a** server manager,  
**I want to** revoke raid-admin access from a role,  
**so that** former officers can no longer manage raids.

**Command:** `/raidadmin remove @role`

---

### US-11.3 List Admin Roles
**As a** server manager,  
**I want to** see which roles currently have raid-admin access,  
**so that** I can audit permissions.

**Command:** `/raidadmin list`

---

## 12. Recruitment System (Web App)

### US-12.1 Apply to a Guild (Applicant)
**As a** prospective guild member,  
**I want to** submit a recruitment application through the guild's public form,  
**so that** officers can review my application and invite me.

**Flow:**
1. Open the recruitment form URL (shared by officers).
2. Authenticate with Discord via OAuth (a separate OAuth flow specific to recruitment).
3. Fill in the application questions (text fields, character info, etc.).
4. Submit → application is saved with status "Pending".
5. Optionally join a notification Discord server to receive acceptance/rejection updates.

---

### US-12.2 View / Edit a Pending Application (Applicant)
**As an** applicant,  
**I want to** view or update my submitted application before it is reviewed,  
**so that** I can correct mistakes or add information.

**Flow:** Visit the form URL again while logged in → the edit view shows current answers → submit updated answers (only allowed while status is "Pending").

---

### US-12.3 Create a Recruitment Form (Admin)
**As an** officer,  
**I want to** create a recruitment form with custom questions,  
**so that** applicants provide the information we need.

**Page:** `/recruitment/new` – drag-and-drop form builder with support for text, textarea, select, and character-info question types.

---

### US-12.4 Edit a Recruitment Form (Admin)
**As an** officer,  
**I want to** update an existing recruitment form,  
**so that** the questions stay relevant as requirements change.

**Page:** `/recruitment/<form-id>/edit-form`

---

### US-12.5 Toggle a Form's Active State (Admin)
**As an** officer,  
**I want to** open or close a recruitment form,  
**so that** applications are only accepted during recruitment periods.

**Flow:** Click the toggle button next to the form on `/recruitment`.

---

### US-12.6 View Applications (Admin)
**As an** officer,  
**I want to** see all submitted applications for a form,  
**so that** I can review candidates.

**Page:** `/recruitment/<form-id>/applications`

---

### US-12.7 Accept or Reject an Application (Admin)
**As an** officer,  
**I want to** accept or reject a recruitment application,  
**so that** the applicant receives a decision.

**Flow:** Open the application detail page → click Accept or Reject.  
A notification is posted to a dedicated Discord channel so the applicant is informed.

---

## 13. Developer Tools

### US-13.1 Seed Fake Sign-Ups (Dev – Web)
**As a** developer,  
**I want to** add fake sign-ups to a specific raid,  
**so that** I can test the composition and manage pages with a full roster.

**Page:** Manage page for a raid → 🧪 **Seed Fake Signups** button (visible only when `DEV_MODE=true`).

---

### US-13.2 Manage Spec Aliases (Developer)
**As the** designated developer,  
**I want to** add or remove spec name aliases in the database,  
**so that** common abbreviations (e.g. "Ret" → "Retribution") are recognised when players post character lines.

**Page:** `/admin/spec-aliases` (accessible only to the account matching `DEV_USER_ID`).
