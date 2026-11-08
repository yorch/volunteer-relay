import { describe, expect, it } from "vitest";
import { assertRecordingDatabase, LOCAL_RECORDING_MARKER } from "./db-guard.ts";

const marker = LOCAL_RECORDING_MARKER;
const valid = "postgres://relay:relay@127.0.0.1:55480/relay_video_recording";

describe("local recording database guard", () => {
  it("accepts the disposable recording database", () => {
    expect(assertRecordingDatabase({ databaseUrl: valid, marker })).toBe(
      "relay_video_recording",
    );
  });

  it("refuses an ordinary database name", () => {
    expect(() =>
      assertRecordingDatabase({
        databaseUrl: "postgres://relay:relay@127.0.0.1:55480/relay",
        marker,
      }),
    ).toThrow(/_video_recording/);
  });

  it("refuses a remote host even with the right name", () => {
    expect(() =>
      assertRecordingDatabase({
        databaseUrl:
          "postgres://relay:relay@db.example.com/relay_video_recording",
        marker,
      }),
    ).toThrow(/not a local database/);
  });

  it("refuses a missing or mismatched marker", () => {
    expect(() =>
      assertRecordingDatabase({ databaseUrl: valid, marker: undefined }),
    ).toThrow(/VIDEO_LOCAL_DATABASE_MARKER/);
    expect(() =>
      assertRecordingDatabase({ databaseUrl: valid, marker: "something-else" }),
    ).toThrow(/VIDEO_LOCAL_DATABASE_MARKER/);
  });

  it("refuses a missing or unparsable URL", () => {
    expect(() =>
      assertRecordingDatabase({ databaseUrl: undefined, marker }),
    ).toThrow(/DATABASE_URL/);
    expect(() =>
      assertRecordingDatabase({ databaseUrl: "not a url", marker }),
    ).toThrow(/not a valid connection URL/);
  });
});
