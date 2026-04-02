# Embedding Model Migration Guide

When you switch embedding models (e.g., from `openai/text-embedding-3-small` to a different model via OpenRouter), the vector dimensions may change. This guide walks you through the full migration.

> **CAUTION:** This is a breaking change. Once you alter the vector column dimension, all existing embeddings become incompatible with the new model. You must re-embed every row. Do not start this process unless you're prepared to complete it in one session.

---

## Before You Start

1. **Check the new model's output dimensions.** Find this on [openrouter.ai/models](https://openrouter.ai/models) or the model provider's docs.
2. **Count your existing thoughts.** Run this in the Supabase SQL Editor:

   ```sql
   SELECT count(*) FROM thoughts WHERE embedding IS NOT NULL;
   ```

3. **Estimate the cost.** At ~$0.02 per million tokens (for OpenAI's models), 10K thoughts averaging 50 tokens each = 500K tokens ≈ $0.01. Even 100K thoughts is under $1.

4. **Back up your database.** Supabase dashboard → Settings → Database → Download backup.

---

## Step-by-Step Migration

### Step 1: Update the Edge Function Configuration

In `server/index.ts`, change the model constant at the top of the file:

```typescript
const EMBEDDING_MODEL = "your-new-model-here";
```

**Do not deploy yet.** The database column needs to match first.

### Step 2: Drop the HNSW Index

```sql
SELECT indexname FROM pg_indexes
WHERE tablename = 'thoughts' AND indexdef LIKE '%hnsw%';

-- Drop it (replace with actual name from above)
DROP INDEX IF EXISTS thoughts_embedding_idx;
```

### Step 3: Alter the Vector Column

Replace `NEW_DIM` with your new model's output dimensions:

```sql
ALTER TABLE thoughts ALTER COLUMN embedding TYPE vector(NEW_DIM);
```

### Step 4: Null Out Existing Embeddings

```sql
UPDATE thoughts SET embedding = NULL;
```

### Step 5: Re-embed All Rows

```typescript
// re-embed.ts — run with: deno run --allow-net --allow-env re-embed.ts

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const EMBEDDING_MODEL = "your-new-model-here";
const BATCH_SIZE = 50;
const DELAY_MS = 1000;

import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function getEmbedding(text: string): Promise<number[]> {
  const r = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
  });
  if (!r.ok) throw new Error(`Embedding failed: ${r.status} ${await r.text()}`);
  const d = await r.json();
  return d.data[0].embedding;
}

async function main() {
  const { count } = await supabase
    .from("thoughts")
    .select("*", { count: "exact", head: true })
    .is("embedding", null);

  console.log(`${count} thoughts to re-embed.`);
  let processed = 0;

  while (true) {
    const { data, error } = await supabase
      .from("thoughts")
      .select("id, content")
      .is("embedding", null)
      .limit(BATCH_SIZE);

    if (error) { console.error(error); break; }
    if (!data || data.length === 0) break;

    for (const row of data) {
      try {
        const emb = await getEmbedding(row.content);
        const { error: upErr } = await supabase
          .from("thoughts")
          .update({ embedding: emb })
          .eq("id", row.id);
        if (upErr) console.error(`Failed ${row.id}: ${upErr.message}`);
        else processed++;
      } catch (e) {
        console.error(`Failed ${row.id}: ${(e as Error).message}`);
      }
    }

    console.log(`${processed} / ${count} done`);
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  console.log(`Migration complete. ${processed} thoughts re-embedded.`);
}

main();
```

### Step 6: Recreate the HNSW Index

```sql
CREATE INDEX ON thoughts USING hnsw (embedding vector_cosine_ops);
```

### Step 7: Update the Search Function

```sql
CREATE OR REPLACE FUNCTION match_thoughts(
  query_embedding vector(NEW_DIM),  -- ← change this
  match_threshold float default 0.7,
  match_count int default 10,
  filter jsonb default '{}'::jsonb
)
RETURNS table (
  id uuid, content text, metadata jsonb,
  similarity float, created_at timestamptz
)
LANGUAGE plpgsql AS $$
begin
  return query
  select t.id, t.content, t.metadata,
    1 - (t.embedding <=> query_embedding) as similarity,
    t.created_at
  from thoughts t
  where 1 - (t.embedding <=> query_embedding) > match_threshold
    and (filter = '{}'::jsonb or t.metadata @> filter)
  order by t.embedding <=> query_embedding
  limit match_count;
end;
$$;
```

### Step 8: Deploy and Verify

```bash
supabase functions deploy open-brain-mcp --no-verify-jwt
```

Capture a test thought and search for it.

---

## Common Models and Their Dimensions

| Model (OpenRouter ID) | Dimensions | Notes |
| --- | --- | --- |
| `openai/text-embedding-3-small` | 1536 | Current default |
| `openai/text-embedding-3-large` | 3072 | Higher quality, 2x dimensions |
| `cohere/embed-english-v3.0` | 1024 | Strong multilingual support |
| `google/text-embedding-004` | 768 | Compact, cost-effective |

## Rollback

1. Restore your database backup (Settings → Database → Restore).
2. Revert the `EMBEDDING_MODEL` constant in `index.ts`.
3. Redeploy the edge function.
