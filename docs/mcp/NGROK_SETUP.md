# ngrok Setup for GBrain MCP + Voice

## Goal

Get a fixed public URL for your GBrain MCP server and voice agent. One ngrok
account serves both.

## What the User Gets

Without this: free ngrok URLs change every restart. Twilio webhooks break.
Claude Desktop disconnects. You spend more time fixing URLs than using the brain.

With this: one fixed domain (e.g., `your-brain.ngrok.app`) that never changes.
Twilio and Claude Desktop point at it once. Watchdog auto-restarts everything.

## Why ngrok Hobby ($8/mo)

Free ngrok gives you ephemeral URLs that change on every restart. The voice
agent watchdog can auto-update Twilio, but Claude Desktop and Perplexity can't
be auto-reconfigured. A fixed domain solves this permanently.

**ngrok Hobby tier ($8/mo) gives you:**
- 1 fixed domain (e.g., `your-brain.ngrok.app`)
- No URL changes on restart
- Dashboard with request inspection
- Enough bandwidth for MCP + voice

## Setup Flow

### Step 1: Create ngrok Account

Tell the user:
"I need you to create an ngrok account and get a fixed domain.

1. Go to https://dashboard.ngrok.com/signup (sign up free)
2. Go to https://dashboard.ngrok.com/billing and upgrade to **Hobby** ($8/mo)
3. Go to https://dashboard.ngrok.com/get-started/your-authtoken
4. Copy your **Authtoken** and paste it to me"

Configure ngrok:
```bash
ngrok config add-authtoken YOUR_TOKEN
```

### Step 2: Claim Your Fixed Domain

Tell the user:
"1. Go to https://dashboard.ngrok.com/domains
2. Click **'+ New Domain'**
3. Choose a name (e.g., `your-brain.ngrok.app`)
4. Click **'Create'**
5. Tell me the domain name"

### Step 3: Decide What to Expose

You can run MCP and voice on the same ngrok domain with different paths:

```
https://your-brain.ngrok.app/mcp     → GBrain MCP server (port 3000)
https://your-brain.ngrok.app/voice   → Voice agent (port 8765)
```

Or use two separate tunnels (simpler but uses 2 domains):
```bash
# MCP tunnel
ngrok http 3000 --url your-brain-mcp.ngrok.app

# Voice tunnel
ngrok http 8765 --url your-brain-voice.ngrok.app
```

### Step 4: Start the Tunnel

```bash
# For MCP server:
ngrok http 3000 --url your-brain.ngrok.app

# For voice agent:
ngrok http 8765 --url your-brain-voice.ngrok.app
```

### Step 5: Configure AI Clients

**Claude Code:**
```bash
claude mcp add gbrain -t http https://your-brain.ngrok.app/mcp \
  -H "Authorization: Bearer YOUR_TOKEN"
```

**Claude Desktop:**
Go to Settings > Integrations > Add. Enter the URL:
`https://your-brain.ngrok.app/mcp`
(Note: Claude Desktop does NOT support remote MCP via JSON config. You MUST
use the Settings > Integrations GUI.)

**Perplexity Computer:**
Settings > Connectors > Add Remote MCP.
URL: `https://your-brain.ngrok.app/mcp`

**Twilio (for voice):**
```bash
twilio phone-numbers:update PHONE_SID \
  --voice-url https://your-brain-voice.ngrok.app/voice
```

### Step 6: Watchdog (Auto-Restart)

Create a watchdog that keeps ngrok + services alive:

```bash
#!/bin/bash
# watchdog.sh — run via cron every 2 minutes

# Check if MCP server is running
if ! curl -sf http://localhost:3000/health > /dev/null 2>&1; then
  echo "[watchdog] MCP server not running — starting..."
  cd /path/to/gbrain && gbrain serve &
  sleep 2
fi

# Check if ngrok tunnel is running
if ! pgrep -f "ngrok.*http.*3000" > /dev/null 2>&1; then
  echo "[watchdog] ngrok not running — starting..."
  nohup ngrok http 3000 --url your-brain.ngrok.app > /dev/null 2>&1 &
  sleep 5
fi

echo "[watchdog] All services running"
```

Add to crontab:
```bash
*/2 * * * * /path/to/watchdog.sh >> /tmp/watchdog.log 2>&1
```

## Tricky Spots

1. **Claude Desktop does NOT support remote MCP via JSON config.** You MUST
   use Settings > Integrations in the GUI. This is the #1 setup failure.

2. **One ngrok account, two tunnels.** Hobby gives you 1 free domain. If you
   need both MCP and voice, either route by path on one domain or pay for
   a second domain ($8/mo more).

3. **The watchdog is mandatory.** Without it, a server crash at 3 AM means
   your brain is offline until you notice. The watchdog restarts within 2 min.

4. **ngrok inspect dashboard.** Go to `http://localhost:4040` to see all
   requests flowing through the tunnel. Useful for debugging MCP connection
   issues.

## How to Verify

1. Start the tunnel. Visit `https://your-brain.ngrok.app/health` in a browser.
   You should see a health check response.
2. From Claude Desktop, run a search. Verify results come back from your brain.
3. Kill the server process. Wait 2 minutes. Check the watchdog restarted it.
4. From a different device, access the same URL. Verify it works remotely.

---

*Part of the [GBrain Docs](../). See also: [Remote MCP Deployment](DEPLOY.md)*
