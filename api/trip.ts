// Vercel serverless function - Trip API
import { application } from '../functions/routes.mjs';

// Simple in-memory database for demo (replace with Supabase/PostgreSQL)
const db = {
  trips: new Map(),
  points: new Map(),
  comments: new Map(),

  from(table) {
    const store = this[table];
    return {
      select(fields) {
        return {
          async eq(key, value) {
            const results = [];
            for (const item of store.values()) {
              if (item[key] === value) results.push(item);
            }
            return { data: results, error: null };
          },
          async order(field, opts) {
            return { data: Array.from(store.values()), error: null };
          },
          async limit(n) {
            return { data: Array.from(store.values()).slice(0, n), error: null };
          },
          async insert(row) {
            store.set(row.code || row.id, row);
            return { data: [row], error: null };
          },
          async update(patch) {
            return {
              eq(key, value) {
                return {
                  async select(fields) {
                    for (const item of store.values()) {
                      if (item[key] === value) {
                        Object.assign(item, patch);
                        return { data: [item], error: null };
                      }
                    }
                    return { data: [], error: null };
                  }
                };
              }
            };
          },
          async delete() {
            return {
              eq(key, value) {
                for (const [k, item] of store.entries()) {
                  if (item[key] === value) store.delete(k);
                }
                return { data: [], error: null };
              }
            };
          }
        };
      }
    };
  }
};

class BackendError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const handle = application({ db, BackendError });

export default async function handler(req, res) {
  try {
    const context = {
      request: new Request(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.method !== 'GET' && req.method !== 'HEAD' ? JSON.stringify(req.body) : undefined
      }),
      requestId: Math.random().toString(36).slice(2)
    };
    const response = await handle(context);
    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));
    const text = await response.text();
    res.send(text);
  } catch (error) {
    res.status(error.status || 500).json({ error: { code: error.code || 'internal_error' } });
  }
}
