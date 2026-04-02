import { McpServer } from "npm:@modelcontextprotocol/sdk@1.24.3/server/mcp.js";
import { Hono } from "npm:hono@4.9.2";
import { z } from "npm:zod@3.23.8";
import postgres from "npm:postgres@3.4.5";
import { load } from "https://deno.land/std@0.224.0/dotenv/mod.ts";

// --- Load environment ---
const env = await load({ envPath: ".env" });
const get = (k: string) => env[k] || Deno.env.get(k) || "";

const DATABASE_URL = get("DATABASE_URL");
const OLLAMA_URL = get("OLLAMA_URL") || "http://localhost:11434";
const EMBEDDING_MODEL = get("EMBEDDING_MODEL") || "mxbai-embed-large";
const METADATA_MODEL = get("METADATA_MODEL") || "phi3:mini";
const MCP_ACCESS_KEY = get("MCP_ACCESS_KEY");
const MCP_PORT = parseInt(get("MCP_PORT") || "3333");

if (!DATABASE_URL) throw new Error("DATABASE_URL is required in .env");
if (!MCP_ACCESS_KEY) throw new Error("MCP_ACCESS_KEY is required in .env");

// --- Database ---
const sql = postgres(DATABASE_URL);

// --- Ollama helpers ---
async function getEmbedding(text: string): Promise<number[]> {
  const r = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
  });
  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    throw new Error(`Ollama embedding failed: ${r.status} ${msg}`);
  }
  const d = await r.json();
  return d.embeddings[0];
}

// --- Metadata validation ---
const VALID_TYPES = new Set(["observation", "task", "idea", "reference", "person_note"]);

function validateMetadata(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    type: VALID_TYPES.has(raw.type as string) ? raw.type : "observation",
    topics: (() => {
      if (Array.isArray(raw.topics) && raw.topics.length > 0) {
        const valid = raw.topics.filter((t): t is string => typeof t === "string" && t.trim().length > 0).slice(0, 5);
        return valid.length > 0 ? valid : ["uncategorized"];
      }
      return ["uncategorized"];
    })(),
    people: Array.isArray(raw.people)
      ? raw.people.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
      : [],
    action_items: Array.isArray(raw.action_items)
      ? raw.action_items.filter((a): a is string => typeof a === "string" && a.trim().length > 0)
      : [],
    dates_mentioned: Array.isArray(raw.dates_mentioned)
      ? raw.dates_mentioned.filter((d): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d))
      : [],
  };
}

async function extractMetadata(text: string): Promise<Record<string, unknown>> {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: METADATA_MODEL,
        stream: false,
        format: "json",
        messages: [
          {
            role: "system",
            content: `Extract metadata from the user's captured thought. Return JSON with:
- "people": array of people mentioned (empty array if none)
- "action_items": array of implied to-dos (empty array if none)
- "dates_mentioned": array of dates YYYY-MM-DD (empty array if none)
- "topics": array of 1-3 short topic tags (always at least one)
- "type": one of "observation", "task", "idea", "reference", "person_note"
Return ONLY valid JSON. No extra text.`,
          },
          { role: "user", content: text },
        ],
      }),
    });
    const d = await r.json();
    const parsed = JSON.parse(d.message.content);
    return validateMetadata(parsed);
  } catch {
    return { topics: ["uncategorized"], type: "observation", people: [], action_items: [], dates_mentioned: [] };
  }
}

