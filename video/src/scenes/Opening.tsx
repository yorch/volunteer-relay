import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type { Scene } from "../lib/schema.ts";
import { theme, typography } from "../theme.ts";

/**
 * S01 is a clearly labelled illustrative story, not a recording of any chat
 * provider. Messages are fictional; nothing here claims product behaviour.
 */
const messages = [
  {
    from: "Sofia",
    text: "Mentored Mateo for an hour after school today.",
    at: 1.2,
    urgent: false,
  },
  {
    from: "Sofia",
    text: "His family is out of diapers and needs some tonight.",
    at: 3.4,
    urgent: true,
  },
  {
    from: "Dana",
    text: "Van keys are back on the hook.",
    at: 9.4,
    urgent: false,
  },
  {
    from: "Luis",
    text: "Two crates of fruit left at the pantry.",
    at: 10.2,
    urgent: false,
  },
  {
    from: "Amara",
    text: "Can someone cover Thursday pickup?",
    at: 10.9,
    urgent: false,
  },
  {
    from: "Tom",
    text: "Photos from the garden day are uploaded.",
    at: 11.6,
    urgent: false,
  },
];

export function Opening({ scene }: { scene: Scene }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const seconds = frame / fps;
  const visible = messages.filter((message) => seconds >= message.at);
  const buried = seconds >= 9.4;
  const urgentShift = buried ? 0.45 : 1;
  return (
    <AbsoluteFill
      style={{
        background: theme.background,
        color: theme.ink,
        fontFamily: typography.body,
      }}
    >
      <AbsoluteFill
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 110px",
        }}
      >
        <div style={{ width: 660 }}>
          <div
            style={{
              fontFamily: typography.display,
              fontSize: 24,
              letterSpacing: 3,
              textTransform: "uppercase",
              color: theme.teal,
              marginBottom: 22,
            }}
          >
            Illustrative story
          </div>
          <div
            style={{
              fontFamily: typography.display,
              fontSize: 66,
              fontWeight: 800,
              lineHeight: 1.08,
              letterSpacing: -1,
            }}
          >
            One hour of work.
            <br />
            One message.
          </div>
          <div
            style={{
              marginTop: 26,
              fontSize: 30,
              lineHeight: 1.45,
              color: theme.inkSoft,
              maxWidth: 560,
            }}
          >
            Program coordinators rebuild the week from chats, texts and photos.
            What is urgent and what was counted look exactly the same: a
            message.
          </div>
        </div>
        <ChatPanel
          visibleCount={visible.length}
          messages={messages}
          buried={buried}
          urgentOpacity={urgentShift}
        />
      </AbsoluteFill>
      {buried ? <BuriedNotice frame={frame} fps={fps} /> : null}
      <div
        style={{
          position: "absolute",
          bottom: 30,
          left: 40,
          fontSize: 20,
          color: theme.inkSoft,
          letterSpacing: 0.4,
        }}
      >
        {scene.onScreenDisclosure}
      </div>
    </AbsoluteFill>
  );
}

function ChatPanel({
  messages: list,
  visibleCount,
  buried,
  urgentOpacity,
}: {
  messages: typeof messages;
  visibleCount: number;
  buried: boolean;
  urgentOpacity: number;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <div
      style={{
        width: 660,
        height: 700,
        background: theme.surface,
        border: `2px solid ${theme.line}`,
        borderRadius: 26,
        padding: "22px 24px",
        display: "flex",
        flexDirection: "column",
        justifyContent: "flex-end",
        gap: 14,
        overflow: "hidden",
        boxShadow: "0 24px 60px rgba(23, 56, 47, 0.12)",
      }}
    >
      <div
        style={{
          fontSize: 20,
          letterSpacing: 1.4,
          textTransform: "uppercase",
          color: theme.inkSoft,
          marginBottom: "auto",
        }}
      >
        Volunteer group chat
      </div>
      {list.slice(0, visibleCount).map((message) => {
        const enter = spring({
          frame: frame - Math.round(message.at * fps),
          fps,
          config: { damping: 200, mass: 0.6 },
        });
        const faded = message.urgent && buried;
        return (
          <div
            key={`${message.from}-${message.at}`}
            style={{
              opacity: enter * (faded ? urgentOpacity : 1),
              transform: `translateY(${(1 - enter) * 16}px)`,
              alignSelf: message.from === "Sofia" ? "flex-end" : "flex-start",
              background: message.urgent ? theme.urgentWash : theme.tealWash,
              border: `2px solid ${message.urgent ? theme.urgent : theme.line}`,
              borderRadius: 16,
              padding: "12px 16px",
              maxWidth: 470,
              fontSize: 24,
              lineHeight: 1.35,
              color: message.urgent ? theme.urgent : theme.ink,
            }}
          >
            <div style={{ fontSize: 17, letterSpacing: 1, opacity: 0.75 }}>
              {message.from}
            </div>
            {message.text}
          </div>
        );
      })}
    </div>
  );
}

function BuriedNotice({ frame, fps }: { frame: number; fps: number }) {
  const opacity = interpolate(frame / fps, [9.6, 10.6], [0, 1], {
    extrapolateRight: "clamp",
  });
  return (
    <div
      style={{
        position: "absolute",
        bottom: 92,
        left: 110,
        opacity,
        display: "flex",
        gap: 14,
        alignItems: "center",
      }}
    >
      <div
        style={{
          background: theme.tealDeep,
          color: theme.captionText,
          borderRadius: 999,
          padding: "10px 20px",
          fontSize: 24,
          letterSpacing: 0.4,
        }}
      >
        1 hour mentored · not yet counted
      </div>
      <div
        style={{
          background: theme.urgentWash,
          color: theme.urgent,
          border: `2px solid ${theme.urgent}`,
          borderRadius: 999,
          padding: "10px 20px",
          fontSize: 24,
          letterSpacing: 0.4,
        }}
      >
        Urgent need · not yet owned
      </div>
    </div>
  );
}
