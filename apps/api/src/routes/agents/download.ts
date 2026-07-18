import { Hono } from 'hono';
import { statSync, createReadStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { VALID_OS, VALID_ARCH } from './schemas';
import { isS3Configured, getPresignedUrl, isS3NotFound } from '../../services/s3Storage';
import { getBinarySource, getGithubAgentUrl, getGithubHelperUrl, getGithubUserHelperUrl, getGithubWatchdogUrl, HELPER_FILENAMES } from '../../services/binarySource';

export const downloadRoutes = new Hono();

// ============================================
// Agent Binary Download (public, no auth)
// ============================================

downloadRoutes.get('/download/:os/:arch', async (c) => {
  const os = c.req.param('os');
  const arch = c.req.param('arch');

  if (!VALID_OS.has(os)) {
    return c.json(
      {
        error: 'Invalid OS',
        message: `Supported values: linux, darwin, windows. Got: ${os}`,
      },
      400
    );
  }

  if (!VALID_ARCH.has(arch)) {
    return c.json(
      {
        error: 'Invalid architecture',
        message: `Supported values: amd64, arm64. Got: ${arch}`,
      },
      400
    );
  }

  const extension = os === 'windows' ? '.exe' : '';
  const filename = `bl4ck-agent-${os}-${arch}${extension}`;

  // GitHub redirect mode — no local binaries needed
  if (getBinarySource() === 'github') {
    return c.redirect(getGithubAgentUrl(os, arch), 302);
  }

  // Local mode: try S3 presigned redirect first (bandwidth offload)
  if (isS3Configured()) {
    try {
      const s3Key = `agent/${filename}`;
      const url = await getPresignedUrl(s3Key);
      return c.redirect(url, 302);
    } catch (err) {
      if (!isS3NotFound(err)) {
        // Real S3 transport/auth fault — surface it instead of masking it as a
        // disk-fallback 404. The binary may well exist in S3; we just couldn't reach it.
        console.error(`[agent-download] S3 presign failed for ${filename}:`, err);
        return c.json({ error: 'Internal server error', message: 'Failed to retrieve binary file' }, 500);
      }
      console.warn(`[agent-download] S3 object missing for ${filename}, falling back to disk:`, err);
    }
  }

  // Local mode: serve from disk
  const binaryDir = resolve(process.env.AGENT_BINARY_DIR || './agent/bin');
  const filePath = join(binaryDir, filename);

  let fileStat: ReturnType<typeof statSync>;
  let stream: ReturnType<typeof createReadStream>;
  try {
    fileStat = statSync(filePath);
    stream = createReadStream(filePath);
  } catch (err) {
    const isNotFound = err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
    if (!isNotFound) {
      console.error(`[agent-download] Failed to read binary ${filename}:`, err);
      return c.json({ error: 'Internal server error', message: 'Failed to read binary file' }, 500);
    }
    console.warn('[agent-download] Local binary missing', { filename });
    return c.json(
      {
        error: 'Binary not found',
        message: `Agent binary "${filename}" is not available.`,
      },
      404
    );
  }

  const webStream = new ReadableStream({
    start(controller) {
      stream.on('data', (chunk: string | Buffer) => {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        controller.enqueue(new Uint8Array(bytes));
      });
      stream.on('end', () => {
        controller.close();
      });
      stream.on('error', (err) => {
        console.error(`[agent-download] Stream error while serving ${filename}:`, err);
        controller.error(err);
      });
    },
    cancel() {
      stream.destroy();
    },
  });

  return new Response(webStream, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(fileStat.size),
      'Cache-Control': 'no-cache',
    },
  });
});

// ============================================
// Helper Binary Download (public, no auth)
// ============================================

