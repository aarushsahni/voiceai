# Penn Medicine IVR Voice Web App

A browser-based real-time voice IVR (Interactive Voice Response) system for Penn Medicine Lancaster General Health Emergency Department follow-up calls. This web app uses OpenAI's Realtime API with WebRTC for live voice conversations directly in the browser.

## Features

- 🎙️ **Real-time voice conversation** - Talk naturally with the AI assistant
- 🔒 **Secure** - API key stays server-side via ephemeral tokens
- 📊 **Live transcript** - See the conversation as it happens
- 🔀 **Flow visualization** - Track progress through the IVR script
- ⚡ **Latency tracking** - Monitor response times
- 🌐 **Bilingual** - Supports English and Spanish

## Prerequisites

- Node.js 18+
- An OpenAI API key with access to the Realtime API
- Vercel CLI (for local development with HTTPS)

## Getting Started

### 1. Install dependencies

```bash
npm install
```

### 2. Set up environment variables

Create a `.env.local` file:

```bash
OPENAI_API_KEY=sk-...
```

### 3. Run locally with Vercel CLI

The Realtime API requires HTTPS for microphone access. Use Vercel CLI which handles this:

```bash
npx vercel dev
```

This will start the app at `https://localhost:3000` (or similar).

### 4. Alternative: Vite dev server (limited)

For UI development only (voice won't work without HTTPS):

```bash
npm run dev
```

## Deployment to Vercel

1. Push to GitHub
2. Import into Vercel
3. Add environment variable: `OPENAI_API_KEY`
4. Deploy!

The serverless function at `/api/session` creates ephemeral tokens, keeping your API key secure.

## How It Works

```
┌─────────────┐     ┌─────────────────┐     ┌──────────────────┐
│   Browser   │────▶│  Vercel API     │────▶│  OpenAI API      │
│   (React)   │     │  /api/session   │     │  (get ephemeral  │
│             │     │                 │     │   token)         │
└──────┬──────┘     └─────────────────┘     └──────────────────┘
       │
       │ WebRTC (audio)
       │
       ▼
┌──────────────────┐
│  OpenAI Realtime │
│  API (voice)     │
└──────────────────┘
```

1. Browser requests ephemeral token from `/api/session`
2. Server creates session with OpenAI (using API key)
3. Browser connects directly to OpenAI via WebRTC
4. Audio streams bidirectionally - your voice → OpenAI → AI voice back

## Project Structure

```
ivr-voice-web/
├── api/
│   └── session.ts          # Serverless function for ephemeral tokens
├── src/
│   ├── App.tsx             # Main application
│   ├── components/
│   │   ├── CallControls.tsx    # Start/end call UI
│   │   ├── FlowMap.tsx         # IVR flow visualization
│   │   ├── LatencyTracker.tsx  # Response time display
│   │   ├── StatusIndicator.tsx # Call status
│   │   └── Transcript.tsx      # Live conversation log
│   ├── hooks/
│   │   └── useRealtimeAudio.ts # WebRTC/audio handling
│   └── utils/
│       └── scripts.ts          # IVR script definitions
├── package.json
└── README.md
```

## IVR Script Flow

The default script follows this flow:

1. **Language Selection** - English or Español
2. **Identity Confirmation** - Verify correct patient
3. **General Status** - How are they feeling?
4. **Reason for Leaving** - Why did they leave the ER?
5. **Disposition** - Where did they go after?
6. **Closing** - Disclaimer and goodbye

## Browser Support

- ✅ Chrome (recommended)
- ✅ Firefox
- ✅ Edge
- ⚠️ Safari (may have audio issues)
- ❌ Mobile browsers (limited WebRTC support)

## Customization

### Changing the IVR script

Edit `api/session.ts` - the `getDefaultSystemPrompt()` function contains the full script.

### Adding new flow steps

Edit `src/utils/scripts.ts` - update `defaultFlowMap` with new steps.

### Changing the voice

Pass a different voice to `startCall()`. Options: `alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer`.

## Troubleshooting

### "Microphone access denied"
- Make sure you're using HTTPS (required for getUserMedia)
- Check browser permissions

### "Failed to create session"
- Verify your `OPENAI_API_KEY` is set correctly
- Check you have access to the Realtime API

### High latency
- Check your internet connection
- The Realtime API may have varying response times

## License

Internal use - Penn Medicine Lancaster General Health
