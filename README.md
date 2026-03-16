# EasyDraft

A web-based snake-draft management system for youth sports leagues. Supports multiple simultaneous drafts, a live admin board, and a read-only coach view on any device.

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

> **Note:** Coach PINs are set per-draft inside the app after logging in as admin. There is no global coach PIN.

---

## Admin Guide

The admin account has full control over all drafts.

### Logging In

On the login screen enter the **League Name** and **Admin PIN** set during setup.

### Creating a Draft

1. Click **⚙ Admin** to open the admin panel.
2. Click **+ New Draft** and give it a name. The panel switches to the **1. Settings** tab automatically.

### 1. Settings Tab

| Field | Description |
|---|---|
| Draft Name | Display name shown on the board |
| Timer (min) | Per-pick countdown in minutes (`0` = no timer) |
| Auto-pick on expire | Automatically drafts the top available player when the timer runs out |
| Coach Access Name | Login name coaches use on the login screen |
| Coach PIN | Password coaches use to access this draft (read-only) |

Click **Save Settings** when done.

### 2. Teams Tab

- Add team names one at a time with **+ Add Team**.
- Delete teams with the **×** button.
- Teams are ordered by the order you add them; this becomes the draft order.

### 3. Players Tab

Import the player pool for this draft using one of two methods:

**Paste List** — one player name per line; line order sets the initial ranking.

**CSV File** — upload a `.csv` with columns: `name, rank, position, age, coaches_kid`

After importing players (or changing teams), click **▶ Setup Pick Order** to generate the snake-draft pick slots. This must be done before starting the draft.

> If you change teams or players after setting up the pick order, the button will flash and tabs will be locked until you run Setup Pick Order again.

### Running the Draft

The draft controls sit in the bar at the top of the board:

| Button | When visible | Action |
|---|---|---|
| **▶ Start** | Setup | Begins the draft at the first unfilled pick |
| **⏸ Pause** | Active | Pauses the timer and freezes the current pick |
| **▶ Resume** | Paused | Resumes from where it left off |
| **⏹ End** | Active / Paused | Ends the draft immediately |
| **▶ Restart** | Completed | Restarts from the first unfilled pick |
| **⚡ Auto-pick** | Active (timer on) | Immediately drafts the top available player |

### Making Picks

- **Click** a player in the left panel, or **drag** them onto any board cell.
- Dropping on a cell always asks for confirmation before assigning.
- Dropping on a filled cell will replace the existing player.
- Use the **×** button on any filled cell (or right-click) to clear a pick.

### Pre-assigning Picks

Drag a player onto a **future** pick slot to pre-assign them before the draft reaches that round. The cell is marked with a dashed border.

### Reordering Players

Click **⇅ Reorder** above the player list to drag-and-drop player rankings. Changes save automatically.

### Danger Zone Tab

**↺ Reset All Picks** — clears all player assignments and returns the draft to setup status. Teams and players are kept.

---

## Coach (Read-Only) Guide

Coaches see a live read-only view of the board. They cannot make or change picks.

### Logging In

On the login screen enter the **Coach Access Name** and **Coach PIN** set by the admin in the draft's Settings tab. A coach can be granted access to multiple drafts with the same credentials.

### Desktop View

- The full draft board is displayed with all teams and rounds.
- The **ON THE CLOCK** cell flashes pink to highlight the current pick.
- The column header for the team currently on the clock also flashes.
- The countdown timer (if enabled) is shown in the top bar and inside the ON THE CLOCK cell.
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
- When the draft ends a **Draft Complete** announcement plays and a badge appears in the header.

---

## Project Structure

```
easydraft/
├── index.php          # Single-page app shell
├── api/
│   ├── auth.php       # Login / logout / session
│   ├── config.php     # Generated by setup.php — contains DB credentials
│   ├── drafts.php     # Draft lifecycle, picks, timer
│   ├── helpers.php    # Shared DB connection and utilities
│   ├── players.php    # Player import and reorder
│   ├── setup.php      # One-time install wizard (blocked after first run)
│   └── teams.php      # Team CRUD
├── css/
│   └── app.css
├── js/
│   └── app.js
└── sql/
    └── schema.sql     # Database schema (applied automatically by setup.php)
```

### File permissions

| Path | Owner | Mode | Notes |
|---|---|---|---|
| `easydraft/` (root) | `www-data:www-data` | `755` | Web server reads, no write needed |
| `api/` | `www-data:www-data` | `755` | Web server must be able to write `config.php` during setup |
| `api/config.php` | `www-data:www-data` | `640` | Created by setup; readable by web server only |
| `api/*.php` (others) | `www-data:www-data` | `644` | Read-only |
| `css/`, `js/` | `www-data:www-data` | `755` / `644` | Read-only |
| `sql/schema.sql` | `www-data:www-data` | `644` | Read-only |

Quick setup:
```bash
chown -R www-data:www-data /var/www/html/easydraft
find /var/www/html/easydraft -type d -exec chmod 755 {} \;
find /var/www/html/easydraft -type f -exec chmod 644 {} \;
```
After setup completes, lock down `config.php`:
```bash
chmod 640 /var/www/html/easydraft/api/config.php
```