downloadRoutes.get('/download/helper/:os/:arch', async (c) => {
  const os = c.req.param('os');
  const arch = c.req.param('arch');

  if (!VALID_OS.has(os)) {
    return c.json({ error: 'Invalid OS', message: `Supported values: linux, darwin, windows. Got: ${os}` }, 400);
  }

  if (!VALID_ARCH.has(arch)) {
    return c.json({ error: 'Invalid architecture', message: `Supported values: amd64, arm64. Got: ${arch}` }, 400);
  }

  const filename = HELPER_FILENAMES[os];
  if (!filename) {
    return c.json({ error: 'Invalid OS', message: `No helper binary available for OS: ${os}` }, 400);
  }

  if (getBinarySource() === 'github') {
    return c.redirect(getGithubHelperUrl(os), 302);
  }

  if (isS3Configured()) {
    try {
      const s3Key = `helper/${filename}`;
      const url = await getPresignedUrl(s3Key);
      return c.redirect(url, 302);
    } catch (err) {
      if (!isS3NotFound(err)) {
        console.error(`[helper-download] S3 presign failed for ${filename}:`, err);
        return c.json({ error: 'Internal server error', message: 'Failed to retrieve binary file' }, 500);
      }
      console.warn(`[helper-download] S3 object missing for ${filename}, falling back to disk:`, err);
    }
  }

  const binaryDir = resolve(process.env.HELPER_BINARY_DIR || './agent/bin');
  const filePath = join(binaryDir, filename);

  let fileStat: ReturnType<typeof statSync>;
  let stream: ReturnType<typeof createReadStream>;
  try {
    fileStat = statSync(filePath);
    stream = createReadStream(filePath);
  } catch (err) {
    const isNotFound = err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
    if (!isNotFound) {
      console.error(`[helper-download] Failed to read binary ${filename}:`, err);
      return c.json({ error: 'Internal server error', message: 'Failed to read binary file' }, 500);
    }
    console.warn('[helper-download] Local binary missing', { filename });
    return c.json({
      error: 'Binary not found',
      message: `Helper binary "${filename}" is not available.`,
    }, 404);
  }

  const webStream = new ReadableStream({
    start(controller) {
      stream.on('data', (chunk: string | Buffer) => {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        controller.enqueue(new Uint8Array(bytes));
      });
      stream.on('end', () => { controller.close(); });
      stream.on('error', (err) => {
        console.error(`[helper-download] Stream error while serving ${filename}:`, err);
        controller.error(err);
      });
    },
    cancel() { stream.destroy(); },
  });

  return new Response(webStream, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(fileStat.size),
      'Cache-Control': 'no-cache',
    },
  });
});

// ============================================
// Watchdog Binary Download (public, no auth)
// ============================================
// Per-arch like the agent (bl4ck-watchdog-{os}-{arch}[.exe]). The agent's
// reconcileWatchdog and the watchdog's own failover self-update fetch this via
// /agent-versions/:version/download?component=watchdog, which hands back this
// same-origin URL so the downloader's host-match guard passes (see
// buildServerRelativeAgentDownloadUrl + issue #646).
downloadRoutes.get('/download/watchdog/:os/:arch', async (c) => {
  const os = c.req.param('os');
  const arch = c.req.param('arch');

  if (!VALID_OS.has(os)) {
    return c.json({ error: 'Invalid OS', message: `Supported values: linux, darwin, windows. Got: ${os}` }, 400);
  }

  if (!VALID_ARCH.has(arch)) {
    return c.json({ error: 'Invalid architecture', message: `Supported values: amd64, arm64. Got: ${arch}` }, 400);
  }

  const extension = os === 'windows' ? '.exe' : '';
  const filename = `bl4ck-watchdog-${os}-${arch}${extension}`;

  if (getBinarySource() === 'github') {
    return c.redirect(getGithubWatchdogUrl(os, arch), 302);
  }

  if (isS3Configured()) {
    try {
      const s3Key = `watchdog/${filename}`;
      const url = await getPresignedUrl(s3Key);
      return c.redirect(url, 302);
    } catch (err) {
      if (!isS3NotFound(err)) {
        console.error(`[watchdog-download] S3 presign failed for ${filename}:`, err);
        return c.json({ error: 'Internal server error', message: 'Failed to retrieve binary file' }, 500);
      }
      console.warn(`[watchdog-download] S3 object missing for ${filename}, falling back to disk:`, err);
    }
  }

  const binaryDir = resolve(process.env.AGENT_BINARY_DIR || './agent/bin');
  const filePath = join(binaryDir, filename);

  let fileStat: ReturnType<typeof statSync>;
  let stream: ReturnType<typeof createReadStream>;
  try {
    fileStat = statSync(filePath);
    stream = createReadStream(filePath);
  } catch (err) {
    const isNotFound = err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
    if (!isNotFound) {
      console.error(`[watchdog-download] Failed to read binary ${filename}:`, err);
      return c.json({ error: 'Internal server error', message: 'Failed to read binary file' }, 500);
    }
    console.warn('[watchdog-download] Local binary missing', { filename });
    return c.json({
      error: 'Binary not found',
      message: `Watchdog binary "${filename}" is not available.`,
    }, 404);
  }

  const webStream = new ReadableStream({
    start(controller) {
      stream.on('data', (chunk: string | Buffer) => {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        controller.enqueue(new Uint8Array(bytes));
      });
      stream.on('end', () => { controller.close(); });
      stream.on('error', (err) => {
        console.error(`[watchdog-download] Stream error while serving ${filename}:`, err);
        controller.error(err);
      });
    },
    cancel() { stream.destroy(); },
  });

  return new Response(webStream, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(fileStat.size),
      'Cache-Control': 'no-cache',
    },
  });
});

