# FingerTips: Devpost write-up

## Inspiration

Have you ever tried to make a phone call without speaking? Or sat through a meeting where
everyone could hear except you? Or tried to learn something from a video where half the
instructions were only ever said out loud, never shown?

We kept running into the same question: why does getting through an ordinary day still depend
so much on hearing and speaking?

The numbers are hard to ignore. 1.5 billion people live with hearing loss. Only about 1 in 20
Deaf or hard-of-hearing people can get things done over the phone, and most end up asking a
family member to call for them. Employment for Deaf adults sits more than 15 points below
hearing adults. None of these are separate problems. They're the same assumption, that everyone
can hear, showing up in different places.

So we built FingerTips. Not one more app, but one connected set of tools for the moments where
sound gets in the way: calling, meeting, learning and just having fun.

We also had 36 hours and access to some very capable AI models, which felt like the right time
to find out how far that could go.

## What it does

FingerTips makes communication and learning work without needing to hear or speak.

**Call: sign during a real phone call.** You sign to your camera. FingerTips recognises the signs,
turns them into a natural sentence, and once you approve it, speaks it in a human-sounding voice
on an actual phone call through Twilio. The other person just answers their phone. Their replies
come back to you as live captions. The AI never commits you to anything you didn't sign: money,
bookings and times always need your tap.

**Meet: captions for your hands.** Meetings already caption voices. Our Chrome extension adds the
other half. You sign or type in Google Meet or Zoom, and your approved sentence is drawn into your
own camera tile so everyone can read it, with an optional voice saying it out loud too.

**Learn: videos that teach everyone.** Upload an ordinary training video of someone doing a
hands-on job. Gemini watches and listens to it, then turns it into a lesson: every step separated
out, played on a loop at your speed, captioned with what the hands are doing, and placed on a map
of the workspace. You can type questions about the task. It's not just what someone said. It's
what actually happened.

**Play: music you can see.** Your gestures become sound and visuals. Move your hand to pick a
note, pinch to play it, and watch the music draw itself on screen.

## How we built it

**Google Gemini** does the heavy lifting on understanding. For Learn, it reads video and audio
together, gives every step a start and end time, places it in the frame with coordinates, and
returns all of it as structured data we can build a lesson from. Watching it pull clean,
timestamped steps out of a shaky phone video was one of those moments where we stopped and just
looked at the screen. On calls, Gemini turns a handful of signs plus what the caller just asked
into one natural sentence.

**Grok Voice** speaks for the signer on calls. It works natively in phone audio, handles being
interrupted the way a person would, and can be told to say approved sentences word for word, which
matters a lot when the sentence contains a price or a time.

**MediaPipe** tracks hands and body in the browser, so the camera never leaves the phone. Only
the points do. We built recognition around movement over time, one sign per pause, rather than
treating a single hand shape as a word. A SignBart model exported to ONNX classifies each sign in
about 30 milliseconds.

**Twilio** connects everything to real phone numbers, and **Vultr** hosts the FastAPI service that
orchestrates the whole call. **ElevenLabs** gave us a second natural voice option. The rest is
**React, TypeScript, Python, FastAPI, OpenCV, FFmpeg and Docker**.

The hard part wasn't choosing powerful models. It was getting them to work together quickly
enough that the person using it never feels like they're watching a loading screen.

## Challenges we ran into

Sign language isn't a set of static hand shapes. It's a full language with movement, grammar,
timing and facial expression. Early on, our webcam ran at a few frames per second and cut signs
into pieces the model couldn't read. We had to rethink how we split signs and swap in lighter
tracking models before it held up.

Real-time voice adds latency at every step: recognition, the language model, speech, the phone
network. We spent a lot of time making sure the other person on the call never hears dead air,
using short, honest fillers while the signer is replying.

Then there were browser camera permissions, phone audio formats, streaming, and keeping the
annotations in Learn lined up with the exact frames of the source video. At one point, fixing
one thing broke three others.

And yes, sleep deprivation became a dependency.

## Accomplishments that we're proud of

We didn't want to build another chatbot with a nice landing page. We wanted AI to do something
that actually matters to someone.

We're proud that sign-based calling, meeting captions, accessible learning and music all live in
one connected platform, and that the rules protecting the user are enforced in code, not just
promised. Nothing is spoken that the signer didn't approve.

We're especially proud of Learn. It takes ideas from industrial process analysis and applies them
to accessible education, so an ordinary video becomes something you can step through, inspect,
understand and actually learn from.

And the moment the separate pieces started talking to each other was the moment it stopped
feeling like a hackathon project and started feeling real.

## What we learned

The best AI isn't always the newest model. It's the right model for the problem.

Gemini showed us how much better understanding gets when video, audio and time are handled
together. Grok showed us that a voice that can be interrupted feels far more human than one that
just sounds nice. Building for real-time taught us that 200 milliseconds can matter more than
another feature.

And building for accessibility taught us something bigger: people shouldn't have to adapt to
technology. Technology should adapt to people.

We also learned how much debugging fits between 2 AM and sunrise.

## What's next for FingerTips

We want FingerTips to be something people use every day, not just a hackathon prototype.

Next up: more reliable continuous sign recognition beyond our current 50 everyday signs, faster
calls, deeper meeting integrations, and richer video understanding in Learn.

The idea we're most excited about is real-world guidance. Learn a physical skill from any ordinary
video, then point your phone at your own workspace and get feedback you can see, step by step.

For now, we're a small team trying to make the world a little easier to get through.

36 hours. Too many APIs. Not enough sleep. One big idea. And we're just getting started.
