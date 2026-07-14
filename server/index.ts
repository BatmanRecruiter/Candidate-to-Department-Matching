import "dotenv/config";
import express, { Response, NextFunction } from 'express';
import type { Request } from 'express';
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "node:http";

const app = express();
const httpServer = createServer(app);

app.set("trust proxy", 1);
// The production CSP is intentionally strict. In development it is disabled so
// Vite's inline react-refresh preamble, the HMR websocket, and the Google Fonts
// stylesheet can load (script-src 'self' otherwise blanks the dev page). This
// is a LOCAL-TESTING unblock only — production (NODE_ENV=production, per the
// start script) keeps the exact directives below, unchanged.
const isProduction = process.env.NODE_ENV === "production";
app.use(
  helmet({
    contentSecurityPolicy: isProduction
      ? {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            fontSrc: ["'self'", "data:"],
            imgSrc: ["'self'", "data:"],
            connectSrc: ["'self'"],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            frameAncestors: ["'self'"],
          },
        }
      : false,
  }),
);
app.use(
  ["/api/saved-files", "/api/calibrations"],
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => !isProduction,
  }),
);
// Role sync hits an external Greenhouse endpoint; cap calls more tightly.
app.use(
  ["/api/role-sync", "/api/role-sync/automated"],
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => !isProduction,
  }),
);
// LLM match endpoint — each call hits the Anthropic API. 600/15 min = 40/min.
app.use(
  "/api/match",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 600,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => !isProduction,
  }),
);
// Batch submit/status — low limit since each submission can be thousands of rows.
app.use(
  "/api/match/batch",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => !isProduction,
  }),
);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    // The batch-submit POST now carries BOTH the filtered rows-JSON (<=1100
    // rows) AND the raw csvText (bounded to 5,000,000 chars server-side) so the
    // batch_jobs row can rebuild exports without localStorage. Worst-case single
    // file ~= 15 MB rows + 5 MB csvText + overhead ~= 20 MB; 40 MB gives ~2x
    // headroom so a mid-drop file can never 413. Submits are per-file, so this
    // limit is NOT multiplied by the number of files in a drop.
    limit: "40mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false, limit: "25mb" }));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (
        capturedJsonResponse &&
        !path.startsWith("/api/saved-files") &&
        !path.startsWith("/api/calibrations")
      ) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
    },
  );
})();
