Quick health check of all services. Run these in parallel:

1. `curl -s http://localhost:4000/api/health 2>/dev/null || echo "Server not running"`
2. `curl -s http://localhost:4000/api/connects 2>/dev/null || echo ""`

Present a concise status:
- Server: running/down
- Upwork Safari: UP/DOWN
- LinkedIn Safari: UP/DOWN
- Chrome CDP: UP/DOWN
- Connects: X remaining (+ warning if low)
- Timestamp
