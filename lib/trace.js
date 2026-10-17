'use strict';
// Two-way request tracing for the proxy.
//
// OFF by default: a proxy that logs full prompts to disk is a privacy hazard,
// so nothing is written unless DEEPSEEK_TRACE is set to 1/true/yes/on.
//
// Enabled, every exchange is logged in BOTH directions:
//   client -> proxy   the inbound HTTP request (path, headers without secrets, body)
//   proxy  -> client  the response, or the SSE stream as it is written
//   proxy  -> DeepSeek the upstream request (URL, model_type, prompt)
//   DeepSeek -> proxy the upstream SSE stream, one summary line per event
//
// Console output is human-readable behind a [TRACE] prefix; when DEEPSEEK_TRACE_FILE
// is set (e.g. logs/trace.jsonl) the same records are appended as JSONL.
// Bodies are truncated to DEEPSEEK_TRACE_MAX_BYTES (default 8192) per block, with
// the original size recorded so a clipped prompt is obvious in the log.

const fs = require('fs');
const path = require('path');

const SECRET_HEADERS = new Set([
    'authorization', 'x-api-key', 'cookie', 'set-cookie',
    'x-ds-pow-response', 'x-ds-client-version', 'proxy-authorization',
]);
const MAX_BYTES = (() => {
    const n = Number(process.env.DEEPSEEK_TRACE_MAX_BYTES);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 8192;
})();
const TRACE_FILE = process.env.DEEPSEEK_TRACE_FILE || '';
const TRACE_DIR = TRACE_FILE ? path.dirname(path.resolve(TRACE_FILE)) : '';

function enabled(env = process.env) {
    return ['1', 'true', 'yes', 'on'].includes(String(env.DEEPSEEK_TRACE || '').trim().toLowerCase());
}

// One writer instance per process: keeps the fd open instead of reopening the
// file on every event, and never lets a logging failure break a request.
function createTracer({ enabled: on = enabled(), file = TRACE_FILE, maxBytes = MAX_BYTES } = {}) {
    let fd = null;
    if (on && file) {
        try {
            fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
            fd = fs.openSync(file, 'a');
        } catch (e) {
            console.error(`[TRACE] cannot open ${file}: ${e.message}; file logging disabled`);
        }
    }

    function redactHeaders(headers = {}) {
        const out = {};
        for (const [key, value] of Object.entries(headers)) {
            out[key] = SECRET_HEADERS.has(key.toLowerCase()) ? '<redacted>' : value;
        }
        return out;
    }

    // Truncation is by UTF-8 bytes but must not cut a multi-byte character in
    // half, so the slice is taken on a Buffer and decoded with a replacement.
    function clip(value) {
        if (value === undefined || value === null) return { text: '', originalBytes: 0, truncated: false };
        const text = typeof value === 'string' ? value : safeStringify(value);
        const bytes = Buffer.byteLength(text, 'utf8');
        if (bytes <= maxBytes) return { text, originalBytes: bytes, truncated: false };
        const head = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
        return { text: `${head}\n...[truncated ${bytes - maxBytes} of ${bytes} bytes]`, originalBytes: bytes, truncated: true };
    }

    function safeStringify(value) {
        try { return JSON.stringify(value); } catch (e) { return String(value); }
    }

    function write(record) {
        if (!on) return;
        const entry = { ts: new Date().toISOString(), ...record };
        try {
            if (fd !== null) fs.writeSync(fd, safeStringify(entry) + '\n');
        } catch (e) {
            console.error(`[TRACE] write failed: ${e.message}`);
        }
        const dir = record.direction || '?';
        const who = record.peer || '';
        const what = record.event || '';
        const detail = record.summary !== undefined ? record.summary : (record.body ? clip(record.body).text : '');
        console.log(`[TRACE] ${dir}${who ? ` ${who}` : ''} ${what}${detail ? `: ${String(detail).slice(0, 400)}` : ''}`);
    }

    // Inbound HTTP request from the client (Claude Code, Open WebUI, curl...).
    function inboundHttp({ method, url, headers, remote, agent, apiMode }) {
        write({ direction: 'client->proxy', peer: remote, event: 'request', method, url, agent, apiMode, headers: redactHeaders(headers) });
    }

    function inboundBody(body) {
        const { text, originalBytes, truncated } = clip(body);
        write({ direction: 'client->proxy', event: 'body', originalBytes, truncated, body: text });
    }

    // Proxy response to the client. `body` is the full payload for JSON, or a
    // description of the stream for SSE (the deltas are logged by sseOut).
    function outboundHttp({ status, headers, body, stream }) {
        const { text, originalBytes, truncated } = clip(body);
        write({ direction: 'proxy->client', event: stream ? 'response-stream' : 'response', status, originalBytes, truncated, body: text });
    }

    function sseOut(event, data) {
        const { text, originalBytes, truncated } = clip(data);
        write({ direction: 'proxy->client', event: 'sse', sseEvent: event || null, originalBytes, truncated, body: text });
    }

    // Upstream request to DeepSeek: URL and the parsed payload (prompt included).
    function upstreamRequest({ url, method = 'POST', payload }) {
        const { text, originalBytes, truncated } = clip(payload);
        write({ direction: 'proxy->deepseek', event: 'request', method, url, originalBytes, truncated, body: text });
    }

    // One parsed SSE event from DeepSeek. Full frames would flood the log, so
    // the path and the value are what gets recorded; callers summarize.
    function upstreamEvent(event) {
        const { text, originalBytes, truncated } = clip(event.data !== undefined ? event.data : event);
        write({ direction: 'deepseek->proxy', event: event.kind || 'sse', originalBytes, truncated, body: text });
    }

    function upstreamResponse({ status, headers, body }) {
        const { text, originalBytes, truncated } = clip(body);
        write({ direction: 'deepseek->proxy', event: 'response', status, originalBytes, truncated, body: text });
    }

    function close() {
        if (fd !== null) { try { fs.closeSync(fd); } catch (e) {} fd = null; }
    }

    return {
        enabled: on, inboundHttp, inboundBody, outboundHttp, sseOut,
        upstreamRequest, upstreamEvent, upstreamResponse, redactHeaders, clip, close,
    };
}

module.exports = { createTracer, enabled, MAX_BYTES, TRACE_FILE };
