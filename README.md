# Who Runs

Territory-based running app with live GPS tracking and Supabase realtime.

## Setup

### 1. Supabase Tables
Run `supabase-setup.sql` in your Supabase SQL Editor.

### 2. Environment Variables
Add these to Vercel under **Settings → Environment Variables**:

| Key | Value |
|-----|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Your Supabase anon/public key |

Find both at: Supabase Dashboard → Settings → API

### 3. Deploy
Push to GitHub → Vercel auto-deploys.

## Features
- ✅ Real GPS tracking via browser `watchPosition`
- ✅ Live location sync to Supabase
- ✅ Realtime team map via Supabase channels
- ✅ Run stats (distance, pace, time, SQM)
- ✅ Session saved to DB on run end
- ✅ Me / Team tabs
