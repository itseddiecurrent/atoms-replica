import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export function createStorageAdmin(url: string, serviceRoleKey: string): SupabaseClient {
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

export async function ensurePrivateBucket(client: SupabaseClient, bucketName: string) {
  const { data: bucket, error: getError } = await client.storage.getBucket(bucketName);

  if (bucket) {
    if (bucket.public) {
      const { error } = await client.storage.updateBucket(bucketName, { public: false });
      if (error) throw error;
    }
    return bucketName;
  }

  if (getError && !/not found/i.test(getError.message)) throw getError;

  const { error } = await client.storage.createBucket(bucketName, {
    public: false,
    fileSizeLimit: 10 * 1024 * 1024
  });
  if (error) throw error;
  return bucketName;
}
