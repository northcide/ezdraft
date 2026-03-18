# ezDraft

A web-based draft management system for youth sports leagues. Supports multiple simultaneous drafts, a live admin board, team login, and a read-only coach view on any device.

## Stack

- PHP 8+ / MySQL (LAMP/LEMP)
- Vanilla JS / HTML / CSS — no build step, no dependencies

---

## Server Setup

### Requirements

- Apache or Nginx with PHP 8+
- MySQL 5.7+ or MariaDB 10.3+
- PHP PDO + PDO_MySQL extensions enabled

### Installation

1. **Clone the repo** into your web root (e.g. `/var/www/html/easydraft`):
   ```bash
   git clone https://github.com/northcide/easydraft.git
   cd easydraft
   ```

2. **Run the setup wizard** by visiting `http://your-server/easydraft/api/setup.php` in a browser.

   Fill in:
   - **DB Host** — usually `localhost`
   - **DB Name** — the MySQL database to create (e.g. `easydraft`)
   - **DB User / Password** — MySQL credentials with CREATE DATABASE privileges
   - **League Name** — shown on the login screen (e.g. `Majors 2026`)
   - **Admin PIN** — the password for the admin account

   The wizard creates the database, runs the schema, writes `api/config.php`, and saves your settings.

3. **Delete or restrict `setup.php`** after first run to prevent re-configuration:
   ```bash
   rm api/setup.php
   ```

4. **Point your browser** to `http://your-server/easydraft/` — the login screen will appear.

### Upgrading an existing install

If you are pulling a new version into an existing database, run any migration scripts found in `sql/` that apply to your current version. Each file is labeled with a description (e.g. `migrate_archive.sql`, `migrate_pitcher_catcher.sql`). Commented-out `ALTER TABLE` statements at the bottom of `schema.sql` document columns added after initial release.

---

## Roles

| Role | Access |
|------|--------|
| **Admin** | Full control over all drafts, teams, players, and settings |
| **Coach** | Read-only live view of the board (shared or per-team login) |
| **Team** | Read-only view scoped to their own team's picks (team mode only) |

---

## Admin Guide

### Logging In

On the login screen enter the **League Name** and **Admin PIN** set during setup.

### Creating a Draft

1. Click **Admin** to open the admin panel.
2. Click **+ New Draft** and give it a name. The panel switches to the **Settings** tab automatically.

---

### Settings Tab

| Field | Description |
|-------|-------------|
| Draft Name | Display name shown on the board |
| Rounds | Total number of rounds |
| Timer (min) | Per-pick countdown in minutes (`0` = no timer) |
| Auto-pick on expire | Automatically drafts the highest-ranked available player when the timer runs out |
| Draft Type | **Snake** (direction reverses each round) or **Straight** (same order every round) — locked once the draft starts |
| Coach Access | Login name coaches use on the login screen |
| Coach PIN | Password for the shared coach login |
| Coach Mode | **Shared** — all coaches share one login; **Team** — each team uses their own team PIN |

> Settings that affect draft structure (Draft Type, Rounds) are locked after the draft starts.

Click **Save Settings** when done.

---

### Teams Tab

- Add team names one at a time with **+ Add Team**.
- Remove teams with the **×** button.
- **Drag the handle** (⠿) next to any team to reorder them — the order here becomes the draft order.
- In **Team** coach mode, each team gets its own **PIN** field. Set a PIN per team so that team can log in and see their picks.

> After reordering teams, pick slots are automatically rebuilt if the draft is still in setup status.

---

### Players Tab

Import the player pool using one of two methods:

**Paste List** — one player name per line; line order sets the initial ranking.

**CSV File** — upload a `.csv` with columns: `name, rank, position, age, coaches_kid, is_pitcher, is_catcher, notes`

Player attributes:

| Attribute | Description |
|-----------|-------------|
| Position | Displayed on the board (e.g. `P`, `C`, `SS`) |
| Age | Shown in the player list |
| Coach's Kid | Flagged with a star icon — useful for compliance tracking |
| Pitcher | Flagged for pitch-count or eligibility tracking |
| Catcher | Flagged for eligibility tracking |
| Notes | Free-text notes visible to admin |

After importing players (or changing teams), click **Setup Pick Order** to generate the pick slots. This must be done before starting the draft.

> If you change teams or players after setting up the pick order, the tabs will be locked until you run Setup Pick Order again.

---

### Running the Draft

The draft controls sit in the bar at the top of the board:

| Button | When available | Action |
|--------|----------------|--------|
| **Start** | Setup complete | Begins the draft at the first unfilled pick |
| **Pause** | Active | Pauses the timer and freezes the current pick |
| **Resume** | Paused | Resumes from where it left off, restoring the remaining time |
| **Restart** | Completed | Resets picks and restarts from the beginning |
| **End** | Active or Paused | Ends the draft immediately |
| **Auto-pick** | Timer enabled | Immediately drafts the top available player (grayed out when paused) |
| **Undo** | Active | Clears the most recent pick |

