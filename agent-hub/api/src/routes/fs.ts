/**
 * Filesystem browse routes for the Hub dashboard.
 *
 * GET /api/fs/browse?path=  — list subdirectories on the Hub host
 */

import { Router, type Request, type Response } from 'express';
import {
  browseDirectory,
  type FsBrowseEntry,
  type FsBrowseResult,
} from '@shepaw/agent-hub-core';

export type { FsBrowseEntry, FsBrowseResult };
export { browseDirectory, resolveBrowsePath } from '@shepaw/agent-hub-core';

export const fsRouter = Router();

fsRouter.get('/browse', async (req: Request, res: Response) => {
  try {
    const raw = typeof req.query.path === 'string' ? req.query.path : undefined;
    const result = await browseDirectory(raw);
    res.json(result);
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    const message = err instanceof Error ? err.message : String(err);
    if (status >= 400 && status < 500) {
      res.status(status).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
});
