# HoloSwap Backend — Setup Guide

## Overview

This guide gets you from a bare VPS to a working backend with:
- **Coolify** (self-hosted PaaS — manages your apps & databases)
- **PostgreSQL** (database)
- **Node.js API** (handles waitlist signups & user accounts)
- **Landing page** connected to the API

---

## Part 1: Install Coolify on Your VPS

### Requirements
- A VPS with at least **2GB RAM** and **2 vCPUs** (Hetzner, DigitalOcean, Vultr, etc.)
- Ubuntu 22.04 or 24.04
- A domain name (optional but recommended, e.g. `api.holoswap.co.uk`)

### Step 1: SSH into your server

```bash
ssh root@your-server-ip
```

### Step 2: Install Coolify (one command)

```bash
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash
```

This takes about 2–5 minutes. When it's done, it'll show you a URL.

### Step 3: Access Coolify Dashboard

Open your browser and go to:

```
http://your-server-ip:8000
```

Create your admin account when prompted.

### Step 4: (Optional) Point a domain at Coolify

In your DNS settings, add an A record:
- `coolify.yourdomain.com` → `your-server-ip`

Then in Coolify settings, set your domain so you get free SSL.

---

## Part 2: Set Up PostgreSQL in Coolify

1. In the Coolify dashboard, go to **Projects** → **Create New Project** → name it `holoswap`
2. Inside the project, click **New Resource** → **Database** → **PostgreSQL**
3. Use these settings:
   - Name: `holoswap-db`
   - PostgreSQL version: `16`
   - Database name: `holoswap`
   - Username: `holoswap`
   - Password: (generate a strong one and **save it**)
4. Click **Deploy**
5. Once running, note the **Internal URL** — it'll look like:
   ```
   postgresql://holoswap:yourpassword@holoswap-db:5432/holoswap
   ```

---

## Part 3: Deploy the API

### Option A: Deploy via Coolify (Recommended)

1. Push the `holoswap-api` folder (provided below) to a **GitHub repo**
2. In Coolify: **New Resource** → **Application** → **GitHub**
3. Select your repo, set:
   - Build pack: **Nixpacks** (auto-detects Node.js)
   - Port: `3000`
4. Add these **Environment Variables**:
   ```
   DATABASE_URL=postgresql://holoswap:yourpassword@holoswap-db:5432/holoswap
   JWT_SECRET=generate-a-random-64-char-string-here
   CORS_ORIGIN=https://yourdomain.com
   ```
5. (Optional) Set a domain like `api.holoswap.co.uk`
6. Click **Deploy**

### Option B: Deploy manually via SSH

```bash
cd /opt
git clone https://github.com/yourusername/holoswap-api.git
cd holoswap-api
npm install
export DATABASE_URL="postgresql://holoswap:yourpassword@localhost:5432/holoswap"
export JWT_SECRET="generate-a-random-64-char-string-here"
export CORS_ORIGIN="https://yourdomain.com"
npm run migrate
npm start
```

---

## Part 4: Connect Your Landing Page

Once the API is deployed, update the landing page JavaScript (see the comment `// TODO: Replace with your API URL`):

```javascript
const API_URL = 'https://api.holoswap.co.uk'; // your API domain
```

That's it — the landing page will now send real signups to your database.

---

## Project Files

Below is the complete file structure. All files are also provided separately.

```
holoswap-api/
├── package.json
├── .env.example
├── src/
│   ├── index.js          # Express server entry point
│   ├── db.js             # Database connection
│   ├── migrate.js        # Creates tables
│   └── routes/
│       ├── waitlist.js   # POST /api/waitlist
│       └── auth.js       # POST /api/register, POST /api/login
```