// bl4ck-user-helper: the GUI-subsystem sibling of bl4ck-agent (Windows in
// practice; route stays OS-general like the watchdog route it mirrors),
// spawned by the agent's sessionbroker into the interactive user session. It is
// a distinct binary from the Tauri "helper" app (/download/helper) and is
// fetched by the agent's verified updater (component=user-helper). Without this
// server-relative route the agent-versions response handed back the canonical
// github.com asset URL, which the updater's host-equality check rejects (#1878).
// Mirrors the watchdog route: github redirect / S3 presign / local disk.
downloadRoutes.get('/download/user-helper/:os/:arch', async (c) => {
  const os = c.req.param('os');
  const arch = c.req.param('arch');

  if (!VALID_OS.has(os)) {
    return c.json({ error: 'Invalid OS', message: `Supported values: linux, darwin, windows. Got: ${os}` }, 400);
  }

  if (!VALID_ARCH.has(arch)) {
    return c.json({ error: 'Invalid architecture', message: `Supported values: amd64, arm64. Got: ${arch}` }, 400);
  }

  const extension = os === 'windows' ? '.exe' : '';
  const filename = `bl4ck-user-helper-${os}-${arch}${extension}`;

  if (getBinarySource() === 'github') {
    return c.redirect(getGithubUserHelperUrl(os, arch), 302);
  }

  if (isS3Configured()) {
    try {
      const s3Key = `user-helper/${filename}`;
      const url = await getPresignedUrl(s3Key);
      return c.redirect(url, 302);
    } catch (err) {
      if (!isS3NotFound(err)) {
        console.error(`[user-helper-download] S3 presign failed for ${filename}:`, err);
        return c.json({ error: 'Internal server error', message: 'Failed to retrieve binary file' }, 500);
      }
      console.warn(`[user-helper-download] S3 object missing for ${filename}, falling back to disk:`, err);
    }
  }

  const binaryDir = resolve(process.env.AGENT_BINARY_DIR || './agent/bin');
  const filePath = join(binaryDir, filename);

  let fileStat: ReturnType<typeof statSync>;
  let stream: ReturnType<typeof createReadStream>;
  try {
    fileStat = statSync(filePath);
    stream = createReadStream(filePath);
  } catch (err) {
    const isNotFound = err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
    if (!isNotFound) {
      console.error(`[user-helper-download] Failed to read binary ${filename}:`, err);
      return c.json({ error: 'Internal server error', message: 'Failed to read binary file' }, 500);
    }
    console.warn('[user-helper-download] Local binary missing', { filename });
    return c.json({
      error: 'Binary not found',
      message: `User-helper binary "${filename}" is not available.`,
    }, 404);
  }

  const webStream = new ReadableStream({
    start(controller) {
      stream.on('data', (chunk: string | Buffer) => {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        controller.enqueue(new Uint8Array(bytes));
      });
      stream.on('end', () => { controller.close(); });
      stream.on('error', (err) => {
        console.error(`[user-helper-download] Stream error while serving ${filename}:`, err);
        controller.error(err);
      });
    },
    cancel() { stream.destroy(); },
  });

  return new Response(webStream, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(fileStat.size),
      'Cache-Control': 'no-cache',
    },
  });
});
