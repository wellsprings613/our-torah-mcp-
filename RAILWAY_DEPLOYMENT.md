# 🚂 Railway Deployment Guide for Torah MCP

This guide will help you deploy the Torah MCP server to Railway, making it publicly accessible for ChatGPT and Claude users to connect via MCP connectors.

---

## 📋 Prerequisites

- [x] Code changes committed to GitHub
- [x] Railway account (create at [railway.com](https://railway.com))
- [x] GitHub account
- [ ] Optional: API keys for enhanced features (TAVILY_API_KEY, OPENAI_API_KEY)

---

## 🚀 Quick Start (5 Minutes)

### **Step 1: Create Railway Account**

1. Go to [https://railway.com](https://railway.com)
2. Click **"Login"** or **"Start a New Project"**
3. Choose **"Login with GitHub"**
4. Authorize Railway to access your GitHub account

**Time:** 1-2 minutes

---

### **Step 2: Deploy from GitHub**

1. Once logged in, click **"New Project"**
2. Select **"Deploy from GitHub repo"**
3. Find and select: **`wellsprings613/our-torah-mcp-`**
4. Railway will automatically:
   - Detect it's a Node.js project ✅
   - Read `package.json` ✅
   - Install dependencies ✅
   - Run `npm start` ✅

**Time:** 30 seconds to configure, 2-3 minutes to build

---

### **Step 3: Monitor the Build**

Watch the build logs in real-time:

```
Installing dependencies...
✓ Found package.json
✓ Running npm ci
✓ tsx installed successfully
✓ Starting application: npm start
✓ Server listening on $PORT
✓ Deployment successful!
```

**Expected Build Time:** 2-3 minutes

---

### **Step 4: Generate Public Domain**

1. In your Railway project dashboard, click on your service
2. Go to **Settings** tab
3. Scroll to **Networking** section
4. Click **"Generate Domain"**
5. Railway will create a URL like:
   ```
   https://torah-mcp-production.up.railway.app
   ```

**Time:** 30 seconds

---

### **Step 5: Test Your Deployment**

**Health Check:**
```bash
curl https://YOUR-RAILWAY-DOMAIN.up.railway.app/healthz
```

**Expected Response:**
```json
{
  "ok": true,
  "uptime": 123.45,
  "counters": {
    "fetches": 0,
    "cacheHits": 0,
    "robotsBlocked": 0,
    "errors": 0
  },
  "requests": 0,
  "avgLatencyMs": 0,
  "toolCounts": {},
  "pythonChains": {
    "status": "ok"
  }
}
```

**Dashboard:**
Visit `https://YOUR-RAILWAY-DOMAIN.up.railway.app/dashboard` in your browser

**Time:** 1 minute

---

## 🔧 Environment Variables (Optional)

Railway automatically sets `PORT` and `NODE_ENV=production`. You can add optional variables:

### **How to Add Environment Variables:**

1. In Railway dashboard, click your service
2. Go to **Variables** tab
3. Click **"New Variable"**
4. Add variables as needed

### **Available Variables:**

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | Auto-set | Railway assigns | Server port (Railway manages this) |
| `NODE_ENV` | Auto-set | `production` | Environment mode |
| `MCP_API_KEY` | No | None | Require authentication for MCP endpoints |
| `TAVILY_API_KEY` | No | None | Enable web search in mcp-web tools |
| `OPENAI_API_KEY` | No | None | Enable vision features (image analysis) |
| `LOG_LEVEL` | No | `info` | Logging verbosity (info, debug, error) |
| `WEB_MAX_RESULTS` | No | `10` | Max web search results |
| `ROBOTS_OBEY` | No | `false` | Respect robots.txt (set `true` for production) |

### **Recommended Production Settings:**

```bash
NODE_ENV=production  # Auto-set by Railway
LOG_LEVEL=info
MCP_API_KEY=         # Leave blank for public access
ROBOTS_OBEY=true     # Respect robots.txt
```

---

## 📱 Connecting from ChatGPT/Claude Apps

Once deployed, users can connect via MCP connectors:

### **Claude Mobile App:**

1. Open Claude app
2. Go to **Settings** → **Connectors**
3. Tap **"Add Connector"**
4. Fill in:
   - **Name:** `Torah MCP - Sefaria`
   - **Description:** `Access to 300,000+ Jewish texts from Sefaria`
   - **MCP Server URL:** `https://YOUR-RAILWAY-DOMAIN.up.railway.app/mcp/sse/`
   - **Authentication:** `None` (or API Key if you set MCP_API_KEY)

### **ChatGPT Connectors:**

Same process - use the MCP Server URL:
```
https://YOUR-RAILWAY-DOMAIN.up.railway.app/mcp/sse/
```

### **Available Tools:**

After connecting, users will have access to:

- `search` - Search Jewish texts
- `fetch` - Retrieve specific passages
- `get_commentaries` - Get commentaries on texts
- `compare_versions` - Compare text versions
- `get_daily_learnings` - Calendar-based learning
- `find_refs` - Extract references
- `sugya_explorer` - Deep topic exploration
- `topics_search` - Topic-based discovery
- `parsha_pack` - Weekly Torah portion
- `topic_sheet_curator` - Curate source sheets
- `insight_layers` - Compare commentators
- `calendar_insights` - 7-day learning alerts

---

## 💰 Cost Estimates

### **Railway Pricing (2025):**

**Hobby Plan: $5/month**
- Includes $5 of usage credits
- If usage stays under $5, you only pay the subscription
- If usage exceeds $5, pay the difference

### **Estimated Costs for Torah MCP:**

**Light Usage** (10-50 queries/day):
- **Cost:** $5-6/month

**Moderate Usage** (100-200 queries/day):
- **Cost:** $6-8/month

**Heavy Usage** (500+ queries/day):
- **Cost:** $8-12/month

### **What Counts as "Usage":**
- CPU time per request
- Memory usage
- Network bandwidth
- Build time (minimal, only on deployments)

### **Free Trial:**
- Railway offers $5 one-time credits to try
- Valid for 30 days
- Perfect for testing before committing

---

## 🔍 Monitoring & Logs

### **View Logs:**

1. In Railway dashboard, click your service
2. Go to **Deployments** tab
3. Click on the active deployment
4. View real-time logs

**Useful log entries:**
```
Torah MCP running at http://localhost:XXXX/mcp
SSE connection established
Tool called: search
Tool called: fetch
```

### **View Metrics:**

Railway provides:
- CPU usage
- Memory usage
- Network traffic
- Request count
- Error rates

**Built-in Dashboard:**
Visit your deployment at `/dashboard` to see:
- Total requests
- Average latency
- Tool usage counts
- Cache statistics
- Error counts

---

## 🐛 Troubleshooting

### **Issue: Build Fails - "tsx: command not found"**

**Cause:** tsx not in dependencies

**Solution:**
Already fixed! tsx has been moved to dependencies in package.json.

---

### **Issue: "Application failed to respond"**

**Cause:** Server not binding to Railway's PORT

**Solution:**
Already configured! The server reads `process.env.PORT` automatically.

---

### **Issue: MCP Tools Not Working**

**Possible Causes:**
1. Sefaria API is down (check status.sefaria.org)
2. Rate limiting from Sefaria
3. Network timeout

**Debug Steps:**
1. Check Railway logs for errors
2. Test `/healthz` endpoint
3. Try MCP endpoint directly: `/mcp/sse/`

---

### **Issue: High Costs**

**Causes:**
- Too many requests
- Memory leaks
- Infinite loops

**Solutions:**
1. Check request logs in Railway dashboard
2. Add `MCP_API_KEY` to require authentication
3. Implement rate limiting (already built-in: 60 req/min)
4. Monitor `/dashboard` for unusual activity

---

### **Issue: SSL/HTTPS Errors**

**Cause:** Railway domains already have SSL

**Solution:**
No action needed! All Railway domains automatically have valid SSL certificates.

---

## 🔄 Updating Your Deployment

### **Auto-Deploy on Git Push:**

Railway automatically redeploys when you push to GitHub:

```bash
git add .
git commit -m "Update MCP server"
git push origin main
```

Railway will:
1. Detect the push
2. Pull latest code
3. Rebuild
4. Deploy with zero downtime

### **Manual Redeploy:**

1. Go to Railway dashboard
2. Click **"Redeploy"**
3. Confirm

---

## 📊 Health Checks

Railway can monitor your app's health:

### **Configure Health Check:**

1. Railway dashboard → Service → Settings
2. Scroll to **Health Check**
3. Set:
   - **Path:** `/healthz`
   - **Port:** Same as PORT (Railway auto-detects)
   - **Interval:** 60 seconds

Railway will automatically restart your service if health checks fail.

---

## 🌍 Custom Domain (Optional)

Want to use your own domain instead of Railway's?

### **Steps:**

1. Buy a domain (e.g., torah-mcp.com)
2. In Railway: Settings → Networking → Custom Domain
3. Add your domain
4. Update your domain's DNS:
   - Type: `CNAME`
   - Name: `@` or `mcp`
   - Value: `YOUR-RAILWAY-DOMAIN.up.railway.app`

**Time to propagate:** 5 minutes - 24 hours

**New MCP Connector URL:**
```
https://torah-mcp.com/mcp/sse/
```

---

## 🔒 Security Best Practices

### **Public Deployment:**

If deploying publicly, consider:

1. **Add API Key Authentication:**
   ```bash
   MCP_API_KEY=your-secret-key-here
   ```
   Then users must provide this key to connect.

2. **Enable Rate Limiting:**
   Already built-in (60 requests/minute per IP)

3. **Obey Robots.txt:**
   ```bash
   ROBOTS_OBEY=true
   ```

4. **Monitor Logs:**
   Check for suspicious activity regularly

5. **Set Appropriate CORS:**
   Already configured for MCP protocol

---

## 📈 Scaling

### **Vertical Scaling (More Resources):**

Railway auto-scales based on usage. If you need guaranteed resources:

1. Upgrade to **Pro Plan** ($20/month + usage)
2. Get priority resources and support

### **Horizontal Scaling:**

For very high traffic, you could:
1. Deploy multiple instances
2. Use a load balancer
3. Add Redis for shared caching

*Note: For most users, single instance is sufficient.*

---

## ✅ Deployment Checklist

Before going live:

- [ ] Code changes committed to GitHub
- [ ] Railway account created
- [ ] Project deployed from GitHub
- [ ] Build completed successfully (check logs)
- [ ] Domain generated
- [ ] `/healthz` endpoint responds
- [ ] `/dashboard` loads correctly
- [ ] `/mcp/sse/` endpoint accessible
- [ ] Environment variables set (if needed)
- [ ] Claude/GPT connector updated with Railway URL
- [ ] Test MCP tools work (try a search query)
- [ ] Monitor logs for errors
- [ ] Set up health checks (optional)
- [ ] Configure alerts (optional)

---

## 🎯 Next Steps

After successful deployment:

1. **Share with users:**
   - Provide MCP connector URL
   - Share connection instructions
   - Offer support for setup

2. **Monitor usage:**
   - Check Railway dashboard daily
   - Watch for cost spikes
   - Monitor error rates

3. **Maintain:**
   - Update dependencies monthly
   - Monitor Sefaria API changes
   - Keep Railway platform updated

4. **Enhance:**
   - Add more MCP tools
   - Improve caching
   - Optimize performance

---

## 📞 Support

### **Railway Issues:**
- [Railway Documentation](https://docs.railway.com)
- [Railway Discord](https://discord.gg/railway)
- [Railway Status](https://status.railway.com)

### **Torah MCP Issues:**
- Check GitHub repository issues
- Review server logs in Railway
- Test locally with `npm start`

### **Sefaria API:**
- [Sefaria API Docs](https://www.sefaria.org/developers)
- [Sefaria Status](https://status.sefaria.org)

---

## 🎉 Success!

Once deployed, your Torah MCP is available 24/7 at:

```
https://YOUR-RAILWAY-DOMAIN.up.railway.app/mcp/sse/
```

Users worldwide can now connect to 300,000+ Jewish texts through their Claude or ChatGPT apps!

**May this tool bring Torah learning to every corner of the world.** 🌟