Start / Pause / Resume / Restart all share one button that changes label and color based on the draft's current status.

---

### Making Picks

- **Click** a player in the left panel to assign them to the current pick slot.
- **Drag** a player onto any board cell to assign them to any slot (including future rounds).
- Dropping on a filled cell replaces the existing player after confirmation.
- Use the **×** button on any filled cell to clear that pick.

### Pre-assigning Picks

Drag a player onto a **future** pick slot to pre-assign them. The cell is marked with a dashed border and filled in automatically when the draft reaches that pick.

### Reordering Players

Click **Reorder** above the player list to drag-and-drop player rankings. Changes save automatically and affect auto-pick priority.

---

### Archiving Drafts

Completed drafts can be **archived** to hide them from the active list without deleting data. Archived drafts can be unarchived at any time. The board is read-only for archived drafts.

---

## Coach / Team Guide

Coaches and teams see a live read-only view of the board. They cannot make or change picks.

### Logging In

- **Shared mode:** Enter the **Coach Access Name** and **Coach PIN** set in the draft's Settings tab.
- **Team mode:** Enter the team name and the **team PIN** set in the Teams tab.

Credentials grant access to all drafts they are associated with.

### Desktop View

- The full draft board is displayed with all teams and rounds.
- The **ON THE CLOCK** cell flashes pink to highlight the current pick.
- The column header for the team currently picking also flashes.
- The countdown timer (if enabled) is shown in the top bar and inside the ON THE CLOCK cell.
- When the draft is paused, a **PAUSED** indicator replaces the timer display.
- The board updates automatically every 2 seconds — no manual refresh needed.

### Mobile View

- Rounds are shown as collapsible cards. The current round expands automatically.
- A pink **On the Clock** banner at the top shows which team is picking.
- Tap **Show Players** to see the full player list. Check **Available only** to filter out drafted players.
- A full-screen pop-up appears each time a pick is made (tap to dismiss).
- Audio chime plays on each pick; vibration fires on Android devices.

### Pick Notifications

- Every pick triggers a brief animated overlay showing the pick number, team name, and player name.
- The overlay auto-dismisses after 4 seconds or can be tapped to close early.
- When the draft ends a **Draft Complete** banner appears.

---

## Diagnostics

Two diagnostic scripts are included for troubleshooting production installs. Both require a `?key=checkme` URL parameter and should be deleted after use.

| Script | Purpose |
|--------|---------|
| `api/check_schema.php` | Compares DB columns against the expected schema; prints ready-to-run `ALTER TABLE` statements for any missing columns |
| `api/diag.php` | Full system check: PHP environment, DB connection, charset, schema columns, indexes, settings table, and data integrity (orphaned picks, duplicates, active draft state) |

---

## Project Structure

```
easydraft/
├── index.php                    # Single-page app shell
├── api/
│   ├── auth.php                 # Login / logout / session
│   ├── check_schema.php         # Schema column checker (delete after use)
│   ├── config.php               # Generated by setup.php — contains DB credentials
│   ├── diag.php                 # Full diagnostics script (delete after use)
│   ├── drafts.php               # Draft lifecycle, picks, timer, settings
│   ├── helpers.php              # Shared DB connection and utilities
│   ├── players.php              # Player import and reorder
│   ├── setup.php                # One-time install wizard (delete after use)
│   └── teams.php                # Team CRUD and reorder
├── css/
│   └── app.css
├── js/
│   └── app.js
└── sql/
    ├── schema.sql                   # Full DB schema
    ├── migrate_archive.sql          # Adds archive column (upgrade script)
    └── migrate_pitcher_catcher.sql  # Adds pitcher/catcher columns (upgrade script)
```

---

## File Permissions

| Path | Owner | Mode | Notes |
|------|-------|------|-------|
| `easydraft/` (root) | `www-data:www-data` | `755` | Web root |
| `api/` | `www-data:www-data` | `755` | Must be writable during setup for `config.php` |
| `api/config.php` | `www-data:www-data` | `640` | Created by setup; readable by web server only |
| `api/*.php` (others) | `www-data:www-data` | `644` | Read-only |
| `css/`, `js/` | `www-data:www-data` | `755` / `644` | Read-only |
| `sql/` | `www-data:www-data` | `755` / `644` | Read-only |

Quick setup:
```bash
chown -R www-data:www-data /var/www/html/easydraft
find /var/www/html/easydraft -type d -exec chmod 755 {} \;
find /var/www/html/easydraft -type f -exec chmod 644 {} \;
chmod 640 /var/www/html/easydraft/api/config.php
```