// --- Fingerprint helper ---
async function fingerprint(text: string): Promise<string> {
  const normalized = text.toLowerCase().trim().replace(/\s+/g, " ");
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// =====================================================================
// MCP Server — 6 Tools
// =====================================================================

const server = new McpServer({ name: "ob2d2", version: "1.1.0-local" });

// Tool 1: Semantic Search
server.registerTool(
  "search_thoughts",
  {
    title: "Search Thoughts",
    description: "Search captured thoughts by meaning.",
    inputSchema: {
      query: z.string().describe("What to search for"),
      limit: z.number().optional().default(10),
      threshold: z.number().optional().default(0.5),
    },
  },
  async ({ query, limit, threshold }) => {
    try {
      const qEmb = await getEmbedding(query);
      const vecStr = `[${qEmb.join(",")}]`;
      const rows = await sql`
        SELECT id, content, metadata,
               (1 - (embedding <=> ${vecStr}::vector)) AS similarity,
               created_at
        FROM thoughts
        WHERE 1 - (embedding <=> ${vecStr}::vector) > ${threshold}
        ORDER BY embedding <=> ${vecStr}::vector
        LIMIT ${limit}
      `;

      if (rows.length === 0) {
        return { content: [{ type: "text" as const, text: `No thoughts found matching "${query}".` }] };
      }

      const results = rows.map((t, i) => {
        const m = (t.metadata || {}) as Record<string, unknown>;
        const parts = [
          `--- Result ${i + 1} (${(Number(t.similarity) * 100).toFixed(1)}% match) ---`,
          `ID: ${t.id}`,
          `Captured: ${new Date(t.created_at).toLocaleDateString()}`,
          `Type: ${m.type || "unknown"}`,
        ];
        if (Array.isArray(m.topics) && m.topics.length) parts.push(`Topics: ${(m.topics as string[]).join(", ")}`);
        if (Array.isArray(m.people) && m.people.length) parts.push(`People: ${(m.people as string[]).join(", ")}`);
        if (Array.isArray(m.action_items) && m.action_items.length) parts.push(`Actions: ${(m.action_items as string[]).join("; ")}`);
        parts.push(`\n${t.content}`);
        return parts.join("\n");
      });

      return { content: [{ type: "text" as const, text: `Found ${rows.length} thought(s):\n\n${results.join("\n\n")}` }] };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

// Tool 2: List Recent
server.registerTool(
  "list_thoughts",
  {
    title: "List Recent Thoughts",
    description: "List recently captured thoughts with optional filters.",
    inputSchema: {
      limit: z.number().optional().default(10),
      type: z.string().optional().describe("Filter by type"),
      topic: z.string().optional().describe("Filter by topic tag"),
      person: z.string().optional().describe("Filter by person"),
      days: z.number().optional().describe("Only thoughts from last N days"),
    },
  },
  async ({ limit, type, topic, person, days }) => {
    try {
      let query = `SELECT id, content, metadata, created_at FROM thoughts WHERE 1=1`;
      const params: unknown[] = [];
      let idx = 0;

      if (type) { idx++; query += ` AND metadata->>'type' = $${idx}`; params.push(type); }
      if (topic) { idx++; query += ` AND metadata->'topics' ? $${idx}`; params.push(topic); }
      if (person) { idx++; query += ` AND metadata->'people' ? $${idx}`; params.push(person); }
      if (days) {
        idx++;
        const since = new Date();
        since.setDate(since.getDate() - days);
        query += ` AND created_at >= $${idx}`;
        params.push(since.toISOString());
      }
      idx++;
      query += ` ORDER BY created_at DESC LIMIT $${idx}`;
      params.push(limit);

      const rows = await sql.unsafe(query, params as never[]);

      if (rows.length === 0) {
        return { content: [{ type: "text" as const, text: "No thoughts found." }] };
      }

      const results = rows.map((t, i) => {
        const m = (t.metadata || {}) as Record<string, unknown>;
        const tags = Array.isArray(m.topics) ? (m.topics as string[]).join(", ") : "";
        return `${i + 1}. [${new Date(t.created_at).toLocaleDateString()}] (${m.type || "??"}${tags ? " - " + tags : ""}) ID: ${t.id}\n   ${t.content}`;
      });

      return { content: [{ type: "text" as const, text: `${rows.length} recent thought(s):\n\n${results.join("\n\n")}` }] };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

// Tool 3: Stats (SQL-based)
server.registerTool(
  "thought_stats",
  {
    title: "Thought Statistics",
    description: "Get a summary of all captured thoughts.",
    inputSchema: {},
  },
  async () => {
    try {
      const [result] = await sql`SELECT thought_stats_summary() AS stats`;
      const s = result.stats as {
        total: number; earliest: string | null; latest: string | null;
        types: Record<string, number>; topics: Record<string, number>; people: Record<string, number>;
      };

      const lines: string[] = [
        `Total thoughts: ${s.total}`,
        `Date range: ${s.earliest ? new Date(s.earliest).toLocaleDateString() + " → " + new Date(s.latest!).toLocaleDateString() : "N/A"}`,
        "", "Types:",
        ...Object.entries(s.types).map(([k, v]) => `  ${k}: ${v}`),
      ];
      if (Object.keys(s.topics).length) {
        lines.push("", "Top topics:");
        for (const [k, v] of Object.entries(s.topics)) lines.push(`  ${k}: ${v}`);
      }
      if (Object.keys(s.people).length) {
        lines.push("", "People mentioned:");
        for (const [k, v] of Object.entries(s.people)) lines.push(`  ${k}: ${v}`);
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

// Tool 4: Capture Thought
server.registerTool(
  "capture_thought",
  {
    title: "Capture Thought",
    description: "Save a new thought. Generates embedding and extracts metadata automatically.",
    inputSchema: {
      content: z.string().describe("The thought to capture"),
    },
  },
  async ({ content }) => {
    try {
      const [embedding, metadata] = await Promise.all([
        getEmbedding(content),
        extractMetadata(content),
      ]);

      const fp = await fingerprint(content);
      const meta = { ...metadata, source: "mcp" };
      const vecStr = `[${embedding.join(",")}]`;

      const [row] = await sql`
        INSERT INTO thoughts (content, content_fingerprint, metadata, embedding)
        VALUES (${content}, ${fp}, ${sql.json(meta)}, ${vecStr}::vector)
        ON CONFLICT (content_fingerprint) WHERE content_fingerprint IS NOT NULL DO UPDATE
        SET updated_at = now(), metadata = thoughts.metadata || EXCLUDED.metadata
        RETURNING id
      `;

      let confirmation = `Captured as ${meta.type || "thought"}`;
      if (Array.isArray(meta.topics) && meta.topics.length) confirmation += ` — ${(meta.topics as string[]).join(", ")}`;
      if (Array.isArray(meta.people) && meta.people.length) confirmation += ` | People: ${(meta.people as string[]).join(", ")}`;
      if (Array.isArray(meta.action_items) && meta.action_items.length) confirmation += ` | Actions: ${(meta.action_items as string[]).join("; ")}`;
      confirmation += ` | ID: ${row.id}`;

      return { content: [{ type: "text" as const, text: confirmation }] };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

// Tool 5: Update Thought
server.registerTool(
  "update_thought",
  {
    title: "Update Thought",
    description: "Update content or metadata of an existing thought.",
    inputSchema: {
      id: z.string().uuid().describe("The thought's UUID"),
      content: z.string().optional().describe("New content (re-embeds if changed)"),
      metadata_patch: z.record(z.unknown()).optional().describe("Metadata fields to merge"),
    },
  },
  async ({ id, content, metadata_patch }) => {
    try {
      if (!content && !metadata_patch) {
        return { content: [{ type: "text" as const, text: "Nothing to update." }] };
      }

      if (content) {
        const emb = await getEmbedding(content);
        const fp = await fingerprint(content);
        const vecStr = `[${emb.join(",")}]`;
        await sql`UPDATE thoughts SET content = ${content}, embedding = ${vecStr}::vector, content_fingerprint = ${fp} WHERE id = ${id}::uuid`;
      }

      if (metadata_patch) {
        const [existing] = await sql`SELECT metadata FROM thoughts WHERE id = ${id}::uuid`;
        if (!existing) return { content: [{ type: "text" as const, text: `Thought not found.` }], isError: true };
        const merged = { ...(existing.metadata || {}), ...metadata_patch };
        await sql`UPDATE thoughts SET metadata = ${sql.json(merged)} WHERE id = ${id}::uuid`;
      }

      return { content: [{ type: "text" as const, text: `Thought ${id} updated.` }] };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

// Tool 6: Delete Thought
server.registerTool(
  "delete_thought",
  {
    title: "Delete Thought",
    description: "Permanently delete a thought by ID.",
    inputSchema: {
      id: z.string().uuid().describe("The thought's UUID"),
    },
  },
  async ({ id }) => {
    try {
      const result = await sql`DELETE FROM thoughts WHERE id = ${id}::uuid`;
      if (result.count === 0) {
        return { content: [{ type: "text" as const, text: `No thought found with ID ${id}.` }] };
      }
      return { content: [{ type: "text" as const, text: `Thought ${id} permanently deleted.` }] };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

// =====================================================================
// HTTP Server — Hono
// =====================================================================

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  entry.count++;
  return entry.count <= 120;
}

const app = new Hono();

// Health endpoint (no auth)
app.get("/health", async (c) => {
  try {
    const [{ count }] = await sql`SELECT count(*) FROM thoughts`;
    let ollamaOk = false;
    try { const r = await fetch(`${OLLAMA_URL}/api/tags`); ollamaOk = r.ok; } catch { /* */ }

    return c.json({
      status: ollamaOk ? "healthy" : "degraded",
      db: "connected",
      thoughts_count: Number(count),
      ollama: ollamaOk ? "connected" : "unreachable",
      models: { embedding: EMBEDDING_MODEL, metadata: METADATA_MODEL },
      version: "1.1.0-local",
      timestamp: new Date().toISOString(),
    });
  } catch (err: unknown) {
    return c.json({ status: "down", error: (err as Error).message }, 503);
  }
});

// MCP handler (with auth + rate limiting)
app.all("*", async (c) => {
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!checkRateLimit(ip)) return c.json({ error: "Rate limit exceeded" }, 429);

  const provided = c.req.header("x-brain-key") || new URL(c.req.url).searchParams.get("key");
  if (!provided || provided !== MCP_ACCESS_KEY) {
    return c.json({ error: "Invalid or missing access key" }, 401);
  }

  // Patch Accept header for Claude Desktop compatibility
  if (!c.req.header("accept")?.includes("text/event-stream")) {
    const headers = new Headers(c.req.raw.headers);
    headers.set("Accept", "application/json, text/event-stream");
    const patched = new Request(c.req.raw.url, {
      method: c.req.raw.method, headers,
      body: c.req.raw.body,
      // @ts-ignore
      duplex: "half",
    });
    Object.defineProperty(c.req, "raw", { value: patched, writable: true });
  }

  const { StreamableHTTPTransport } = await import("npm:@hono/mcp@0.1.1");
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

console.log(`OB2D2 MCP server starting on port ${MCP_PORT}...`);
console.log(`  Database: ${DATABASE_URL.replace(/\/\/.*@/, "//***@")}`);
console.log(`  Ollama:   ${OLLAMA_URL}`);
console.log(`  Models:   ${EMBEDDING_MODEL} (embed), ${METADATA_MODEL} (metadata)`);
console.log(`  Health:   http://localhost:${MCP_PORT}/health`);

Deno.serve({ port: MCP_PORT }, app.fetch);
