/**
 * Shared guard for the disposable local recording database. Preparation and
 * provisioning both call this before opening any connection, so the public
 * synthetic demo password can never be written into an ordinary, shared or
 * remote database by accident.
 */

export const LOCAL_RECORDING_MARKER = "relay-video-recording";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "postgres", "::1"]);

export interface LocalDatabaseEvidence {
  databaseUrl: string | undefined;
  marker: string | undefined;
}

/** Returns the verified database name or throws with the reason it refused. */
export function assertRecordingDatabase(input: LocalDatabaseEvidence): string {
  if (!input.databaseUrl)
    throw new Error(
      "DATABASE_URL must point at the dedicated local recording database",
    );
  let parsed: URL;
  try {
    parsed = new URL(input.databaseUrl);
  } catch {
    throw new Error("DATABASE_URL is not a valid connection URL");
  }
  const database = parsed.pathname.replace(/^\//, "");
  if (!database.endsWith("_video_recording"))
    throw new Error(
      `Refusing local writes: database "${database}" does not end with _video_recording`,
    );
  if (!LOCAL_HOSTS.has(parsed.hostname))
    throw new Error(
      `Refusing local writes: host ${parsed.hostname} is not a local database`,
    );
  if (input.marker !== LOCAL_RECORDING_MARKER)
    throw new Error(
      `Refusing local writes: VIDEO_LOCAL_DATABASE_MARKER must be ${LOCAL_RECORDING_MARKER}`,
    );
  return database;
}
