/* Thin fetch wrapper. Every call funnels through here so error shape and
   JSON handling stay consistent across pages. */

/** Error carrying the server's machine-readable code plus its human copy. */
export class ApiError extends Error {
  constructor({ code, message, detail, hint, status }) {
    super(message || 'Request failed');
    this.name = 'ApiError';
    this.code = code || 'unknown';
    this.detail = detail || '';
    this.hint = hint || '';
    this.status = status || 0;
  }
}

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
  } catch (cause) {
    // Transport-level failure: the server process is down or unreachable.
    throw new ApiError({
      code: 'network',
      message: 'Cannot reach the DSMT server',
      detail: String(cause && cause.message ? cause.message : cause),
      hint: 'Check that the DSMT service is running.',
    });
  }

  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const payload = isJson ? await res.json().catch(() => null) : null;

  if (!res.ok) {
    const err = (payload && payload.error) || {};
    throw new ApiError({
      code: err.code,
      message: err.message || `Request failed (${res.status})`,
      detail: err.detail,
      hint: err.hint,
      status: res.status,
    });
  }
  return payload;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body ?? {}),
};
