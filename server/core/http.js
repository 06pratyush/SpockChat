/**
 * Outbound HTTP client.
 *
 * The old code passed `timeout` to `node-fetch` and hoped for the best; a hung
 * TCP connection could hold a request open indefinitely and there was no retry,
 * no size cap, and no way to tell "connection refused" from "wrong software
 * answered". This wrapper fixes all four:
 *
 *   - hard deadline via AbortController (works with the platform `fetch`)
 *   - bounded response reading, so a hostile/broken peer cannot stream us to OOM
 *   - JSON parsing that reports *what* came back instead of "Unexpected token <"
 *   - classification of low-level socket errors into actionable messages
 */

const { AppError, Codes, unavailable } = require('./errors');

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024; // 4 MB is far more than any peer/Ollama reply

class HttpError extends Error {
  constructor(message, { status = 0, code = 'HTTP_ERROR', body = null, url = null } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.body = body;
    this.url = url;
  }
}

/** Turn a raw socket/DNS failure into something a human can act on. */
function describeNetworkError(err, url) {
  const cause = err?.cause || err;
  const code = cause?.code || err?.code;

  if (err?.name === 'AbortError' || err?.name === 'TimeoutError' || code === 'ABORT_ERR') {
    return {
      code: 'TIMEOUT',
      message: `No response from ${url} within the timeout.`,
      hint: 'The host is reachable but not answering. It may be overloaded, or a firewall may be dropping packets silently.',
    };
  }
  switch (code) {
    case 'ECONNREFUSED':
      return {
        code: 'CONNECTION_REFUSED',
        message: `${url} refused the connection.`,
        hint: 'Nothing is listening on that port. Check the address and that the service is actually running.',
      };
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return {
        code: 'DNS_FAILED',
        message: `Could not resolve the address ${url}.`,
        hint: 'Check the hostname for typos, and check that this machine has working DNS/internet.',
      };
    case 'ECONNRESET':
    case 'EPIPE':
      return {
        code: 'CONNECTION_RESET',
        message: `The connection to ${url} was reset mid-request.`,
        hint: 'This usually means packet loss or a flaky link. It is safe to retry.',
      };
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return {
        code: 'HOST_UNREACHABLE',
        message: `No network route to ${url}.`,
        hint: 'You are probably on a different network than that address, or a VPN is intercepting the route.',
      };
    case 'ETIMEDOUT':
      return {
        code: 'TIMEOUT',
        message: `Connecting to ${url} timed out.`,
        hint: 'The address is likely blocked by a firewall, or the machine is offline.',
      };
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return {
        code: 'TLS_FAILED',
        message: `The TLS certificate for ${url} could not be verified.`,
        hint: 'If this is a tunnel URL, ask your friend to restart the tunnel and share the new link.',
      };
    default:
      return {
        code: 'NETWORK_ERROR',
        message: `Request to ${url} failed${code ? ` (${code})` : ''}: ${cause?.message || err?.message || 'unknown error'}`,
        hint: 'Check that the address is correct and both machines are online.',
      };
  }
}

/**
 * Fetch with a hard deadline. Never throws a raw undici error at callers.
 *
 * @returns {Promise<{ok:boolean,status:number,headers:Headers,text:string,json:any|null,contentType:string}>}
 */
async function request(url, { method = 'GET', headers = {}, body = null, timeoutMs = 10_000, signal = null, maxBytes = MAX_RESPONSE_BYTES } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
  const onOuterAbort = () => controller.abort(signal.reason);
  if (signal) {
    if (signal.aborted) { clearTimeout(timer); throw signal.reason || new Error('Aborted'); }
    signal.addEventListener('abort', onOuterAbort, { once: true });
  }

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: body && !headers['Content-Type'] ? { 'Content-Type': 'application/json', ...headers } : headers,
      body,
      signal: controller.signal,
      redirect: 'follow',
    });
  } catch (err) {
    const described = describeNetworkError(err, url);
    throw new HttpError(described.message, { code: described.code, url, body: described.hint });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
  }

  // Read the body with a byte cap so a broken peer cannot exhaust memory.
  let text = '';
  try {
    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > maxBytes) {
          reader.cancel().catch(() => {});
          throw new HttpError(`Response from ${url} exceeded ${maxBytes} bytes and was discarded.`, {
            code: 'RESPONSE_TOO_LARGE', url, status: response.status,
          });
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    const described = describeNetworkError(err, url);
    throw new HttpError(described.message, { code: described.code, url, body: described.hint });
  }

  const contentType = response.headers.get('content-type') || '';
  let json = null;
  if (text && contentType.includes('json')) {
    try { json = JSON.parse(text); } catch { json = null; }
  } else if (text) {
    // Tolerate servers that send JSON without the right content-type.
    try { json = JSON.parse(text); } catch { json = null; }
  }

  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    text,
    json,
    contentType,
  };
}

/**
 * Fetch expecting JSON. Distinguishes "peer is down" from "something answered
 * but it is not SpockChat" — the exact confusion that made the old friend-add
 * failures impossible to diagnose.
 */
async function requestJson(url, options = {}) {
  const res = await request(url, options);

  if (res.json === null) {
    const looksLikeHtml = /^\s*<(?:!doctype|html)/i.test(res.text);
    throw new HttpError(
      looksLikeHtml
        ? `${url} returned a web page instead of data.`
        : `${url} returned a response that is not valid JSON.`,
      {
        code: looksLikeHtml ? 'NOT_SPOCKCHAT' : 'BAD_JSON',
        status: res.status,
        url,
        body: looksLikeHtml
          ? 'That address is reachable but is not a SpockChat API endpoint. Check the URL — a tunnel or proxy login page will do this.'
          : 'The other side answered with something unexpected. It may be running a different version of SpockChat.',
      }
    );
  }

  return res;
}

/** Convert an HttpError into a user-facing AppError with a hint attached. */
function toAppError(err, { code = Codes.PEER_UNREACHABLE, prefix = '' } = {}) {
  if (err instanceof AppError) return err;
  if (err instanceof HttpError) {
    return unavailable(prefix ? `${prefix} ${err.message}` : err.message, {
      code: err.code === 'NOT_SPOCKCHAT' ? Codes.PEER_NOT_SPOCKCHAT : code,
      hint: err.body || undefined,
      cause: err,
    });
  }
  return unavailable(prefix ? `${prefix} ${err.message}` : err.message, { code, cause: err });
}

module.exports = { request, requestJson, HttpError, describeNetworkError, toAppError, MAX_RESPONSE_BYTES };
