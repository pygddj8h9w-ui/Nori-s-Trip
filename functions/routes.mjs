// Shared trip planning API. Business rules live here; the browser only ever
// calls same-origin /functions/v1/app/api/... routes.

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CATEGORIES = ['sight', 'food', 'stay', 'move', 'shop', 'other'];

const LIMITS = { name: 40, title: 60, address: 200, note: 800, cost: 12, author: 16, text: 500 };

function newCode() {
  let code = '';
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return code;
}

export function application({ db, BackendError }) {
  const fail = (code, status) => { throw new BackendError(code, status); };
  const rows = result => {
    if (result && result.error) fail(result.error.code || 'database_error', result.error.status || 500);
    return result ? result.data : null;
  };
  const now = () => new Date().toISOString();

  function str(value, max, field) {
    if (typeof value !== 'string') fail('invalid_input', 400);
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > max) fail('invalid_input', 400);
    return trimmed;
  }
  function maybeStr(value, max) {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value !== 'string') fail('invalid_input', 400);
    const trimmed = value.trim();
    if (trimmed.length > max) fail('invalid_input', 400);
    return trimmed;
  }
  function coord(value, min, max) {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n) || n < min || n > max) fail('invalid_input', 400);
    return n;
  }
  const uuid = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
  const codeKey = v => typeof v === 'string' && /^[A-Z0-9]{6,12}$/.test(v);

  async function input(request) {
    if (!request.headers.get('content-type')?.startsWith('application/json')) fail('invalid_input', 400);
    const reader = request.body?.getReader();
    if (!reader) fail('invalid_input', 400);
    let size = 0;
    const chunks = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 8192) { await reader.cancel(); fail('payload_too_large', 413); }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { fail('invalid_input', 400); }
  }

  async function readTrip(code) {
    if (!codeKey(code)) fail('invalid_input', 400);
    const found = rows(await db.from('trips').select('code,name,days,created_at,updated_at').eq('code', code).limit(1));
    if (!found?.length) fail('trip_not_found', 404);
    return found[0];
  }

  function pointFields(body) {
    return {
      title: str(body.title, LIMITS.title),
      address: maybeStr(body.address, LIMITS.address),
      category: CATEGORIES.includes(body.category) ? body.category : 'other',
      day: Number.isInteger(body.day) && body.day >= 0 && body.day <= 30 ? body.day : 0,
      note: maybeStr(body.note, LIMITS.note),
      cost: maybeStr(body.cost, LIMITS.cost)
    };
  }

  return async ctx => {
    const request = ctx.request;
    const pathname = new URL(request.url).pathname;
    const matched = pathname.match(/^(?:\/functions\/v1)?(?:\/app(?:-d[0-9a-f]{32})?)?(\/api\/[a-z0-9\/_-]*)$/i);
    if (!matched) fail('not_found', 404);
    const path = matched[1];
    const method = request.method;

    if (path === '/api/health' && method === 'GET') return Response.json({ ok: true });

    if (path === '/api/trip' && method === 'POST') {
      const body = await input(request);
      const row = {
        code: newCode(),
        name: str(body.name, LIMITS.name),
        days: Number.isInteger(body.days) && body.days >= 1 && body.days <= 30 ? body.days : 3,
        author: maybeStr(body.author, LIMITS.author),
        created_at: now(),
        updated_at: now()
      };
      rows(await db.from('trips').insert(row));
      return Response.json({ code: row.code, name: row.name, days: row.days }, { status: 201 });
    }

    if (path === '/api/trip' && method === 'GET') {
      const code = new URL(request.url).searchParams.get('code');
      const trip = await readTrip(code);
      const points = rows(await db.from('points')
        .select('id,trip_code,title,address,lat,lng,category,day,note,cost,author,created_at,updated_at')
        .eq('trip_code', trip.code).order('created_at', { ascending: true }).limit(500)) || [];
      const comments = rows(await db.from('comments')
        .select('id,trip_code,point_id,author,text,created_at')
        .eq('trip_code', trip.code).order('created_at', { ascending: true }).limit(1000)) || [];
      return Response.json({ trip, points, comments });
    }

    const tripEdit = path.match(/^\/api\/trip\/([A-Z0-9]{6,12})$/);
    if (tripEdit && method === 'PATCH') {
      const trip = await readTrip(tripEdit[1]);
      const body = await input(request);
      const patch = {
        name: str(body.name, LIMITS.name),
        days: Number.isInteger(body.days) && body.days >= 1 && body.days <= 30 ? body.days : trip.days,
        updated_at: now()
      };
      const updated = rows(await db.from('trips').update(patch).eq('code', trip.code).select('code,name,days,created_at,updated_at'));
      return Response.json(updated?.[0] || { ...trip, ...patch });
    }

    if (path === '/api/point' && method === 'POST') {
      const body = await input(request);
      const trip = await readTrip(body.trip_code);
      const row = {
        id: crypto.randomUUID(),
        trip_code: trip.code,
        lat: coord(body.lat, -90, 90),
        lng: coord(body.lng, -180, 180),
        author: maybeStr(body.author, LIMITS.author),
        created_at: now(),
        updated_at: now(),
        ...pointFields(body)
      };
      rows(await db.from('points').insert(row));
      return Response.json({ id: row.id }, { status: 201 });
    }

    const pointEdit = path.match(/^\/api\/point\/([0-9a-f-]{36})$/i);
    if (pointEdit && uuid(pointEdit[1])) {
      const body = await input(request);
      const trip = await readTrip(body.trip_code);
      const existing = rows(await db.from('points').select('id,trip_code').eq('id', pointEdit[1]).eq('trip_code', trip.code).limit(1));
      if (!existing?.length) fail('not_found', 404);

      if (method === 'DELETE') {
        rows(await db.from('points').delete().eq('id', pointEdit[1]).eq('trip_code', trip.code));
        return Response.json({ ok: true });
      }
      if (method === 'PATCH') {
        const patch = { ...pointFields(body), updated_at: now() };
        if (body.lat !== undefined) patch.lat = coord(body.lat, -90, 90);
        if (body.lng !== undefined) patch.lng = coord(body.lng, -180, 180);
        rows(await db.from('points').update(patch).eq('id', pointEdit[1]).eq('trip_code', trip.code));
        return Response.json({ ok: true, id: pointEdit[1] });
      }
      fail('not_found', 404);
    }

    if (path === '/api/comment' && method === 'POST') {
      const body = await input(request);
      const trip = await readTrip(body.trip_code);
      let pointId = null;
      if (body.point_id !== null && body.point_id !== undefined && body.point_id !== '') {
        if (!uuid(body.point_id)) fail('invalid_input', 400);
        const found = rows(await db.from('points').select('id').eq('id', body.point_id).eq('trip_code', trip.code).limit(1));
        if (!found?.length) fail('not_found', 404);
        pointId = body.point_id;
      }
      const row = {
        id: crypto.randomUUID(),
        trip_code: trip.code,
        point_id: pointId,
        author: str(body.author, LIMITS.author),
        text: str(body.text, LIMITS.text),
        created_at: now()
      };
      rows(await db.from('comments').insert(row));
      return Response.json({ id: row.id }, { status: 201 });
    }

    const commentDelete = path.match(/^\/api\/comment\/([0-9a-f-]{36})$/i);
    if (commentDelete && uuid(commentDelete[1]) && method === 'DELETE') {
      const body = await input(request);
      const found = rows(await db.from('comments').select('id,author,trip_code').eq('id', commentDelete[1]).limit(1));
      if (!found?.length) fail('not_found', 404);
      // Nicknames are not credentials, so this only stops honest mistakes:
      // the row that says it is yours is the row you may remove.
      if (found[0].author !== maybeStr(body.author, LIMITS.author)) fail('forbidden', 403);
      rows(await db.from('comments').delete().eq('id', commentDelete[1]));
      return Response.json({ ok: true });
    }

    fail('not_found', 404);
  };
}
