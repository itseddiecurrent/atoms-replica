import { getDataEnv } from "../env.js";
import { createStorageAdmin, ensurePrivateBucket } from "../storage.js";

const env = getDataEnv();
const storage = createStorageAdmin(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

await ensurePrivateBucket(storage, env.SUPABASE_STORAGE_BUCKET);
console.info(`Private storage bucket is ready: ${env.SUPABASE_STORAGE_BUCKET}`);
