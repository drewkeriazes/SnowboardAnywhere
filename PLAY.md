# How to Play SnowboardAnywhere

The short version for riders. No coding needed, just copy and paste a few commands.

You need about 15 minutes and 1 GB of free space for the first setup.

---

## Step 1: Install two free programs (one time)

1. **Git** (downloads the game): https://git-scm.com/downloads
   Run the installer and click Next on every screen. The defaults are fine.
2. **Node.js** (runs the game): https://nodejs.org
   Get the **LTS** version. Click Next on every screen.

Then **restart your computer** (or at least close every terminal window) so it picks them up.

## Step 2: Open a terminal

- **Windows:** press the Windows key, type `cmd`, press Enter. (Use this, not PowerShell.)
- **Mac:** press Cmd + Space, type `Terminal`, press Enter.

Check that both programs installed. Type each line and press Enter:

```
git --version
node --version
```

You should see version numbers. If you see "not recognized" or "command not found", see Troubleshooting below.

## Step 3: Download the game (one time)

Copy and paste these, one line at a time:

```
cd %USERPROFILE%
git clone https://github.com/drewkeriazes/SnowboardAnywhere.git
cd SnowboardAnywhere\game
npm install
```

On a Mac, use these instead of the first and third lines:

```
cd ~
cd SnowboardAnywhere/game
```

`npm install` takes a minute or two. Warnings in yellow are normal.

## Step 4: Download a mountain (one time per resort)

Still in the same window:

```
npm run get vail
```

That downloads Vail (about 240 MB). Other resorts:

```
npm run get breckenridge
npm run get -- --list
```

The second line shows every resort you can download.

Skip this step if you like: the game's **Change resort** menu can download them too.

## Step 5: Play

```
npm run dev
```

Open **Chrome** or **Edge** and go to:

**http://localhost:5173/?pack=vail**

Click once on the page to turn on sound. Leave the terminal window open while you play.
To stop the game, click the terminal and press **Ctrl + C**.

---

## Playing again later

Open a terminal and run:

```
cd %USERPROFILE%\SnowboardAnywhere\game
git pull
npm install
npm run dev
```

(Mac: first line is `cd ~/SnowboardAnywhere/game`.)

`git pull` grabs the newest version of the game. Then open http://localhost:5173/?pack=vail again.

If the game says your resort **needs rebuild**, get the new version of it:

```
npm run get vail -- --force
```

---

## Basic controls

| Keyboard | Controller | What it does |
| --- | --- | --- |
| A / D | left stick | steer |
| W | R2 / RT | tuck (go faster) |
| S | L2 / LT | brake |
| Space (hold, let go) | Cross / A | jump |
| Shift | Square / X | carve hard, grab in the air |
| E | Triangle / Y | ride a lift |
| M | D-pad right | map (click to drop in anywhere) |
| C | D-pad up | change camera |
| R (hold) | | restart |
| Esc | Options / Start | pause and settings |

Plug in a PlayStation or Xbox controller and press any button with the game open. It just works.

The full list of controls is in the main [README](README.md#controls).

---

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `'git' is not recognized` or `'node' is not recognized` | Restart your computer after installing. Still broken? Reinstall from Step 1. |
| `npm.ps1 cannot be loaded because running scripts is disabled` | You are in PowerShell. Close it and open **cmd** instead (Step 2). |
| `npm ERR! enoent ... package.json` | You are in the wrong folder. Run `cd %USERPROFILE%\SnowboardAnywhere\game` first (Mac: `cd ~/SnowboardAnywhere/game`). |
| `destination path 'SnowboardAnywhere' already exists` | You already downloaded it. Skip to "Playing again later". |
| Page says "This site can't be reached" | The game isn't running. Run `npm run dev` and keep that window open. |
| Terminal says a different address, like `localhost:5174` | Something else is using the port. Use the address the terminal shows. |
| Menu loads but no mountain, or "pack not found" | Download it: `npm run get vail`. |
| Download stops partway | Run the same `npm run get` line again. |
| `git pull` says "Your local changes would be overwritten" | Run `git checkout .` then `git pull` again. |
| Game is choppy | Esc > Settings > Graphics > pick **Low** or **Medium**. Close other tabs. |
| No sound | Click the page once. Browsers wait for a click before playing sound. |
| Controller not working | Press a button while the game tab is in front. Use Chrome or Edge. |
| Something else | Close the terminal, open a new one, and start again from "Playing again later". |

Still stuck? Copy the red error text from the terminal and send it to Drew.
