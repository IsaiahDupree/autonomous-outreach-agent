import express from "express";
import cors from "cors";
import helmet from "helmet";
import path from "path";
import fs from "fs";
import apiRouter from "./routes/api";
import trackingRouter from "./routes/tracking";

const app = express();
// helmet's default contentSecurityPolicy blocks the inline scripts Vite ships, which kills the
// dashboard. Disable CSP — we're an internal-only tool, and we lose nothing meaningful.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(trackingRouter);
app.use("/api", apiRouter);

// Serve the built dashboard SPA. The dashboard project lives at <repo>/dashboard and writes its
// production bundle to dashboard/dist. We resolve relative to this file so it works both for
// `ts-node src/index.ts` (file lives in src/) and for compiled JS (file lives in build/).
const candidates = [
  path.resolve(__dirname, "../dashboard/dist"),
  path.resolve(__dirname, "../../dashboard/dist"),
];
const dashboardDir = candidates.find(p => fs.existsSync(path.join(p, "index.html")));
if (dashboardDir) {
  app.use(express.static(dashboardDir));
  // SPA fallback: any GET that isn't /api or /r and isn't a file should hand back index.html so
  // react-router-dom can take over. Express 4 quirk: don't use "*" with the path-to-regexp parser.
  app.get(/^(?!\/api\/|\/r\/).+/, (req, res, next) => {
    if (req.method !== "GET") return next();
    const indexHtml = path.join(dashboardDir, "index.html");
    res.sendFile(indexHtml, err => { if (err) next(err); });
  });
}

export default app;
