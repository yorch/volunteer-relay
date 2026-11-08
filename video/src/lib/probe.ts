import { spawnSync } from "node:child_process";

/**
 * Media probing and loudness measurement. Renders are only "ready" when the
 * measured file, not the requested settings, matches the delivery format.
 */

export interface MediaProbe {
  path: string;
  durationSeconds: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  hasAudio: boolean;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string };
}

function ratio(value: string | undefined): number | null {
  if (!value) return null;
  const [numerator, denominator] = value.split("/").map(Number);
  if (!numerator || denominator === undefined || Number.isNaN(denominator))
    return null;
  if (denominator === 0) return null;
  return numerator / denominator;
}

export function probeMedia(path: string): MediaProbe {
  const result = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      path,
    ],
    { encoding: "utf8" },
  );
  if (result.error)
    throw new Error(
      `ffprobe is required to validate media: ${result.error.message}`,
    );
  if (result.status !== 0)
    throw new Error(`ffprobe failed for ${path}: ${result.stderr.trim()}`);
  const parsed = JSON.parse(result.stdout) as FfprobeOutput;
  const video = parsed.streams?.find((s) => s.codec_type === "video");
  const audio = parsed.streams?.find((s) => s.codec_type === "audio");
  const duration = Number(parsed.format?.duration ?? Number.NaN);
  if (!Number.isFinite(duration) || duration <= 0)
    throw new Error(`ffprobe reported no duration for ${path}`);
  return {
    path,
    durationSeconds: duration,
    width: video?.width ?? null,
    height: video?.height ?? null,
    fps: ratio(video?.avg_frame_rate) ?? ratio(video?.r_frame_rate),
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    hasAudio: Boolean(audio),
  };
}

export interface LoudnessMeasurement {
  integratedLufs: number | null;
  truePeakDb: number | null;
}

/**
 * EBU R128 measurement from ffmpeg's ebur128 filter. Reports the summary block
 * ffmpeg prints at the end of a decode pass.
 */
export function measureLoudness(path: string): LoudnessMeasurement {
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostats",
      "-i",
      path,
      "-af",
      "ebur128=peak=true",
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8" },
  );
  if (result.error)
    throw new Error(
      `ffmpeg is required to measure loudness: ${result.error.message}`,
    );
  if (result.status !== 0)
    throw new Error(`ffmpeg loudness pass failed: ${result.stderr.trim()}`);
  const output = result.stderr;
  // ebur128 prints progressive summaries; the final "Summary:" block carries
  // the integrated value and true peak for the whole programme.
  const summaryAt = output.lastIndexOf("Summary:");
  const relevant = summaryAt === -1 ? output : output.slice(summaryAt);
  const integrated = /I:\s*(-?[\d.]+|-inf)\s*LUFS/i.exec(relevant);
  const peaks = [...relevant.matchAll(/Peak:\s*(-?[\d.]+|-inf)\s*dBFS/gi)];
  const lastPeak = peaks.at(-1);
  const number = (value: string | undefined): number | null => {
    if (value === undefined || /^-?inf$/i.test(value)) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  return {
    integratedLufs: number(integrated?.[1]),
    truePeakDb: number(lastPeak?.[1]),
  };
}

export function formatProbe(probe: MediaProbe): string {
  const size =
    probe.width && probe.height ? `${probe.width}x${probe.height}` : "unknown";
  return `${size} ${probe.durationSeconds.toFixed(2)}s fps=${probe.fps?.toFixed(3) ?? "?"} video=${probe.videoCodec ?? "?"} audio=${probe.audioCodec ?? "none"}`;
}
