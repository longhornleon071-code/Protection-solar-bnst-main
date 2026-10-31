# Bunny Team

Trading and middleman community site for Adopt Me and Murder Mystery 2.
Plain HTML/CSS/JS front end and a Node.js server with a JSON API. No external packages.

## Files

- `server.mjs`: web server, JSON API, and sign-in. The only server file.
- `public/index.html`: the whole front end, one file, no build step.
- `package.json`: start script (`npm start`). Needs Node 22 or newer.

## Run it

1. Install Node.js 22 or newer.
2. In this folder, run:
   ```
   npm start
   ```
3. Open http://localhost:3000 in your browser.
4. Check http://localhost:3000/health. It should say `ok`.

Open the site through the server (step 3). Opening `public/index.html` as a file
runs the app in browser-only mode, where data is stored separately in each browser.

## First-time setup

The server starts empty. There are no sample accounts or sample trades.

1. Open the site and choose **Create account**.
2. The **first** account created on an empty server becomes the **Owner**. Do this yourself before sharing the link.
3. Every account after that is a **Member**. The Owner (and staff with enough rank) can give roles from the Profile tab.
4. Staff can add members from the Profile tab. The server shows a temporary password once. Give it to the member, and they should change it.

Passwords must be at least 8 characters. After 5 wrong passwords for one username,
sign-in for that username is locked for 15 minutes.

## Before going live

This is still a test build. Read this before you share it with people.

| Area | Status |
|---|---|
| Passwords | Stored as scrypt hashes. Never sent back to the browser. |
| Sessions | Random tokens kept in server memory. Lost when the server restarts. |
| Data | Kept in server memory. Everything resets when the server restarts or redeploys. |
| Login | Username and password only. No email reset and no 2-step login yet. |
| Images (avatar, banner, proof) | Stored in memory as small images. Needs real file storage and scanning. |
| Values and calculators | Built-in numbers are not official. Add a real price source before relying on them. |
| HTTPS | Required for real use. Put the server behind HTTPS (for example Render or a reverse proxy). |

Do not use this build for real identity checks, customer records, or financial records yet.

## Items, fees, and commissions

- **Items:** Adopt Me and MM2 item lists (name and price) are stored on the server. Only the **Owner** can change them from Market, then "Edit items, fees, and commissions".
- **Fee schedule:** The fee table (for example P100 to P500 free, P501 to P1,000 at 1%) sets the commission on each trade by transaction amount. Only the Owner can edit it.
- **Middleman commission:** Each middleman can set their own commission percentage in Profile. The Owner can set anyone's. It shows on the middleman's verify and vouch links so customers see it.
- Currency is Philippine peso (P).

## Swapping in a database

All data access goes through the `db` object and the `statsOf()` function in
`server.mjs`. Replace those with a real database and leave the routes and the front
end as they are.

## Deploy on Render

Create a **Web Service** from your GitHub repo:
- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`

No database or environment variables are needed for this version.

## Permissions (enforced in `server.mjs`)

Ranks: Owner 10, Co-Owner 9, Head Admin 8, Head Mod 7, Admin 6, Moderator 5,
Trial Admin 4, Trial Mod 3, Member 2, Visitor 1.

- Create links and trades: rank 3 and up
- Revoke other people's links: 6 and up
- Review vouches and reports: 5 and up
- Activity log: 6 and up
- Change roles (below your own) and add members: 8 and up
- Create listings: 2 and up
